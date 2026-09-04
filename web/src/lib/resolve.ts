/**
 * Finding the features a saved quiz refers to, when their ids have moved.
 *
 * A quiz is a list of references into a pool that is rebuilt from OSM. Most of
 * the time an id still names the same feature and there is nothing to do. But
 * ways get deleted, retagged and re-drawn, and a valley's segments can cluster
 * differently between builds — so some fraction of a shared quiz's ids will,
 * eventually, point at nothing.
 *
 * The old behaviour was to drop those silently: `loadByIds` did
 * `byId.get(id) ?? []` and the round simply had fewer questions in it. That is
 * the worst of the available options, because the score still reads as a
 * percentage of a quiz and no longer means what it used to.
 *
 * So: try the id, then the wikidata entity, then the name and where it stands —
 * and say plainly what could not be found either way.
 */
import { haversineKm } from './thin.ts';
import type { FeatureRef, KindId, QuizFeature } from './types.ts';

/** Matches `createQuiz`: two spellings of one name are one name. */
const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * How far a feature is allowed to have moved and still be the same feature.
 *
 * Points are single OSM nodes: if one is re-surveyed it shifts by metres, so a
 * generous couple of kilometres is already far more slack than it needs, and
 * anything wider starts admitting the next summit along.
 *
 * Valleys need an order of magnitude more, and not because the ground moved. A
 * valley's anchor is the midpoint of its longest part, so it slides whenever the
 * cluster gains or loses a segment — which is the same event that moved the id
 * in the first place. A tight radius would fail exactly the kind that needs
 * rescuing most.
 */
const RESCUE_KM: Record<KindId, number> = { peak: 2, pass: 2, valley: 10 };

/** One reference and the feature it turned out to mean. */
export type Match = {
  ref: FeatureRef;
  feature: QuizFeature;
  /** What found it. Anything but `id` means the reference had gone stale. */
  by: 'id' | 'wikidata' | 'name';
};

export type Resolution = {
  /** In the quiz's own order, so a round is built from exactly what was found. */
  matched: Match[];
  /** Refs the pool has no answer for. These are genuinely gone. */
  missing: FeatureRef[];
};

/** What a round is actually built from. */
export const matchedFeatures = (resolution: Resolution): QuizFeature[] =>
  resolution.matched.map((match) => match.feature);

/** The matches that needed a fallback — worth telling the owner about. */
export const repairs = (resolution: Resolution): Match[] =>
  resolution.matched.filter((match) => match.by !== 'id');

/**
 * Matches a quiz's references against the features the pool actually holds.
 *
 * `pool` is everything `loadArea` returned for the quiz's bbox — which the
 * caller already has, so the repair costs no extra network.
 *
 * No pool feature is ever handed to two references. Without that, a quiz
 * holding two segments of a valley that have since merged would ask about the
 * same feature twice under two names, and the second could never be answered.
 */
export function resolveFeatures(
  pool: readonly QuizFeature[],
  wanted: readonly FeatureRef[],
): Resolution {
  const byId = new Map(pool.map((feature) => [feature.id, feature]));
  const claimed = new Set<string>();

  const byWikidata = new Map<string, QuizFeature[]>();
  const byName = new Map<string, QuizFeature[]>();
  for (const feature of pool) {
    const { wikidata, kind, name } = feature.properties;
    if (wikidata) push(byWikidata, `${kind}/${wikidata}`, feature);
    push(byName, `${kind}/${normalizeName(name)}`, feature);
  }

  const matched: Match[] = [];
  const missing: FeatureRef[] = [];

  // Exact ids first, all of them, before any fallback runs. Otherwise a ref
  // rescued by name could claim the feature that a later ref names outright.
  const exact = new Map<FeatureRef, QuizFeature>();
  for (const ref of wanted) {
    const hit = byId.get(ref.id);
    if (hit && !claimed.has(hit.id)) {
      exact.set(ref, hit);
      claimed.add(hit.id);
    }
  }

  for (const ref of wanted) {
    const direct = exact.get(ref);
    if (direct) {
      matched.push({ ref, feature: direct, by: 'id' });
      continue;
    }

    // A wikidata match is not bounded by distance: it is the same entity
    // wherever the geometry has since been redrawn.
    const entity = ref.wikidata
      ? pick(byWikidata.get(`${ref.kind}/${ref.wikidata}`), ref, claimed, Infinity)
      : null;
    if (entity) {
      claimed.add(entity.id);
      matched.push({ ref, feature: entity, by: 'wikidata' });
      continue;
    }

    const named = ref.name
      ? pick(byName.get(`${ref.kind}/${normalizeName(ref.name)}`), ref, claimed, RESCUE_KM[ref.kind])
      : null;
    if (named) {
      claimed.add(named.id);
      matched.push({ ref, feature: named, by: 'name' });
      continue;
    }

    missing.push(ref);
  }

  return { matched, missing };
}

function push(map: Map<string, QuizFeature[]>, key: string, feature: QuizFeature): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(feature);
  else map.set(key, [feature]);
}

/**
 * The nearest unclaimed candidate within reach, or nothing.
 *
 * A ref with no `at` — one saved before quizzes carried anchors — cannot judge
 * distance, so it takes the only candidate when there is exactly one and
 * declines to guess when there are several. Picking arbitrarily between two
 * Valsordas would be worse than admitting the quiz cannot say which it meant.
 */
function pick(
  candidates: QuizFeature[] | undefined,
  ref: FeatureRef,
  claimed: Set<string>,
  withinKm: number,
): QuizFeature | null {
  const open = (candidates ?? []).filter((feature) => !claimed.has(feature.id));
  if (open.length === 0) return null;
  if (!ref.at) return open.length === 1 ? open[0] : null;

  let best: QuizFeature | null = null;
  let bestKm = Infinity;
  for (const feature of open) {
    const km = haversineKm(ref.at, feature.properties.anchor);
    if (km < bestKm) {
      best = feature;
      bestKm = km;
    }
  }
  return bestKm <= withinKm ? best : null;
}
