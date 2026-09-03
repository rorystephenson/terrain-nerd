/**
 * Where the ground comes from, and what stands in where we have none.
 *
 * The pyramid only covers ground chosen in `tools/coverage`. Rather than let the
 * map ask for tiles that were never rendered and take a 404 for each — noise,
 * billed reads, and a wait before anything is drawn — the coverage set ships
 * with the pool and every request is resolved against it before the network is
 * touched.
 *
 * Ground we have not rendered is answered with a placeholder saying so, rather
 * than left blank or filled from someone else's tiles. A third-party terrain
 * layer was tried and dropped: it made unsupported ground look like a working
 * map, which is the opposite of what the edge of coverage should communicate.
 *
 * Coverage only ever grows, so a stale copy in a cached bundle under-claims: it
 * may fall back over ground that has since been rendered, which a reload fixes.
 * It can never claim a tile that does not exist.
 */
import maplibregl from 'maplibre-gl';

import placeholderUrl from '../assets/uncovered.webp';

/** The zoom the coverage cells are expressed at, from `tools/coverage`. */
let coverageZoom = 10;
let covered: Set<string> | null = null;

/**
 * Teaches the map where our own tiles are.
 *
 * `null` coverage means "assume everything is covered", which is what a pool
 * built before coverage existed implies — the fallback then never appears and a
 * missing tile simply does not draw, as it did before.
 */
export function useCoverage(coverage: { zoom: number; cells: string[] } | null | undefined): void {
  if (!coverage) {
    covered = null;
    return;
  }
  coverageZoom = coverage.zoom;
  covered = new Set(coverage.cells);
}

/** Is there a rendered tile of ours for this one? */
export function isCovered(z: number, x: number, y: number): boolean {
  if (!covered) return true;
  if (z >= coverageZoom) {
    const shift = z - coverageZoom;
    return covered.has(`x${x >> shift}y${y >> shift}`);
  }
  // Below the coverage zoom a tile spans many cells. It counts as covered if any
  // of them is: a z6 tile is mostly sea and still worth drawing for the scrap of
  // Alps in its corner.
  const span = 2 ** (coverageZoom - z);
  for (let dx = 0; dx < span; dx++) {
    for (let dy = 0; dy < span; dy++) {
      if (covered.has(`x${x * span + dx}y${y * span + dy}`)) return true;
    }
  }
  return false;
}

const OURS = /^tn:\/\/(.+?)\/(\d+)\/(\d+)\/(\d+)\.webp$/;

/** Fetched once from the bundle, then held. */
let placeholder: Promise<ArrayBuffer> | null = null;
const placeholderTile = () =>
  (placeholder ??= fetch(placeholderUrl).then((r) => r.arrayBuffer()));

/**
 * Resolves `tn://<base>/{z}/{x}/{y}.webp`.
 *
 * A protocol rather than a plain tile URL because the decision — fetch, or say
 * "not supported" — has to be made *before* the request, and MapLibre offers no
 * other hook between choosing a tile and asking for it.
 */
export function registerTileProtocols(): void {
  maplibregl.addProtocol('tn', async (params, abort) => {
    const match = OURS.exec(params.url);
    if (!match) throw new Error(`Not a tile URL: ${params.url}`);
    const [, base, z, x, y] = match;
    if (!isCovered(Number(z), Number(x), Number(y))) return { data: await placeholderTile() };

    const response = await fetch(`${base}/${z}/${x}/${y}.webp`, { signal: abort.signal });
    /*
     * Covered but not there — mid-render, a part-finished upload, a gap between
     * the pyramid and the coverage. Deliberately *not* the placeholder: saying
     * "not supported" over ground that is supported is a lie the user cannot
     * tell from the truth, and it reads as a hole punched in the map.
     *
     * Failing instead leaves MapLibre showing the parent tile scaled up, which
     * is what it does for any tile it cannot get. Blurry and continuous beats
     * sharp and wrong.
     */
    if (!response.ok) throw new Error(`No tile at ${z}/${x}/${y}`);
    return { data: await response.arrayBuffer() };
  });
}
