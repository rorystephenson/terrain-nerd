import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

import { decodeAlpha } from '../../../pipeline/src/png.ts';

/*
 * The decoder lives in the pipeline but is tested here, where the test runner is
 * — the same arrangement as `placeZoom.test.ts` and `stitch.test.ts`.
 *
 * Worth pinning properly because its failure mode is quiet. A filter reversed
 * wrongly still yields a well-formed image of plausible noise, and the only
 * place that would surface is a flight score that looks a bit off.
 *
 * Both encodings kk7 serves are exercised, because the filters read `bpp` bytes
 * back rather than one — the single difference between them, and exactly the
 * sort of thing that decodes to something believable when it is wrong.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  // The CRC is never checked by the decoder, so zeroes stand in for it here.
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
}

/**
 * Encodes raw samples with one filter applied to every row.
 *
 * Built here rather than checked in as fixtures, so every filter is exercised
 * over the same known pixels and a failure names which filter broke.
 */
function encode(
  width: number,
  height: number,
  samples: number[],
  colour: 3 | 6,
  filter: number,
  transparency?: number[],
): Buffer {
  const bpp = colour === 6 ? 4 : 1;
  const stride = width * bpp;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colour;
  ihdr[12] = 0;

  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(filter);
    for (let i = 0; i < stride; i++) {
      const here = samples[y * stride + i];
      const left = i >= bpp ? samples[y * stride + i - bpp] : 0;
      const above = y > 0 ? samples[(y - 1) * stride + i] : 0;
      const corner = i >= bpp && y > 0 ? samples[(y - 1) * stride + i - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = (left + above) >> 1;
      else if (filter === 4) {
        const p = left + above - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : corner;
      }
      raw.push((here - predictor) & 0xff);
    }
  }

  const chunks = [SIGNATURE, chunk('IHDR', ihdr)];
  if (colour === 3) {
    chunks.push(chunk('PLTE', Buffer.alloc(256 * 3)));
    if (transparency) chunks.push(chunk('tRNS', Buffer.from(transparency)));
  }
  chunks.push(chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const INDICES = [0, 1, 2, 3, 3, 2, 1, 0, 1, 3, 0, 2, 2, 0, 3, 1];
const ALPHA = [0, 40, 120, 255];
const EXPECTED = INDICES.map((i) => ALPHA[i]);

/** The same pixels as RGBA: arbitrary colours, alpha in the fourth byte. */
const RGBA_SAMPLES = INDICES.flatMap((i, n) => [n * 7, 255 - n * 3, n * 11, ALPHA[i]]);

for (const filter of [0, 1, 2, 3, 4]) {
  test(`palette, filter ${filter}, reconstructs the same pixels`, () => {
    const image = decodeAlpha(encode(4, 4, INDICES, 3, filter, ALPHA));
    assert.equal(image.width, 4);
    assert.equal(image.height, 4);
    assert.deepEqual([...image.alpha], EXPECTED);
  });

  test(`rgba, filter ${filter}, reconstructs the same alpha`, () => {
    const image = decodeAlpha(encode(4, 4, RGBA_SAMPLES, 6, filter));
    assert.equal(image.width, 4);
    assert.deepEqual([...image.alpha], EXPECTED);
  });
}

test('a palette entry past the end of tRNS is opaque', () => {
  // What the spec says, and what a tile's background index relies on.
  const image = decodeAlpha(encode(2, 1, [0, 5], 3, 0, [0, 10]));
  assert.deepEqual([...image.alpha], [0, 255]);
});

test('a palette with no tRNS at all is opaque throughout', () => {
  const image = decodeAlpha(encode(2, 1, [0, 5], 3, 0));
  assert.deepEqual([...image.alpha], [255, 255]);
});

test('an encoding we do not read is refused rather than guessed at', () => {
  // Greyscale. Reading it as a palette would produce a whole tile of plausible
  // nonsense, which is the one outcome nothing downstream could detect.
  const grey = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 1, 2]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodeAlpha(grey), /colour type 0/);
});

test('a truncated image is refused rather than half-decoded', () => {
  const short = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 3, 0, 0, 0])),
    chunk('tRNS', Buffer.from([0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodeAlpha(short), /short/);
});

test('anything that is not a PNG is refused', () => {
  assert.throws(() => decodeAlpha(Buffer.from('not a png at all')), /Not a PNG/);
});

test('the service placeholder decodes, so size is what rejects it', () => {
  /*
   * Past a layer's maxzoom kk7 answers with a 1x1 RGBA image rather than a 404,
   * and since RGBA is an encoding we read, the decoder is happy with it. The
   * guard therefore has to be its size, which `skyways.ts` checks from IHDR
   * before anything is written — a 1x1 cached under a real tile's name would be
   * a hole in the raster that no later run has any way to notice.
   */
  const placeholder = decodeAlpha(encode(1, 1, [0, 0, 0, 0], 6, 0));
  assert.equal(placeholder.width, 1);
  assert.equal(placeholder.height, 1);
});
