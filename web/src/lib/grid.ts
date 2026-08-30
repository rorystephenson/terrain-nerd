/**
 * Client-side half of the chunk grid.
 *
 * Deliberately a small copy of `pipeline/src/grid.ts` rather than a shared
 * module: crossing the workspace boundary would mean Vite `fs.allow` rules and
 * a build-time dependency on the pipeline, for fifteen lines of arithmetic. The
 * key format is pinned by tests on both sides, which is what actually has to
 * agree.
 */

export type BBox = [number, number, number, number];

export const keyOf = (ix: number, iy: number): string => `x${ix}y${iy}`;

/**
 * Every cell the box touches.
 *
 * East and north edges are exclusive, so a box landing exactly on a boundary
 * does not drag in the neighbour it merely grazes.
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

export const boxesOverlap = (a: BBox, b: BBox): boolean =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

export const pointInBox = (point: [number, number], box: BBox): boolean =>
  point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3];

/**
 * Does a geometry actually enter the box?
 *
 * Bounding boxes are not good enough on their own here. A valley running
 * diagonally has a bbox far larger than the valley, and that bbox can clip the
 * corner of a chosen area the valley never reaches — so the builder would offer
 * you a valley from the next system over.
 *
 * Uses the Liang–Barsky slab test per segment, which is true when any part of
 * the segment lies in the box, endpoints included. A segment that crosses the
 * area without either end inside it still counts, which is the whole point.
 */
export function geometryIntersectsBox(geometry: GeoJSON.Geometry, box: BBox): boolean {
  const segment = (a: number[], b: number[]): boolean => {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const clip = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0; // parallel to this edge: inside iff not beyond it
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
      return true;
    };
    return (
      clip(-dx, a[0] - box[0]) &&
      clip(dx, box[2] - a[0]) &&
      clip(-dy, a[1] - box[1]) &&
      clip(dy, box[3] - a[1])
    );
  };

  const line = (points: number[][]): boolean => {
    if (points.length === 1) return pointInBox(points[0] as [number, number], box);
    for (let i = 1; i < points.length; i++) if (segment(points[i - 1], points[i])) return true;
    return false;
  };

  switch (geometry.type) {
    case 'Point':
      return pointInBox(geometry.coordinates as [number, number], box);
    case 'MultiPoint':
    case 'LineString':
      return line(geometry.coordinates as number[][]);
    case 'MultiLineString':
    case 'Polygon':
      return (geometry.coordinates as number[][][]).some(line);
    case 'MultiPolygon':
      return (geometry.coordinates as number[][][][]).some((poly) => poly.some(line));
    default:
      return false;
  }
}
