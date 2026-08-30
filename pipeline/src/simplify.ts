/**
 * Douglas–Peucker line simplification.
 *
 * Rivers are the reason this exists: Trentino's water context alone is 1.4 MB,
 * almost entirely river vertices at a precision no quiz map can render. Left
 * alone, Italy-wide water would be tens of megabytes.
 */
import type { LonLat } from './geo.ts';

const EARTH_R = 6371;

/**
 * Perpendicular distance from `p` to the segment `a`-`b`, in km.
 *
 * Works in a local flat projection rather than on the sphere: longitude is
 * scaled by cos(latitude) so a degree east counts for what it is worth at this
 * latitude. Over a river bend the error is far below the tolerance we simplify at.
 */
function perpendicularKm(p: LonLat, a: LonLat, b: LonLat): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const toXY = (q: LonLat): [number, number] => [
    ((q[0] * Math.PI) / 180) * k * EARTH_R,
    ((q[1] * Math.PI) / 180) * EARTH_R,
  ];
  const [px, py] = toXY(p);
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Simplifies a line, keeping its endpoints. `toleranceKm` is the max deviation. */
export function simplify(points: LonLat[], toleranceKm: number): LonLat[] {
  if (points.length <= 2) return points;

  // Iterative rather than recursive: a long river can be tens of thousands of
  // vertices, which is enough to blow the stack.
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    let worst = 0;
    let at = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = perpendicularKm(points[i], points[first], points[last]);
      if (distance > worst) {
        worst = distance;
        at = i;
      }
    }
    if (at !== -1 && worst > toleranceKm) {
      keep[at] = 1;
      stack.push([first, at], [at, last]);
    }
  }

  return points.filter((_, i) => keep[i] === 1);
}
