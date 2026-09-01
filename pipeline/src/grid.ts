/**
 * The chunk grid: which tile a feature ships in.
 *
 * Cells are ordinary XYZ tiles rather than a grid in degrees, so they are square
 * on the ground at every latitude and nest exactly inside the coverage grid and
 * the vector tile pyramid. See `mercator.ts` for why that matters.
 *
 * Everything here takes the zoom rather than baking one in, because the same
 * arithmetic serves the chunk grid and the coverage grid at different zooms.
 */
import {
  TILE_SIZE,
  tileBounds,
  worldSizeAt,
  worldX,
  worldY,
  type BBox,
} from './mercator.ts';

export type { BBox };

/**
 * Cell keys are tile indices rather than coordinates: `x543y364`.
 *
 * Indices stay exact at any zoom, where a coordinate-based name would need
 * decimals. The zoom is not in the key because a pool only ever has one chunk
 * grid; `index.json` records it as `chunkZoom`.
 */
export const keyOf = (ix: number, iy: number): string => `x${ix}y${iy}`;

export const bboxOfCell = (key: string, zoom: number): BBox => {
  const match = /^x(-?\d+)y(-?\d+)$/.exec(key);
  if (!match) throw new Error(`Not a cell key: ${key}`);
  return tileBounds(Number(match[1]), Number(match[2]), zoom);
};

/**
 * Every cell the box touches.
 *
 * The east and north edges are exclusive, so a box landing exactly on a cell
 * boundary does not drag in the neighbour it merely grazes — which is what
 * `ceil(...) - 1` buys, without an equality test on a float that a round trip
 * through Mercator would rarely satisfy.
 *
 * Note tile Y counts southward, so the box's *north* edge gives the lowest
 * index and its south edge the highest. That inversion is the one thing to keep
 * straight against the degree grid this replaced.
 */
export function cellsCovering(box: BBox, zoom: number): string[] {
  const [w, s, e, n] = box;
  const worldSize = worldSizeAt(zoom);
  const xAt = (lon: number) => worldX(lon, worldSize) / TILE_SIZE;
  const yAt = (lat: number) => worldY(lat, worldSize) / TILE_SIZE;

  const minX = Math.floor(xAt(w));
  const minY = Math.floor(yAt(n));
  const maxX = Math.max(minX, Math.ceil(xAt(e)) - 1);
  const maxY = Math.max(minY, Math.ceil(yAt(s)) - 1);

  const keys: string[] = [];
  for (let ix = minX; ix <= maxX; ix++) {
    for (let iy = minY; iy <= maxY; iy++) keys.push(keyOf(ix, iy));
  }
  return keys;
}
