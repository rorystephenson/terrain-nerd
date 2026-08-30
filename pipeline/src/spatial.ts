/**
 * A uniform lon/lat bucket grid for nearest-neighbour queries.
 *
 * Peak isolation — the distance to the nearest higher peak — is the reason this
 * exists. Done naively it is O(n^2): at Trentino's 1,795 peaks that is 3.2M
 * haversines and runs instantly, but the pool is now all of Italy at 36,757,
 * which is 1.35 *billion* and never finishes.
 */
import { haversineKm, type LonLat } from './geo.ts';

/** Km per degree. Longitude shrinks by cos(lat); handled where it matters. */
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON = 111.32;

export type GridIndex<T> = {
  /**
   * Distance in km to the nearest accepted item, or `capKm` if none is within it.
   *
   * Searches outward ring by ring, stopping as soon as the closest point the
   * next ring could possibly hold is further than the best already found.
   */
  nearest: (from: LonLat, accept: (item: T) => boolean, capKm: number) => number;
};

export function buildIndex<T>(
  items: readonly T[],
  at: (item: T) => LonLat,
  cellDeg = 0.1,
): GridIndex<T> {
  const buckets = new Map<string, T[]>();
  let maxAbsLat = 0;

  for (const item of items) {
    const point = at(item);
    const key = `${Math.floor(point[0] / cellDeg)}:${Math.floor(point[1] / cellDeg)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
    maxAbsLat = Math.max(maxAbsLat, Math.abs(point[1]));
  }

  // The ring bound must never overstate how far away a ring is, so use the
  // narrowest a cell gets anywhere in this dataset — longitude cells shrink
  // towards the poles — with one extra cell of headroom.
  const narrowestLon =
    cellDeg * KM_PER_DEG_LON * Math.max(0.05, Math.cos(((maxAbsLat + cellDeg) * Math.PI) / 180));
  const cellKm = Math.min(narrowestLon, cellDeg * KM_PER_DEG_LAT);

  return {
    nearest(from, accept, capKm) {
      const cx = Math.floor(from[0] / cellDeg);
      const cy = Math.floor(from[1] / cellDeg);
      let best = capKm;

      const maxRing = Math.ceil(capKm / cellKm) + 1;
      for (let ring = 0; ring <= maxRing; ring++) {
        // Anything in this ring is at least (ring - 1) cells away, so once that
        // exceeds what we have, no later ring can improve on it.
        if (ring > 0 && (ring - 1) * cellKm >= best) break;

        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            for (const item of buckets.get(`${cx + dx}:${cy + dy}`) ?? []) {
              if (!accept(item)) continue;
              const distance = haversineKm(from, at(item));
              if (distance < best) best = distance;
            }
          }
        }
      }
      return best;
    },
  };
}
