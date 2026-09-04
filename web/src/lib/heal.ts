/**
 * Filling in what an older quiz did not know about its own features.
 *
 * A quiz saved before `FeatureRef` existed holds ids and nothing else, so it
 * has no name or anchor to fall back on when one of those ids moves — which is
 * exactly the quiz most likely to need one. It cannot be repaired by a
 * migration, because the names and anchors are not in localStorage; they are in
 * the pool, and the pool is only fetched when a quiz is played.
 *
 * So playing is what repairs it. Every round already loads every feature the
 * quiz refers to, which is precisely the information the refs are missing.
 *
 * A repaired reference also adopts the id it actually resolved to, so a
 * fallback match is paid for once rather than on every round.
 */
import type { Resolution } from './resolve.ts';
import type { FeatureRef, QuizSpec } from './types.ts';

const sameRef = (a: FeatureRef, b: FeatureRef): boolean =>
  a.id === b.id && a.name === b.name && a.wikidata === b.wikidata &&
  a.at?.[0] === b.at?.[0] && a.at?.[1] === b.at?.[1];

/**
 * The quiz as it should now be recorded, or the quiz unchanged.
 *
 * Returns the *same object* when nothing was learnt, so the caller can skip the
 * write with an identity check rather than a deep comparison — a round that
 * taught us nothing should not touch storage at all.
 *
 * Refs that went missing are left exactly as they were. They are not wrong,
 * they are unanswered, and dropping them would silently shrink the quiz — which
 * is the behaviour this whole path exists to stop.
 */
export function healSpec(spec: QuizSpec, resolution: Resolution): QuizSpec {
  const learnt = new Map<string, FeatureRef>();
  for (const { ref, feature } of resolution.matched) {
    const { name, kind, anchor, wikidata } = feature.properties;
    learnt.set(ref.id, {
      id: feature.id,
      kind,
      name,
      at: anchor,
      ...(wikidata ? { wikidata } : {}),
    });
  }

  let changed = false;
  const features = spec.features.map((ref) => {
    const fresh = learnt.get(ref.id);
    if (!fresh || sameRef(ref, fresh)) return ref;
    changed = true;
    return fresh;
  });

  return changed ? { ...spec, features } : spec;
}
