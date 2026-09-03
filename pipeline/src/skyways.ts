/**
 * Where people actually fly, as a raster we can ask questions of.
 *
 * thermal.kk7.ch's skyways layer is every logged XC flight drawn on top of every
 * other one, so it is a direct record of the ground pilots pass over — which is
 * the thing the old popularity score had no signal for at all. It knew where you
 * *could* launch, from OSM, and nothing about where anyone goes.
 *
 * Facts about the service, measured rather than assumed:
 *
 * - Served **TMS**, so the row counts from the south: `yTms = 2**z - 1 - y`.
 *   Getting this wrong does not fail loudly; it quietly returns placeholders.
 * - Past a layer's maxzoom the server answers with a **1x1 placeholder**, not a
 *   404, so a tile that is not 256x256 must be rejected and never cached.
 * - The density is in the alpha, not the colours, and tiles arrive in two
 *   encodings without being labelled as either. See `png.ts`.
 * - CC BY-NC-SA 4.0, and `src` is required on every request.
 *
 * Zoom 11 was chosen by measuring headroom before the ramp clips, on the same
 * ground at four zooms: z10 saturates 7.5% of its ink and z13 5.5%, where z11
 * saturates 0.4% — and z11 is a quarter the tiles of z12.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Coverage } from './coverage.ts';
import type { LonLat } from './geo.ts';
import { worldX, worldY } from './mercator.ts';
import { CACHE_DIR } from './paths.ts';

export const SKYWAYS_ZOOM = 11;
const LAYER = 'skyways_all_all';
const TILE_PX = 256;

/**
 * Alpha is box-averaged 4x4 before anything reads it.
 *
 * Density is an integral, so averaging is the right reduction rather than an
 * approximation of one — and since every query blurs over kilometres anyway,
 * the detail thrown away here is detail the kernel would have smoothed out. It
 * takes the whole of the coverage from 141 MB of alpha to under 9 MB.
 */
const DOWNSAMPLE = 4;
const CELL_PX = TILE_PX / DOWNSAMPLE;

/** How near counts as near. The one dial on the whole score. */
export const SIGMA_KM = 1.5;
/** Past three sigma a Gaussian contributes about a percent. */
const KERNEL_SIGMAS = 3;

const EQUATOR_M = 40075016.686;

const CACHE = join(CACHE_DIR, 'skyways');
const CONCURRENCY = 6;
const ATTEMPTS = 4;

const tilePath = (z: number, x: number, y: number) => join(CACHE, `${z}`, `${x}`, `${y}.png`);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const exists = (path: string) => stat(path).then(() => true, () => false);

/** XYZ in, TMS out — the row flip the service wants. */
export const tmsY = (y: number, zoom: number): number => 2 ** zoom - 1 - y;

const urlOf = (z: number, x: number, y: number) =>
  `https://thermal.kk7.ch/tiles/${LAYER}/${z}/${x}/${tmsY(y, z)}.png?src=balanci.ng`;

/** Every skyways tile the coverage needs, as `x/y` at `SKYWAYS_ZOOM`. */
export function tilesFor(coverage: Coverage): string[] {
  const wanted = new Set<string>();
  for (const cell of coverage.cells) {
    const match = /^x(-?\d+)y(-?\d+)$/.exec(cell);
    if (!match) throw new Error(`Not a cell key: ${cell}`);
    const [cx, cy] = [Number(match[1]), Number(match[2])];
    if (SKYWAYS_ZOOM >= coverage.zoom) {
      const span = 2 ** (SKYWAYS_ZOOM - coverage.zoom);
      for (let dx = 0; dx < span; dx++) {
        for (let dy = 0; dy < span; dy++) wanted.add(`${cx * span + dx}/${cy * span + dy}`);
      }
    } else {
      const span = 2 ** (coverage.zoom - SKYWAYS_ZOOM);
      wanted.add(`${Math.floor(cx / span)}/${Math.floor(cy / span)}`);
    }
  }
  return [...wanted];
}

/**
 * Fetches one tile to disk, if it is not already there.
 *
 * Written under `.part` and renamed, so a name that exists is always a whole
 * tile — the same discipline the extract downloads use, and for the same reason:
 * an interrupted write that looks finished is indistinguishable from a real one
 * until something downstream reads nonsense out of it.
 *
 * Returns false for a tile the service has no data for, which is not an error.
 */
async function fetchTile(x: number, y: number): Promise<boolean> {
  const path = tilePath(SKYWAYS_ZOOM, x, y);
  if (await exists(path)) return true;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(urlOf(SKYWAYS_ZOOM, x, y), {
        headers: { 'User-Agent': 'terrain-nerd/0.1 (data pipeline)' },
        // Node's fetch has no default timeout, and a connection accepted and
        // then abandoned hangs for ever — taking the retry below with it, since
        // the attempt never finishes.
        signal: AbortSignal.timeout(20000),
      });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());

      // The placeholder check, before anything is written. A 1x1 cached under a
      // real tile's name is a hole in the map that no later run would notice.
      const header = readSize(body);
      if (!header || header.width !== TILE_PX || header.height !== TILE_PX) return false;

      await mkdir(dirname(path), { recursive: true });
      const partial = `${path}.part`;
      await writeFile(partial, body);
      await rename(partial, path);
      return true;
    } catch (error) {
      if (attempt === ATTEMPTS) {
        console.warn(`  skyways: gave up on ${SKYWAYS_ZOOM}/${x}/${y} (${String(error)})`);
        return false;
      }
      await sleep(1000 * attempt);
    }
  }
  return false;
}

/** Width and height straight out of IHDR, without decoding the image. */
function readSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Brings every tile the coverage needs onto disk.
 *
 * Missing-only by construction — the cache is a `z/x/y` tree, so growing the
 * coverage fetches its new ground and nothing else, with no staleness stamp to
 * keep honest. Concurrency is held low because this is somebody's free service.
 */
export async function fetchSkyways(coverage: Coverage): Promise<void> {
  const tiles = tilesFor(coverage);
  const missing: [number, number][] = [];
  for (const key of tiles) {
    const [x, y] = key.split('/').map(Number);
    if (!(await exists(tilePath(SKYWAYS_ZOOM, x, y)))) missing.push([x, y]);
  }

  if (missing.length === 0) {
    console.log(`    skyways: ${tiles.length.toLocaleString()} tiles cached`);
    return;
  }
  console.log(
    `    skyways: ${missing.length.toLocaleString()} of ${tiles.length.toLocaleString()} tiles to fetch...`,
  );

  let done = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < missing.length) {
        const [x, y] = missing[next++];
        await fetchTile(x, y);
        if (++done % 200 === 0) process.stdout.write(`\r      ${done}/${missing.length}   `);
      }
    }),
  );
  process.stdout.write(`\r      ${done}/${missing.length} fetched\n`);
}

/**
 * The whole covered ground as flight density, downsampled and held in memory.
 *
 * A sparse map rather than one mosaic: the coverage is a scatter of cells inside
 * a box four times its area, so a rectangular raster would be mostly nothing.
 * A missing tile reads as zero, which is what uncovered ground means anyway.
 */
export type FlightRaster = {
  /** Downsampled pixels across the world at `SKYWAYS_ZOOM`. */
  worldSize: number;
  cells: Map<string, Uint8Array>;
};

export async function readSkyways(coverage: Coverage): Promise<FlightRaster> {
  const { decodeAlpha } = await import('./png.ts');
  const cells = new Map<string, Uint8Array>();
  let read = 0;

  for (const key of tilesFor(coverage)) {
    const [x, y] = key.split('/').map(Number);
    let png: Buffer;
    try {
      png = await readFile(tilePath(SKYWAYS_ZOOM, x, y));
    } catch {
      continue; // No data for this ground; it scores zero.
    }
    const { width, height, alpha } = decodeAlpha(png);
    if (width !== TILE_PX || height !== TILE_PX) continue;

    const small = new Uint8Array(CELL_PX * CELL_PX);
    for (let sy = 0; sy < CELL_PX; sy++) {
      for (let sx = 0; sx < CELL_PX; sx++) {
        let sum = 0;
        for (let dy = 0; dy < DOWNSAMPLE; dy++) {
          const row = (sy * DOWNSAMPLE + dy) * TILE_PX + sx * DOWNSAMPLE;
          for (let dx = 0; dx < DOWNSAMPLE; dx++) sum += alpha[row + dx];
        }
        small[sy * CELL_PX + sx] = Math.round(sum / (DOWNSAMPLE * DOWNSAMPLE));
      }
    }
    cells.set(key, small);
    read++;
  }

  console.log(`    skyways: ${read.toLocaleString()} tiles read, ${(read * CELL_PX * CELL_PX / 1048576).toFixed(1)} MB`);
  return { worldSize: CELL_PX * 2 ** SKYWAYS_ZOOM, cells };
}

type Kernel = { offsets: Int32Array; weights: Float64Array };

/**
 * A Gaussian disc, in downsampled pixels, normalised to sum to one.
 *
 * This is what makes "near" count rather than only "over". A pilot's track that
 * misses a summit by a kilometre still lands well inside the kernel; one that
 * misses by five is outside it entirely.
 */
function buildKernel(sigmaPx: number): Kernel {
  const radius = Math.max(1, Math.ceil(KERNEL_SIGMAS * sigmaPx));
  const offsets: number[] = [];
  const weights: number[] = [];
  let total = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      const w = Math.exp(-d2 / (2 * sigmaPx * sigmaPx));
      offsets.push(dx, dy);
      weights.push(w);
      total += w;
    }
  }
  return {
    offsets: Int32Array.from(offsets),
    weights: Float64Array.from(weights.map((w) => w / total)),
  };
}

/**
 * Kernels are per degree of latitude, because Mercator is.
 *
 * A pixel is a fixed slice of the projection, not of the ground: it covers
 * `cos(lat)` as many metres at 49°N as at the equator. One kernel in pixels
 * would therefore mean a different radius in kilometres at each end of the
 * coverage — 6.1 px at Sicily against 7.4 px in Bavaria for the same 1.5 km.
 */
function kernelBuilder(): (lat: number) => Kernel {
  const held = new Map<number, Kernel>();
  const metresPerPixelAtEquator = (EQUATOR_M / (TILE_PX * 2 ** SKYWAYS_ZOOM)) * DOWNSAMPLE;
  return (lat: number) => {
    const band = Math.round(lat);
    let kernel = held.get(band);
    if (!kernel) {
      const metresPerPixel = metresPerPixelAtEquator * Math.cos((band * Math.PI) / 180);
      kernel = buildKernel((SIGMA_KM * 1000) / metresPerPixel);
      held.set(band, kernel);
    }
    return kernel;
  };
}

/**
 * How much flying happens around each point, as a weighted mean alpha (0-255).
 *
 * Raw and unnormalised: what counts as "a lot" is a property of the dataset, not
 * of the ramp, so turning these into 0-1 is the caller's job once it can see the
 * whole distribution.
 */
export function sampleFlight(raster: FlightRaster, points: readonly LonLat[]): Float64Array {
  const kernelFor = kernelBuilder();
  const out = new Float64Array(points.length);
  const span = 2 ** SKYWAYS_ZOOM;

  for (let i = 0; i < points.length; i++) {
    const [lon, lat] = points[i];
    const kernel = kernelFor(lat);
    const px = Math.floor(worldX(lon, raster.worldSize));
    const py = Math.floor(worldY(lat, raster.worldSize));

    let sum = 0;
    for (let k = 0; k < kernel.weights.length; k++) {
      const x = px + kernel.offsets[k * 2];
      const y = py + kernel.offsets[k * 2 + 1];
      if (y < 0 || y >= raster.worldSize) continue;
      // Longitude wraps; latitude does not. Neither happens inside our coverage,
      // but a sampler that indexes past the edge of the world is a silent bug.
      const wrapped = ((x % raster.worldSize) + raster.worldSize) % raster.worldSize;
      const tileX = Math.floor(wrapped / CELL_PX);
      const tileY = Math.floor(y / CELL_PX);
      if (tileY < 0 || tileY >= span) continue;
      const cell = raster.cells.get(`${tileX}/${tileY}`);
      if (!cell) continue;
      sum += kernel.weights[k] * cell[(y % CELL_PX) * CELL_PX + (wrapped % CELL_PX)];
    }
    out[i] = sum;
  }
  return out;
}

/** How many tiles are cached, for reporting. Cheap enough to call once. */
export async function cachedTileCount(): Promise<number> {
  let count = 0;
  const zoomDir = join(CACHE, `${SKYWAYS_ZOOM}`);
  for (const column of await readdir(zoomDir).catch(() => [] as string[])) {
    const rows = await readdir(join(zoomDir, column)).catch(() => [] as string[]);
    count += rows.filter((name) => name.endsWith('.png')).length;
  }
  return count;
}
