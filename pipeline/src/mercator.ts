/**
 * Web Mercator, and the tile grid built on it.
 *
 * One scheme for everything: the chunk grid, the coverage grid and the vector
 * tiles are all ordinary XYZ tiles at different zooms, so they nest exactly —
 * a z9 chunk is four z10 coverage cells is sixteen z11 tiles.
 *
 * They used to be lon/lat grids at a size in degrees, which was never square:
 * a 0.5° cell is 38.7 km across and 55.3 km tall at 46°N, and the ratio moves
 * with latitude, so cells changed shape as you panned. Tiles are square on the
 * ground everywhere, which is what you want both for picking coverage on a map
 * and for reasoning about how much a screenful costs.
 *
 * Pure arithmetic, no I/O. `web/src/lib/grid.ts` carries a small copy of the
 * tile half, pinned to this by a test.
 */

/** [west, south, east, north] */
export type BBox = [number, number, number, number];

/** MapLibre's transform is built on 512px tiles; `map.project` follows from it. */
export const TILE_SIZE = 512;

/** Latitude beyond which Mercator runs away. The standard tile-scheme cutoff. */
export const MERCATOR_LIMIT = 85.051129;

const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);

export const worldSizeAt = (zoom: number): number => TILE_SIZE * 2 ** zoom;

export const worldX = (lon: number, worldSize: number): number =>
  ((lon + 180) / 360) * worldSize;

/**
 * Y grows *southward*, from 0 at the top — the XYZ convention that tippecanoe,
 * PMTiles and MapLibre all use. The degree grids this replaced counted the
 * other way, which is the one thing to keep straight when reading old keys.
 */
export const worldY = (lat: number, worldSize: number): number => {
  const phi = (clamp(lat, -MERCATOR_LIMIT, MERCATOR_LIMIT) * Math.PI) / 180;
  return (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * worldSize;
};

export const lonAtWorldX = (x: number, worldSize: number): number =>
  (x / worldSize) * 360 - 180;

export const latAtWorldY = (y: number, worldSize: number): number => {
  const n = Math.PI * (1 - (2 * y) / worldSize);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

/** The tile a coordinate falls in, at a given zoom. */
export const tileXOf = (lon: number, zoom: number): number =>
  Math.floor(worldX(lon, worldSizeAt(zoom)) / TILE_SIZE);

export const tileYOf = (lat: number, zoom: number): number =>
  Math.floor(worldY(lat, worldSizeAt(zoom)) / TILE_SIZE);

/** The ground a tile covers. */
export function tileBounds(x: number, y: number, zoom: number): BBox {
  const worldSize = worldSizeAt(zoom);
  return [
    lonAtWorldX(x * TILE_SIZE, worldSize),
    latAtWorldY((y + 1) * TILE_SIZE, worldSize),
    lonAtWorldX((x + 1) * TILE_SIZE, worldSize),
    latAtWorldY(y * TILE_SIZE, worldSize),
  ];
}
