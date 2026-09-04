/**
 * The rules behind the quiz builder — deliberately free of MapLibre and DOM
 * references, the same way `quiz.ts` is, so all of it is directly testable.
 */
import { thin } from './thin.ts';
import type {
  BuilderState,
  FilterSpec,
  Inclusion,
  KindInfo,
  QuizFeature,
} from './types.ts';

export const isIncluded = (inclusion: Inclusion): boolean =>
  inclusion === 'auto-in' || inclusion === 'locked-in';

export const isLocked = (inclusion: Inclusion): boolean =>
  inclusion === 'locked-in' || inclusion === 'locked-out';

/** The widest real spacing the slider offers, and the step it moves in. */
export const MAX_SPACING_KM = 12;
export const SPACING_STEP = 0.5;

/**
 * One step past the top, where the kind is asked about at all.
 *
 * The same trick the score sliders use for their "none": rather than a separate
 * switch, the one control runs the whole way from every feature that qualifies
 * to none of them.
 */
export const SPACING_NONE = MAX_SPACING_KM + SPACING_STEP;

/** The starting point for a fresh builder: every kind on, at its default range. */
export function initialState(kinds: KindInfo[]): BuilderState {
  const state: BuilderState = { kinds: {}, ranges: {}, overrides: {}, spacing: {} };
  for (const kind of kinds) {
    state.kinds[kind.id] = true;
    state.ranges[kind.id] = Object.fromEntries(
      kind.filters.map((filter) => [filter.key, [...filter.default] as [number, number]]),
    );
    if (kind.defaultSpacingKm !== undefined) {
      state.spacing![kind.id] = kind.defaultSpacingKm;
    }
  }
  return state;
}

const valueOf = (feature: QuizFeature, key: FilterSpec['key']): number => {
  if (key === 'flight') return feature.properties.flight ?? 0;
  if (key === 'prominence') return feature.properties.prominence ?? 0;
  return feature.properties.lengthKm;
};

/**
 * Whether the sliders alone would include this feature.
 *
 * **The sliders union, they do not intersect.** Each one adds the features it
 * admits; a feature is in if any slider wants it. That is the difference
 * between two questions you can ask together — "the ones people fly, plus the
 * landmarks" — and one question that gets narrower with every slider you touch.
 *
 * It is not a preference. Intersecting cannot express a real selection at all:
 * over the Adamello, Brenta and Ledro, a hand-picked set of twelve splits into
 * six that are flown (Monte Stivo, Doss del Sabion, Cima Lancia...) and six
 * that are landmarks nobody flies over (Adamello, Presanella, Cima Brenta...),
 * and the two groups do not overlap. Intersecting needs floors low enough to
 * admit 575 peaks before it holds all twelve. Unioning holds ten in 55.
 *
 * A kind with one slider is unaffected either way, which is every other kind.
 *
 * Never consults the overrides — that separation is what lets a pinned feature
 * survive any amount of slider dragging.
 */
export function matchesFilter(feature: QuizFeature, state: BuilderState): boolean {
  const kind = feature.properties.kind;
  if (!state.kinds[kind]) return false;

  const ranges = Object.entries(state.ranges[kind] ?? {});
  // No sliders is not the same question as no slider wanting it.
  if (ranges.length === 0) return true;

  for (const [key, [min, max]] of ranges) {
    const value = valueOf(feature, key as FilterSpec['key']);
    if (value >= min && value <= max) return true;
  }
  return false;
}

export function inclusionOf(feature: QuizFeature, state: BuilderState): Inclusion {
  const override = state.overrides[feature.id];
  if (override) return override === 'in' ? 'locked-in' : 'locked-out';
  return matchesFilter(feature, state) ? 'auto-in' : 'auto-out';
}

/**
 * What the map should draw for each feature, given the selection that resolved.
 *
 * Not `inclusionOf`, which answers about the sliders alone. A feature the
 * sliders admit and the spacing then drops is not in the quiz, and drawing it as
 * though it were makes the panel's count disagree with the map — the one thing
 * a selection tool cannot do.
 */
export function shadeOf(
  features: readonly QuizFeature[],
  state: BuilderState,
  resolved: Resolved,
): Record<string, Inclusion> {
  const included = new Set(resolved.included.map((feature) => feature.id));
  const out: Record<string, Inclusion> = {};
  for (const feature of features) {
    const override = state.overrides[feature.id];
    if (override) out[feature.id] = override === 'in' ? 'locked-in' : 'locked-out';
    else out[feature.id] = included.has(feature.id) ? 'auto-in' : 'auto-out';
  }
  return out;
}

/**
 * One tap on a feature.
 *
 * A locked feature unlocks, going back to following the filter; an unlocked one
 * locks to the opposite of what it is doing now. So the second tap is always the
 * reset, and no menu is needed to reach the third state.
 *
 * `offered` is what the selection currently *does* with the feature, not what
 * the sliders say about it, and the two stopped being the same thing when the
 * spacing pass arrived: a feature the sliders admit but the spacing drops is
 * drawn excluded, so a tap on it has to mean "pin it in". Reading `matchesFilter`
 * here instead would pin it out — locking in the state the user is looking at
 * and trying to change.
 */
export function toggleOverride(
  state: BuilderState,
  feature: QuizFeature,
  offered: boolean,
): BuilderState {
  const overrides = { ...state.overrides };
  if (overrides[feature.id]) delete overrides[feature.id];
  else overrides[feature.id] = offered ? 'out' : 'in';
  return { ...state, overrides };
}

export function clearOverrides(state: BuilderState): BuilderState {
  return { ...state, overrides: {} };
}

/** Features of a hidden kind are not shown at all, so their locks are dead weight. */
export function setKind(state: BuilderState, kind: string, on: boolean): BuilderState {
  return { ...state, kinds: { ...state.kinds, [kind]: on } };
}

export function setSpacing(state: BuilderState, kind: string, spacingKm: number): BuilderState {
  return { ...state, spacing: { ...state.spacing, [kind]: spacingKm } };
}

/** Every kind back to showing everything that qualifies. Used when reopening. */
export function clearSpacing(state: BuilderState): BuilderState {
  return { ...state, spacing: {} };
}

export function setRange(
  state: BuilderState,
  kind: string,
  key: string,
  range: [number, number],
): BuilderState {
  return {
    ...state,
    ranges: { ...state.ranges, [kind]: { ...state.ranges[kind], [key]: range } },
  };
}

export type Resolved = {
  included: QuizFeature[];
  /** Covers exactly the included features, or null when nothing is chosen. */
  bbox: [number, number, number, number] | null;
  lockedIn: number;
  lockedOut: number;
  /** Admitted by the sliders, then dropped for standing too close to something better. */
  thinnedOut: number;
};

/** How a feature ranks against its neighbours when only one of them can be asked. */
const strengthOf = (feature: QuizFeature): number =>
  Math.max(feature.properties.flight ?? 0, feature.properties.prominence ?? 0);

/**
 * Whichever score is higher, which is the same reading as the two that admit it:
 * they union, so a feature is as strong as its best claim to being in at all.
 */
const isScored = (feature: QuizFeature): boolean =>
  feature.properties.flight !== undefined || feature.properties.prominence !== undefined;

/**
 * The current selection, and the extent the saved quiz will frame to.
 *
 * The bbox comes from the chosen features rather than the builder viewport, so
 * however the map happened to be positioned while building, the quiz frames
 * itself sensibly.
 */
export function resolve(features: readonly QuizFeature[], state: BuilderState): Resolved {
  const admitted: QuizFeature[] = [];
  let lockedIn = 0;
  let lockedOut = 0;

  for (const feature of features) {
    const inclusion = inclusionOf(feature, state);
    if (inclusion === 'locked-in') lockedIn++;
    if (inclusion === 'locked-out') lockedOut++;
    if (isIncluded(inclusion)) admitted.push(feature);
  }

  const included = space(admitted, state);

  // After thinning, not before: the extent has to cover what is actually asked,
  // and dropping an outlier should pull the frame in with it.
  let box: [number, number, number, number] | null = null;
  for (const feature of included) {
    const [w, s, e, n] = feature.bbox;
    box = box
      ? [Math.min(box[0], w), Math.min(box[1], s), Math.max(box[2], e), Math.max(box[3], n)]
      : [w, s, e, n];
  }

  return {
    included,
    bbox: box,
    lockedIn,
    lockedOut,
    thinnedOut: admitted.length - included.length,
  };
}

/**
 * The spacing pass, per kind. See `thin.ts`.
 *
 * A kind with no spacing set is never thinned, which is how valleys stay out of
 * it — they carry no scores to rank a cluster by, and two valleys near each
 * other are not the same question the way two summits on one ridge are.
 *
 * At the top of the scale the kind drops out entirely, pins aside. Pins survive
 * every other control here and survive this one too.
 */
function space(admitted: readonly QuizFeature[], state: BuilderState): QuizFeature[] {
  const spacing = state.spacing ?? {};
  const thinned = Object.keys(spacing).filter((kind) => (spacing[kind] ?? 0) > 0);
  if (thinned.length === 0) return [...admitted];

  const survived = new Set<string>();
  for (const kind of thinned) {
    const km = spacing[kind];
    /*
     * Scored features only, and the kind is skipped outright if it has none.
     * A kind with no scores has nothing to rank a cluster by, so thinning it
     * would come down to the id tiebreak — an arbitrary answer wearing the
     * clothes of a considered one. Valleys are the case; they get no spacing
     * default and so no control, and this is the belt to that pair of braces.
     */
    const mine = admitted.filter(
      (feature) => feature.properties.kind === kind && isScored(feature),
    );
    if (mine.length === 0) continue;
    const pinned = mine.filter((feature) => state.overrides[feature.id] === 'in');
    if (km >= SPACING_NONE) {
      for (const feature of pinned) survived.add(feature.id);
      continue;
    }
    for (const item of thin(
      mine.map((feature) => ({
        id: feature.id,
        kind,
        at: feature.properties.anchor,
        strength: strengthOf(feature),
        locked: state.overrides[feature.id] === 'in',
      })),
      km,
    )) {
      survived.add(item.id);
    }
  }

  return admitted.filter(
    (feature) =>
      !isScored(feature) ||
      !thinned.includes(feature.properties.kind) ||
      survived.has(feature.id),
  );
}

/**
 * How many questions the quiz will actually ask.
 *
 * Features sharing a name are asked once, because the player has no way to tell
 * which of two identically-named valleys is meant — the same rule `createQuiz`
 * applies when it builds the round.
 */
export function questionCount(features: readonly QuizFeature[]): number {
  return new Set(features.map((f) => f.properties.name.trim().toLowerCase().replace(/\s+/g, ' ')))
    .size;
}

/** Pads a bbox by a fraction of its own size, with a floor for tiny selections. */
export function padBox(
  box: [number, number, number, number],
  fraction = 0.08,
  minDeg = 0.01,
): [number, number, number, number] {
  const lon = Math.max((box[2] - box[0]) * fraction, minDeg);
  const lat = Math.max((box[3] - box[1]) * fraction, minDeg);
  return [box[0] - lon, box[1] - lat, box[2] + lon, box[3] + lat];
}
