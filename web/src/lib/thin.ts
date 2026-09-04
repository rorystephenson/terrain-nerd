/**
 * Keeping one voice per cluster.
 *
 * The score sliders judge each feature on its own, which is the one thing they
 * cannot fix about a massif: ten summits that are all prominent and all flown
 * are not ten questions, because nobody names more than one or two of them to
 * say where they went. Meanwhile a modest mountain alone at the end of a ridge
 * is worth asking about precisely because there is nothing else to call it.
 *
 * The rule is one line: **keep a feature when nothing stronger stands within the
 * spacing of it.** So a summit survives by being the best thing in its own
 * neighbourhood, which is what "the one you would name" means.
 *
 * This started out greedy instead — admit strongest first, drop anything too
 * close to something *already admitted* — and that was wrong in a way only
 * dragging the slider shows. Whether a feature is dropped then depends on which
 * of its neighbours happened to survive, so widening the spacing can rescue it:
 * take three on a line, strong at 0 km, middle at 3, weak at 5. At 2 km the weak
 * one is crowded by the middle one and goes. At 3.5 km the middle one is itself
 * crowded out by the strong one, which frees the weak one to come back — and it
 * goes again at 5. A feature flickering in and out as the slider moves in one
 * direction is not a spacing control, it is a cascade.
 *
 * Comparing against every candidate rather than against the survivors takes the
 * ordering out of it entirely: each feature has one distance to the nearest
 * thing stronger than it, and the slider is a floor on that number. Widening it
 * can only ever remove. It is the same move `placeZoom.ts` makes for labels —
 * decide per feature, offline of any ordering, so there is nothing to cascade —
 * and the same quantity `scores.ts` already calls isolation, measured in
 * strength rather than in height.
 *
 * The set that comes back is still properly separated, which is not obvious:
 * if two kept features were closer than the spacing, the weaker of them would
 * have the stronger one within the spacing, so it would not have been kept.
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
 * Keeps every feature that nothing stronger stands within `spacingKm` of.
 *
 * Runs on every slider tick, and the candidate set is at its largest exactly
 * when the score sliders are at zero — so the candidates go into a bucket grid
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

  /*
   * Every candidate that can crowd another goes in, survivor or not — that is
   * what makes the answer independent of any ordering, and so monotone in the
   * spacing.
   *
   * A pin is left out. It is kept whatever the spacing says and it takes no
   * ground, so it is neither subject to the rule nor part of it.
   *
   * Keyed by kind as well as position, so a pass can never crowd out the peak
   * above it: they are two different questions about the same col.
   */
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    if (item.locked) continue;
    const key = `${item.kind}:${Math.floor(item.at[0] / cellDeg)}:${Math.floor(item.at[1] / cellDeg)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const outranked = (item: T): boolean => {
    const ix = Math.floor(item.at[0] / cellDeg);
    const iy = Math.floor(item.at[1] / cellDeg);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of buckets.get(`${item.kind}:${ix + dx}:${iy + dy}`) ?? []) {
          // Strictly stronger by the total order, which is also what rules out
          // comparing a feature with itself.
          if (strongestFirst(other, item) >= 0) continue;
          if (haversineKm(item.at, other.at) < spacingKm) return true;
        }
      }
    }
    return false;
  };

  // Filtered in place, so what comes back is in the order it went in: the
  // caller's list is what the map draws, and reordering it would reshuffle the
  // whole selection on every drag of the slider.
  return items.filter((item) => item.locked || !outranked(item));
}
