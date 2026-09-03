/**
 * Turns the basemap furniture into vector tiles.
 *
 * The GeoJSON cells this replaces hold every road, lake and river at one fixed
 * simplification whatever the zoom, on a grid that never subdivides. So looking
 * at all of Italy pulled about 11 MB in 314 requests to draw hairlines, and a
 * z14 view still fetched a whole z9 cell — some 600 times the ground it drew.
 * A pyramid fixes both: detail matched to the zoom, and tiles that always cover
 * about the same amount of screen.
 *
 * Roads, glaciers, lakes, rivers and the sea go into one tileset at one maximum
 * zoom. Splitting water and roads into two tilesets and joining them was the
 * plan, so each could take its own simplification — but a joined archive
 * declares the deeper of the two maximums, and at that zoom the shallower half
 * has no tiles and its features simply disappear.
 *
 * Only `kind` and `class` are carried. That is what the style reads, and it
 * means the tiles physically cannot hold a name — a stronger version of the
 * no-symbol-layer rule than the test that currently enforces it, because it
 * stops being a policy and starts being a property of the data.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { LonLat } from './geo.ts';
import { CACHE_DIR } from './paths.ts';
import { OUT_DIR } from './paths.ts';

/** As deep as the app goes is 14; tiles stop at 13 and MapLibre overzooms. */
const MAX_TILE_ZOOM = 13;
const MIN_TILE_ZOOM = 4;
/**
 * Tippecanoe's baseline is a 4096th of a tile, so this is gentler than it
 * looks: about 19 m at z12, against a screen pixel of the same order.
 */
const SIMPLIFICATION = 8;

/**
 * Minor roads simply do not exist below z9.
 *
 * Not a size trick so much as a legibility one — at half a country a secondary
 * road is a thread you cannot follow, and half a million of them is what made
 * a naive run produce 625 KB tiles that had to have 70% of their features
 * thrown away to fit.
 */
const FILTER = JSON.stringify({
  context: [
    'any',
    ['!=', 'kind', 'road'],
    ['in', 'class', 'motorway', 'trunk'],
    ['>=', '$zoom', 9],
  ],
});

export type TileFeature = {
  kind: string;
  class?: string;
  shape: { type: 'MultiPolygon'; coordinates: LonLat[][][] } | { type: 'MultiLineString'; coordinates: LonLat[][] };
};

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`${command} not found. Install it with: brew install tippecanoe`)
          : error,
      ),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

/** One feature per line, which is what tippecanoe reads fastest. */
async function writeSeq(path: string, features: readonly TileFeature[]): Promise<void> {
  const out = createWriteStream(path);
  for (const feature of features) {
    const line = JSON.stringify({
      type: 'Feature',
      properties: { kind: feature.kind, ...(feature.class ? { class: feature.class } : {}) },
      geometry: feature.shape,
    });
    if (!out.write(`${line}\n`)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    out.end();
  });
}

/**
 * Builds `data/context.pmtiles` from everything the basemap draws.
 *
 * One archive rather than a directory of tiles: on a VM it is one file to
 * rsync instead of tens of thousands, and nginx serves the byte ranges out of
 * it with no configuration and no tile server.
 */
export async function buildTiles(features: readonly TileFeature[]): Promise<number> {
  const seq = join(CACHE_DIR, 'context.geojsonseq');
  const out = join(OUT_DIR, 'context.pmtiles');
  await writeSeq(seq, features);

  await run('tippecanoe', [
    '-o', out, '--force',
    '-l', 'context',
    '-Z', String(MIN_TILE_ZOOM),
    '-z', String(MAX_TILE_ZOOM),
    '--simplification', String(SIMPLIFICATION),
    // Keep only what the style reads; a name cannot then reach the map at all.
    '-y', 'kind', '-y', 'class',
    '-j', FILTER,
    // Coastlines and lakes are read as silhouettes, so they must not be thinned
    // away; the tile budget is met by dropping the densest instead.
    '--drop-densest-as-needed',
    '--no-tile-size-limit',
    seq,
  ]);

  await rm(seq, { force: true });
  return (await stat(out)).size;
}
