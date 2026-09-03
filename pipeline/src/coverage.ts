/**
 * The ground this pool is built for.
 *
 * `coverage.json` is a set of z10 tiles, chosen by hand in `tools/coverage`
 * against a map of where people actually fly. It is a build *input*, committed
 * like any other decision, and it gates everything: what gets downloaded, what
 * survives the clip, and therefore what ends up in every chunk and tile.
 *
 * Absent, it means "no clipping" — the pipeline behaves exactly as it did
 * before coverage existed, which keeps the two changes independent.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bboxOfCell } from './grid.ts';
import type { BBox } from './mercator.ts';
import { CACHE_DIR } from './paths.ts';

/** One Geofabrik extract the coverage needs, as chosen by `tools/coverage`. */
export type Source = { id: string; name: string; pbf: string };

export type Coverage = {
  /** Zoom of the tiles in `cells`. */
  zoom: number;
  cells: string[];
  /**
   * The extracts to download, cheapest set that covers every cell. Written by
   * the tool because choosing it needs the sizes of 60-odd downloads, which is
   * a question for something interactive and not for a build step.
   */
  sources?: Source[];
};

const COVERAGE_FILE = new URL('../coverage.json', import.meta.url).pathname;

export function readCoverage(): Coverage | null {
  try {
    const parsed = JSON.parse(readFileSync(COVERAGE_FILE, 'utf8')) as Coverage;
    if (!parsed.cells?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * A stable fingerprint of the covered ground.
 *
 * Everything downstream of coverage — the clipped extracts, the tile pyramid —
 * is stale when this changes and only when this changes, so the things that
 * derive from it can tell "still current" from "built for different ground"
 * without comparing timestamps against a file that did not move.
 *
 * Sorted, so the same cells in another order are the same coverage. The zoom is
 * in it because identical keys at a different zoom are different ground.
 */
export function coverageHash(coverage: Coverage): string {
  return createHash('sha1')
    .update(`z${coverage.zoom}:${[...coverage.cells].sort().join(',')}`)
    .digest('hex')
    .slice(0, 12);
}

/** A cell key back into its tile column and row. */
const cellXY = (cell: string): [number, number] => {
  const match = /^x(-?\d+)y(-?\d+)$/.exec(cell);
  if (!match) throw new Error(`Not a cell key: ${cell}`);
  return [Number(match[1]), Number(match[2])];
};

/** The whole of the covered ground, as one box. */
export function coverageBBox(coverage: Coverage): BBox {
  const boxes = coverage.cells.map((cell) => bboxOfCell(cell, coverage.zoom));
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/**
 * Covered cells merged into as few rectangles as possible, greedily.
 *
 * One polygon per cell would work, but 527 squares sharing edges is a lot of
 * ring for osmium to test every node against, and a MultiPolygon whose parts
 * touch is the sort of thing geometry libraries have opinions about. Runs of
 * adjacent cells in a row are merged, then rows merged downward where their
 * runs line up exactly — which turns a blocky selection into a handful of
 * rectangles and leaves a scattered one no worse than it was.
 */
export function coverageRects(coverage: Coverage): BBox[] {
  const cells = new Set(coverage.cells);
  const parsed = coverage.cells.map((cell) => {
    const [x, y] = cellXY(cell);
    return { x, y };
  });

  // Horizontal runs first.
  const runs: { y: number; x0: number; x1: number }[] = [];
  const seen = new Set<string>();
  for (const { x, y } of [...parsed].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (seen.has(`x${x}y${y}`)) continue;
    let x1 = x;
    while (cells.has(`x${x1 + 1}y${y}`)) x1++;
    for (let at = x; at <= x1; at++) seen.add(`x${at}y${y}`);
    runs.push({ y, x0: x, x1 });
  }

  // Then stack rows whose runs match exactly.
  const merged: { y0: number; y1: number; x0: number; x1: number }[] = [];
  const used = new Set<number>();
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    const run = runs[i];
    let y1 = run.y;
    for (;;) {
      const below = runs.findIndex(
        (other, j) => !used.has(j) && j !== i && other.y === y1 + 1 && other.x0 === run.x0 && other.x1 === run.x1,
      );
      if (below === -1) break;
      used.add(below);
      y1++;
    }
    merged.push({ y0: run.y, y1, x0: run.x0, x1: run.x1 });
  }

  return merged.map(({ x0, x1, y0, y1 }) => {
    // Tile rows count southward, so the lowest row index is the *northern* edge.
    const north = bboxOfCell(`x${x0}y${y0}`, coverage.zoom);
    const south = bboxOfCell(`x${x1}y${y1}`, coverage.zoom);
    return [north[0], south[1], south[2], north[3]] as BBox;
  });
}

/**
 * The rendered tiles a coverage change makes wrong, as `z/x/y`.
 *
 * Not just the new ground's own tiles. The hatch marking uncovered ground is
 * painted into the image, and so are the roads and water, which exist only
 * inside the clip — so any tile whose footprint holds a cell that changed is
 * showing the old answer. Keeping it because a file is there is how widening
 * the coverage came to leave the old edges drawn at every zoom out.
 *
 * Which tiles those are falls out of the grid. At the coverage zoom and deeper,
 * a tile lies wholly inside one cell: an added cell's tiles do not exist yet,
 * and a dropped cell's are simply unwanted. Wider than that, one tile spans
 * many cells, and every one of those over changed ground has to go.
 */
export function staleTiles(
  before: Pick<Coverage, 'cells'>,
  after: Coverage,
  minZoom: number,
  maxZoom: number,
): string[] {
  const was = new Set(before.cells);
  const now = new Set(after.cells);
  const changed = [...new Set([...was, ...now])].filter((cell) => was.has(cell) !== now.has(cell));

  const stale = new Set<string>();
  for (const cell of changed) {
    const [cx, cy] = cellXY(cell);
    for (let z = minZoom; z < after.zoom && z <= maxZoom; z++) {
      const span = 2 ** (after.zoom - z);
      stale.add(`${z}/${Math.floor(cx / span)}/${Math.floor(cy / span)}`);
    }
    // Still covered: its own tiles are either already right or not yet drawn.
    if (now.has(cell)) continue;
    for (let z = Math.max(after.zoom, minZoom); z <= maxZoom; z++) {
      const span = 2 ** (z - after.zoom);
      for (let dx = 0; dx < span; dx++)
        for (let dy = 0; dy < span; dy++) stale.add(`${z}/${cx * span + dx}/${cy * span + dy}`);
    }
  }
  return [...stale];
}

const ring = ([w, s, e, n]: BBox) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];

/**
 * Writes the clip polygon osmium cuts the extracts down to.
 *
 * Returned as a path rather than a geometry because `osmium extract` takes a
 * file, and because having it on disk makes a wrong clip something you can look
 * at on a map rather than something you infer from what went missing.
 */
export async function writeCoveragePolygon(coverage: Coverage): Promise<string> {
  const path = join(CACHE_DIR, 'coverage-clip.geojson');
  await writeFile(
    path,
    `${JSON.stringify({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: coverageRects(coverage).map(ring) },
    })}\n`,
  );
  return path;
}
