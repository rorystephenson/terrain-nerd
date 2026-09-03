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
    const match = /^x(-?\d+)y(-?\d+)$/.exec(cell);
    if (!match) throw new Error(`Not a cell key: ${cell}`);
    return { x: Number(match[1]), y: Number(match[2]) };
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
