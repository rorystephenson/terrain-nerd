/** Geometry helpers. Coordinates are always [lon, lat] (GeoJSON order). */

export type LonLat = [number, number];
/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: LonLat, b: LonLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthKm(coords: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineKm(coords[i - 1], coords[i]);
  return total;
}

export function bboxOf(coords: LonLat[]): BBox {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

export function bboxUnion(boxes: BBox[]): BBox {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/**
 * Approximate shortest distance between two bounding boxes, in km.
 * Zero when they overlap. Used to decide whether two same-named line segments
 * are parts of one valley or unrelated valleys that merely share a name.
 */
export function bboxGapKm(a: BBox, b: BBox): number {
  const dLon = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
  const dLat = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
  if (dLon === 0 && dLat === 0) return 0;
  const midLat = (a[1] + a[3] + b[1] + b[3]) / 4;
  const kmPerDegLon = 111.32 * Math.cos(toRad(midLat));
  return Math.hypot(dLon * kmPerDegLon, dLat * 110.57);
}

/** The point half-way along the line by distance — always sits on the feature. */
export function midpointOfLine(coords: LonLat[]): LonLat {
  if (coords.length === 1) return coords[0];
  const half = lineLengthKm(coords) / 2;
  let travelled = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversineKm(coords[i - 1], coords[i]);
    if (travelled + seg >= half) {
      const t = seg === 0 ? 0 : (half - travelled) / seg;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ];
    }
    travelled += seg;
  }
  return coords[coords.length - 1];
}

/** Ray-casting point-in-ring test. */
export function pointInRing(pt: LonLat, ring: LonLat[]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export type Boundary = { outer: LonLat[][]; inner: LonLat[][] };

export function pointInBoundary(pt: LonLat, boundary: Boundary): boolean {
  if (!boundary.outer.some((ring) => pointInRing(pt, ring))) return false;
  return !boundary.inner.some((ring) => pointInRing(pt, ring));
}

/**
 * Chain a relation's member ways into closed rings.
 *
 * An OSM boundary relation is an unordered bag of way fragments; they only form
 * a polygon once joined end-to-end. Fragments that never close are discarded.
 */
export function assembleRings(ways: LonLat[][]): LonLat[][] {
  const key = (p: LonLat) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const open: LonLat[][] = [];
  const rings: LonLat[][] = [];

  const isClosed = (c: LonLat[]) => c.length > 3 && key(c[0]) === key(c[c.length - 1]);

  for (const way of ways) {
    if (way.length < 2) continue;
    let current = [...way];
    if (isClosed(current)) {
      rings.push(current);
      continue;
    }
    // Repeatedly absorb any open chain that shares an endpoint with `current`.
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < open.length; i++) {
        const other = open[i];
        const cs = key(current[0]);
        const ce = key(current[current.length - 1]);
        const os = key(other[0]);
        const oe = key(other[other.length - 1]);
        let joined: LonLat[] | null = null;
        if (ce === os) joined = [...current, ...other.slice(1)];
        else if (ce === oe) joined = [...current, ...other.slice(0, -1).reverse()];
        else if (cs === oe) joined = [...other, ...current.slice(1)];
        else if (cs === os) joined = [...other.slice(1).reverse(), ...current];
        if (joined) {
          open.splice(i, 1);
          current = joined;
          merged = true;
          break;
        }
      }
    }
    if (isClosed(current)) rings.push(current);
    else open.push(current);
  }
  return rings;
}
