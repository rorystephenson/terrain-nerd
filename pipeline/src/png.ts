/**
 * Just enough PNG to read a skyways tile's alpha.
 *
 * Only alpha, because that is where kk7 puts the density. The palette in a
 * quantised tile is a quantiser's output, so its indices carry no order at all,
 * while alpha runs cleanly from 0 to 255 as the ramp goes transparent -> dark
 * green -> saturated blue.
 *
 * The service uses **two** encodings and does not say which you are getting:
 * about half the tiles come back 8-bit palette with a `tRNS` table, and the
 * busier half come back straight RGBA at five times the size — presumably
 * whenever quantisation would have lost too much. Both have to be read.
 *
 * Hand-rolled over `node:zlib` rather than pulling in a decoder, because this is
 * the easy end of the format — 8-bit, non-interlaced — and the pipeline has one
 * dependency in it. Anything outside that throws instead of being guessed at: a
 * decoder that quietly returns plausible noise would surface as a scoring bug a
 * long way from here.
 */
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PALETTE = 3;
const RGBA = 6;

/** Bytes per pixel, which is also how far back the filters look. */
const BYTES_PER_PIXEL: Record<number, number> = { [PALETTE]: 1, [RGBA]: 4 };

export type AlphaImage = {
  width: number;
  height: number;
  /** One byte per pixel, row-major from the top-left. */
  alpha: Uint8Array;
};

/**
 * Reverses one scanline's filter, in place.
 *
 * The filters are defined over the *reconstructed* bytes of the pixel to the
 * left and the row above, which is why this runs in order and why `line` is the
 * output buffer rather than a copy. "To the left" means `bpp` bytes back, not
 * one — the thing that differs between the two encodings we read.
 */
function unfilter(type: number, line: Uint8Array, above: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) line[i] = (line[i] + above[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + above[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = above[i];
        const c = i >= bpp ? above[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      return;
    default:
      throw new Error(`Unknown PNG filter ${type}`);
  }
}

/**
 * Decodes the per-pixel alpha of an 8-bit palette or RGBA PNG.
 *
 * The colours are dropped on the floor — see the note at the top of the file. A
 * palette entry with no `tRNS` byte is opaque, which is what the spec says and
 * what a tile's background index relies on.
 */
export function decodeAlpha(png: Buffer): AlphaImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG');
  }

  let width = 0;
  let height = 0;
  let colour = -1;
  let transparency: Buffer | null = null;
  const data: Buffer[] = [];

  let at = 8;
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const body = png.subarray(at + 8, at + 8 + length);

    if (type === 'IHDR') {
      width = png.readUInt32BE(at + 8);
      height = png.readUInt32BE(at + 12);
      const depth = png[at + 16];
      colour = png[at + 17];
      const interlace = png[at + 20];
      if (depth !== 8) throw new Error(`PNG bit depth ${depth}, expected 8`);
      if (!BYTES_PER_PIXEL[colour]) throw new Error(`PNG colour type ${colour} is not read here`);
      if (interlace !== 0) throw new Error('Interlaced PNG');
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body);
    } else if (type === 'IDAT') {
      data.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }

    at += 12 + length;
  }

  if (!width || !height) throw new Error('PNG has no IHDR');
  if (data.length === 0) throw new Error('PNG has no IDAT');

  const bpp = BYTES_PER_PIXEL[colour];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(data));
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(`PNG is short: ${raw.length} bytes of ${expected}`);
  }

  /*
   * Unfiltered first, then reduced to alpha. Two passes rather than one because
   * the filters were computed over these bytes: mapping as we go would feed the
   * output back into the next row's predictor.
   */
  const bytes = new Uint8Array(stride * height);
  const blank = new Uint8Array(stride);
  let read = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[read++];
    const line = bytes.subarray(row * stride, (row + 1) * stride);
    line.set(raw.subarray(read, read + stride));
    read += stride;
    unfilter(filter, line, row > 0 ? bytes.subarray((row - 1) * stride, row * stride) : blank, bpp);
  }

  const alpha = new Uint8Array(width * height);
  if (colour === RGBA) {
    for (let i = 0; i < alpha.length; i++) alpha[i] = bytes[i * 4 + 3];
  } else if (transparency) {
    for (let i = 0; i < alpha.length; i++) {
      const index = bytes[i];
      alpha[i] = index < transparency.length ? transparency[index] : 255;
    }
  } else {
    alpha.fill(255);
  }

  return { width, height, alpha };
}
