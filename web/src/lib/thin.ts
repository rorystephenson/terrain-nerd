/**
 * Keeping one voice per cluster.
 *
 * The score sliders judge each feature on its own, which is the one thing they
 * cannot fix about a massif: ten summits that are all prominent and all flown
 * are not ten questions, because nobody names more than one or two of them to
 * say where they went. Meanwhile a modest mountain alone at the end of a ridge
 * is worth asking about precisely because there is nothing else to call it.
 *
 * So this is a spacing pass, greedy and strongest-first — the same shape as
 * `placeZoom.ts`'s label thinning, which is the repo's existing answer to
 * exactly this question about a different kind of clutter.
 *
 * Pure, and free of `QuizFeature`: it takes whatever carries the four things it
 * needs, so the caller keeps hold of its own objects and this stays testable
 * with four-line fixtures.
 */

/** [lon, lat], GeoJSON order, matching the rest of the codebase. */
export type LonLat = [number, number];

export type Spaced = {
  /**
   * Stable and globally unique.
   *
   * The final tiebreak, and the whole reason the answer does not depend on the
   * order features happened to arrive in — the same role the OSM id plays in
   * `placeZoom.ts`'s `compareImportance`.
   */
  id: string;
  /** A feature only ever competes with its own kind. */
  kind: string;
  at: LonLat;
  strength: number;
  /**
   * Pinned in by hand.
   *
   * Kept whatever the spacing says — a pin is a decision already made, and
   * everywhere else in the builder it survives whatever the filters say.
   *
   * It takes no ground of its own, though: adding something by hand must not
   * quietly remove something else. That is not only surprising, it would break
   * reopening a saved quiz, where every feature the spacing dropped is pinned
   * back in — each of those pins would then crowd out a neighbour that had no
   * pin of its own, and the reopened quiz would lose features a second way.
   */
  locked: boolean;
};

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Matches `pipeline/src/geo.ts`, pinned by a test — `web/src/lib` has no copy. */
export function haversineKm(a: LonLat, b: LonLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON = 111.32;

/**
 * Strongest first, then by id so the order is total.
 *
 * Without the second term the answer would depend on the order the chunks
 * happened to load in, and dragging a slider back and forth could return a
 * different set than it started with.
 */
const strongestFirst = (a: Spaced, b: Spaced): number =>
  b.strength - a.strength || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Drops anything standing too close to something already kept.
 *
 * Greedy against what has been *kept*, not against anything stronger that
 * exists: the other reading drops a feature because of a neighbour that was
 * itself dropped, which does not leave a properly separated set behind.
 *
 * Runs on every slider tick, and the candidate set is at its largest exactly
 * when the score sliders are at zero — so the kept set goes into a bucket grid
 * sized to the spacing rather than being scanned pairwise. Cells are at least
 * `spacingKm` across on both axes, which is what makes the surrounding eight
 * enough to look at: nothing within the spacing can be further away than that.
 */
export function thin<T extends Spaced>(items: readonly T[], spacingKm: number): T[] {
  if (spacingKm <= 0 || items.length === 0) return [...items];

  let maxAbsLat = 0;
  for (const item of items) maxAbsLat = Math.max(maxAbsLat, Math.abs(item.at[1]));
  // Longitude cells shrink towards the poles, so size against the narrowest one
  // in this set — overshooting costs a distance test, undershooting misses a hit.
  const cosLat = Math.max(0.05, Math.cos(toRad(maxAbsLat)));
  const cellDeg = Math.max(
    spacingKm / KM_PER_DEG_LAT,
    spacingKm / (KM_PER_DEG_LON * cosLat),
  );

  // Keyed by kind as well as position, so a pass can never crowd out the peak
  // above it: they are two different questions about the same col.
  const buckets = new Map<string, T[]>();
  const cellOf = (item: Spaced) =>
    `${item.kind}:${Math.floor(item.at[0] / cellDeg)}:${Math.floor(item.at[1] / cellDeg)}`;

  const keep = (item: T) => {
    const key = cellOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  };

  const crowded = (item: T): boolean => {
    const ix = Math.floor(item.at[0] / cellDeg);
    const iy = Math.floor(item.at[1] / cellDeg);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of buckets.get(`${item.kind}:${ix + dx}:${iy + dy}`) ?? []) {
          if (haversineKm(item.at, other.at) < spacingKm) return true;
        }
      }
    }
    return false;
  };

  const kept: T[] = [];
  for (const item of [...items].sort(strongestFirst)) {
    // A pin is kept without being asked, and without being added to the grid:
    // it is an exception to the spacing, not a competitor in it.
    if (item.locked) {
      kept.push(item);
      continue;
    }
    if (crowded(item)) continue;
    keep(item);
    kept.push(item);
  }

  // Back into the order they came in: the caller's list is what the map draws,
  // and reordering it would reshuffle the whole selection on every drag.
  const survivors = new Set(kept.map((item) => item.id));
  return items.filter((item) => survivors.has(item.id));
}
