/**
 * The sea.
 *
 * There was none. `natural=coastline` is never extracted, and even if it were,
 * coastline in OSM is a set of unordered way fragments with land on the left —
 * assembling them into ocean polygons is hard enough that `osmcoastline` exists
 * to do only that. So the Mediterranean rendered as the pale tint at the bottom
 * of the elevation ramp, the same colour as a valley floor, with submarine
 * relief showing through it as hillshade texture. Worst at exactly the
 * zoomed-out view where you are choosing an area.
 *
 * osmdata.openstreetmap.de publishes the assembled result, already split into
 * manageable pieces and already in WGS84 so nothing has to be reprojected. Read
 * with a pure-JS shapefile reader so the pipeline stays Node plus osmium plus
 * tippecanoe, with no GDAL.
 *
 * Polygons are kept whole rather than clipped to the coverage boundary. They
 * are pre-split into small pieces, so keeping the ones that touch covered
 * ground costs little, and letting the sea run a little past the edge is better
 * than a straight cut across open water where the coverage happens to stop.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LonLat } from './geo.ts';
import type { BBox } from './mercator.ts';
import { CACHE_DIR } from './paths.ts';

export const COASTLINE_URL =
  'https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip';
export const COASTLINE_DIR = join(CACHE_DIR, 'water-polygons-split-4326');

/** Where the shapefile lands once the zip is unpacked. */
async function findShapefile(): Promise<string | null> {
  try {
    const entries = await readdir(COASTLINE_DIR, { withFileTypes: true, recursive: true });
    const shp = entries.find((entry) => entry.isFile() && entry.name.endsWith('.shp'));
    return shp ? join(shp.parentPath ?? COASTLINE_DIR, shp.name) : null;
  } catch {
    return null;
  }
}

const overlaps = (a: BBox, b: BBox): boolean =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

const bboxOfRings = (rings: LonLat[][]): BBox => {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
};

export type OceanPiece = { bbox: BBox; rings: LonLat[][][] };

/**
 * Scanning the planet's water takes three minutes, and `build:data` gets run
 * far more often than coverage changes — so the filtered result is kept, keyed
 * by the coverage it was filtered against. Change the cells and it rescans.
 */
const CACHE = join(CACHE_DIR, 'ocean.json');

const fingerprint = (within: readonly BBox[]) =>
  createHash('sha1').update(JSON.stringify(within)).digest('hex').slice(0, 16);

/**
 * Every ocean polygon touching the covered ground.
 *
 * Streams the shapefile rather than reading it whole: the planet's water is
 * 904 MB zipped and the reader hands back one feature at a time, so there is no
 * reason to hold more than one.
 */
export async function readOcean(within: readonly BBox[]): Promise<OceanPiece[]> {
  const key = fingerprint(within);
  try {
    const held = JSON.parse(await readFile(CACHE, 'utf8')) as { key: string; pieces: OceanPiece[] };
    if (held.key === key) return held.pieces;
  } catch {
    // No usable cache; fall through and scan.
  }

  const path = await findShapefile();
  if (!path) return [];
  console.log('  sea: scanning the planet water polygons (a few minutes, cached after)');

  const { openShp } = await import('shapefile');
  const source = await openShp(createReadStream(path));
  const out: OceanPiece[] = [];

  for (;;) {
    const next = await source.read();
    if (next.done) break;
    const geometry = next.value as { type: string; coordinates: unknown } | null;
    if (!geometry) continue;

    const polygons: LonLat[][][] =
      geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as LonLat[][][])
        : geometry.type === 'Polygon'
          ? [geometry.coordinates as LonLat[][]]
          : [];

    for (const rings of polygons) {
      if (!rings.length) continue;
      const bbox = bboxOfRings(rings);
      if (!within.some((box) => overlaps(bbox, box))) continue;
      out.push({ bbox, rings: [rings] });
    }
  }

  await writeFile(CACHE, JSON.stringify({ key, pieces: out }));
  return out;
}
