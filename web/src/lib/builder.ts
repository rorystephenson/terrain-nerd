/**
 * The rules behind the quiz builder — deliberately free of MapLibre and DOM
 * references, the same way `quiz.ts` is, so all of it is directly testable.
 */
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

/** The starting point for a fresh builder: every kind on, at its default range. */
export function initialState(kinds: KindInfo[]): BuilderState {
  const state: BuilderState = { kinds: {}, ranges: {}, overrides: {} };
  for (const kind of kinds) {
    state.kinds[kind.id] = true;
    state.ranges[kind.id] = Object.fromEntries(
      kind.filters.map((filter) => [filter.key, [...filter.default] as [number, number]]),
    );
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
 * Never consults the overrides — that separation is what lets a pinned feature
 * survive any amount of slider dragging.
 */
export function matchesFilter(feature: QuizFeature, state: BuilderState): boolean {
  const kind = feature.properties.kind;
  if (!state.kinds[kind]) return false;

  for (const [key, [min, max]] of Object.entries(state.ranges[kind] ?? {})) {
    const value = valueOf(feature, key as FilterSpec['key']);
    if (value < min || value > max) return false;
  }
  return true;
}

export function inclusionOf(feature: QuizFeature, state: BuilderState): Inclusion {
  const override = state.overrides[feature.id];
  if (override) return override === 'in' ? 'locked-in' : 'locked-out';
  return matchesFilter(feature, state) ? 'auto-in' : 'auto-out';
}

/**
 * One tap on a feature.
 *
 * A locked feature unlocks, going back to following the filter; an unlocked one
 * locks to the opposite of the filter's current verdict. So the second tap is
 * always the reset, and no menu is needed to reach the third state.
 */
export function toggleOverride(state: BuilderState, feature: QuizFeature): BuilderState {
  const overrides = { ...state.overrides };
  if (overrides[feature.id]) delete overrides[feature.id];
  else overrides[feature.id] = matchesFilter(feature, state) ? 'out' : 'in';
  return { ...state, overrides };
}

export function clearOverrides(state: BuilderState): BuilderState {
  return { ...state, overrides: {} };
}

/** Features of a hidden kind are not shown at all, so their locks are dead weight. */
export function setKind(state: BuilderState, kind: string, on: boolean): BuilderState {
  return { ...state, kinds: { ...state.kinds, [kind]: on } };
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
};

/**
 * The current selection, and the extent the saved quiz will frame to.
 *
 * The bbox comes from the chosen features rather than the builder viewport, so
 * however the map happened to be positioned while building, the quiz frames
 * itself sensibly.
 */
export function resolve(features: readonly QuizFeature[], state: BuilderState): Resolved {
  const included: QuizFeature[] = [];
  let lockedIn = 0;
  let lockedOut = 0;
  let box: [number, number, number, number] | null = null;

  for (const feature of features) {
    const inclusion = inclusionOf(feature, state);
    if (inclusion === 'locked-in') lockedIn++;
    if (inclusion === 'locked-out') lockedOut++;
    if (!isIncluded(inclusion)) continue;

    included.push(feature);
    const [w, s, e, n] = feature.bbox;
    box = box
      ? [Math.min(box[0], w), Math.min(box[1], s), Math.max(box[2], e), Math.max(box[3], n)]
      : [w, s, e, n];
  }

  return { included, bbox: box, lockedIn, lockedOut };
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
