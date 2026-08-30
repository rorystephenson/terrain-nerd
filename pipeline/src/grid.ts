/**
 * A regular lon/lat grid, used twice: to chunk the Overpass download, and again
 * to chunk what ships to the browser. The two use different cell sizes, so
 * every function takes `size` rather than baking one in.
 */

/** [west, south, east, north] */
export type BBox = [number, number, number, number];

const QUARTERS = ['sw', 'se', 'nw', 'ne'] as const;
export type Quarter = (typeof QUARTERS)[number];

const KEY = /^x(-?\d+)y(-?\d+)((?:-(?:sw|se|nw|ne))*)$/;

/**
 * Cell keys are grid indices rather than coordinates: `x12y46`.
 *
 * Indices stay exact at any cell size, where a coordinate-based name would need
 * decimals the moment the grid is finer than a degree. A cell that had to be
 * split appends its quarter, so `x12y46-sw-ne` is a quarter of a quarter and
 * its depth is readable straight off the key.
 */
export const keyOf = (ix: number, iy: number): string => `x${ix}y${iy}`;

/** How many times this cell has been split. 0 for a whole grid cell. */
export function depthOf(key: string): number {
  const match = KEY.exec(key);
  if (!match) throw new Error(`Not a cell key: ${key}`);
  return match[3] ? match[3].split('-').length - 1 : 0;
}

export function bboxOfCell(key: string, size: number): BBox {
  const match = KEY.exec(key);
  if (!match) throw new Error(`Not a cell key: ${key}`);

  const ix = Number(match[1]);
  const iy = Number(match[2]);
  let [w, s, e, n]: BBox = [ix * size, iy * size, (ix + 1) * size, (iy + 1) * size];

  for (const quarter of match[3] ? match[3].slice(1).split('-') : []) {
    const midLon = (w + e) / 2;
    const midLat = (s + n) / 2;
    if (quarter === 'sw') [e, n] = [midLon, midLat];
    else if (quarter === 'se') [w, n] = [midLon, midLat];
    else if (quarter === 'nw') [e, s] = [midLon, midLat];
    else [w, s] = [midLon, midLat];
  }
  return [w, s, e, n];
}

export const quartersOf = (key: string): string[] => QUARTERS.map((q) => `${key}-${q}`);

/**
 * Every cell the box touches.
 *
 * The east and north edges are exclusive, so a box landing exactly on a cell
 * boundary does not drag in the neighbour it merely grazes.
 */
export function cellsCovering(box: BBox, size: number): string[] {
  const [w, s, e, n] = box;
  const minX = Math.floor(w / size);
  const minY = Math.floor(s / size);
  const maxX = Math.max(minX, Math.ceil(e / size) - 1);
  const maxY = Math.max(minY, Math.ceil(n / size) - 1);

  const keys: string[] = [];
  for (let ix = minX; ix <= maxX; ix++) {
    for (let iy = minY; iy <= maxY; iy++) keys.push(keyOf(ix, iy));
  }
  return keys;
}

export const overlaps = (a: BBox, b: BBox): boolean =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
