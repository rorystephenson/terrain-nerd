/**
 * Where basemap tiles come from, and what stands in where there are none.
 *
 * The pyramid only covers ground someone chose in `tools/coverage`, so most of
 * the world has no tile at all. Left alone, MapLibre would ask for every one of
 * them and take a 404 — noise in the console, wasted reads against the tile
 * store, and nothing drawn either way.
 *
 * So the coverage set ships with the pool and this resolves each request against
 * it before the network is touched. A tile inside coverage is fetched; anything
 * outside is answered immediately with a placeholder saying so. That is the only
 * reason the client needs to know the coverage at all.
 *
 * Coverage only ever grows, so a stale copy held in a cached bundle under-claims
 * — it may show the placeholder over ground that has since been rendered, which
 * a reload fixes. It can never claim ground that was never rendered.
 */
import maplibregl from 'maplibre-gl';

import placeholderUrl from '../assets/uncovered.webp';

/** The zoom the coverage cells are expressed at, from `tools/coverage`. */
let coverageZoom = 10;
let covered: Set<string> | null = null;

/**
 * Teaches the map where the tiles are.
 *
 * `null` coverage means "assume everything is covered", which is what a pool
 * built before coverage existed implies — the placeholder then never appears
 * and a missing tile simply does not draw, as it did before.
 */
export function useCoverage(coverage: { zoom: number; cells: string[] } | null | undefined): void {
  if (!coverage) {
    covered = null;
    return;
  }
  coverageZoom = coverage.zoom;
  covered = new Set(coverage.cells);
}

/** Is there a rendered tile for this one? */
export function isCovered(z: number, x: number, y: number): boolean {
  if (!covered) return true;
  // Walk up to the zoom the coverage was chosen at. Below it, a tile is covered
  // if any of the cells beneath it is — a z6 tile is mostly sea and still worth
  // drawing for the scrap of Alps in its corner.
  if (z >= coverageZoom) {
    const shift = z - coverageZoom;
    return covered.has(`x${x >> shift}y${y >> shift}`);
  }
  const span = 2 ** (coverageZoom - z);
  for (let dx = 0; dx < span; dx++) {
    for (let dy = 0; dy < span; dy++) {
      if (covered.has(`x${x * span + dx}y${y * span + dy}`)) return true;
    }
  }
  return false;
}

const TILE = /^tn:\/\/(.+?)\/(\d+)\/(\d+)\/(\d+)\.webp$/;

let placeholder: Promise<ArrayBuffer> | null = null;
const placeholderBytes = () => {
  placeholder ??= fetch(placeholderUrl).then((r) => r.arrayBuffer());
  return placeholder;
};

/**
 * Resolves `tn://<base>/{z}/{x}/{y}.webp`.
 *
 * A protocol rather than a plain tile URL because the decision — fetch, or say
 * "not covered" — has to happen before the request, and MapLibre offers no
 * other hook between choosing a tile and asking for it.
 */
export function registerTileProtocol(): void {
  maplibregl.addProtocol('tn', async (params, abortController) => {
    const match = TILE.exec(params.url);
    if (!match) throw new Error(`Not a tile URL: ${params.url}`);
    const [, base, z, x, y] = match;

    if (!isCovered(Number(z), Number(x), Number(y))) {
      return { data: await placeholderBytes() };
    }

    const response = await fetch(`${base}/${z}/${x}/${y}.webp`, {
      signal: abortController.signal,
    });
    // A tile inside coverage that is missing anyway means the pyramid and the
    // coverage have drifted apart. Say so rather than drawing nothing.
    if (!response.ok) return { data: await placeholderBytes() };
    return { data: await response.arrayBuffer() };
  });
}
