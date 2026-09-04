import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearOverrides,
  initialState,
  inclusionOf,
  isIncluded,
  isLocked,
  matchesFilter,
  padBox,
  questionCount,
  resolve,
  setKind,
  setRange,
  setSpacing,
  SPACING_NONE,
  toggleOverride,
} from './builder.ts';
import type { KindInfo, QuizFeature } from './types.ts';

const kinds: KindInfo[] = [
  {
    id: 'valley',
    label: 'Valleys',
    geometry: 'line',
    count: 0,
    cells: {},
    filters: [
      { key: 'lengthKm', label: 'Length', unit: 'km', min: 0, max: 40, step: 0.5, default: [3, 40] },
    ],
  },
  {
    id: 'peak',
    label: 'Mountains',
    geometry: 'point',
    count: 0,
    cells: {},
    defaultSpacingKm: 3,
    filters: [
      { key: 'flight', label: 'Flight proximity', unit: '', min: 0, max: 1, step: 0.01, default: [0.3, 1] },
      { key: 'prominence', label: 'Prominence', unit: '', min: 0, max: 1, step: 0.01, default: [0.6, 1] },
    ],
  },
];

function valley(id: string, name: string, lengthKm: number): QuizFeature {
  return {
    type: 'Feature',
    id,
    bbox: [11, 46, 11.1, 46.1],
    geometry: { type: 'LineString', coordinates: [[11, 46], [11.1, 46.1]] },
    properties: { name, kind: 'valley', lengthKm, anchor: [11.05, 46.05] },
  };
}

function peak(
  id: string,
  name: string,
  flight: number,
  prominence: number,
  at: [number, number] = [11, 46],
): QuizFeature {
  return {
    type: 'Feature',
    id,
    bbox: [at[0], at[1], at[0], at[1]],
    geometry: { type: 'Point', coordinates: at },
    properties: { name, kind: 'peak', lengthKm: 0, anchor: at, flight, prominence },
  };
}

test('a fresh builder turns every kind on at its default range', () => {
  const state = initialState(kinds);
  assert.deepEqual(state.kinds, { valley: true, peak: true });
  // Valleys carry no spacing default, so they are never thinned.
  assert.deepEqual(state.spacing, { peak: 3 });
  assert.deepEqual(state.ranges.valley, { lengthKm: [3, 40] });
  assert.deepEqual(state.ranges.peak, { flight: [0.3, 1], prominence: [0.6, 1] });
  assert.deepEqual(state.overrides, {});
});

test('the filter includes what is in range and excludes what is not', () => {
  const state = initialState(kinds);
  assert.equal(matchesFilter(valley('a', 'Long', 9), state), true);
  assert.equal(matchesFilter(valley('b', 'Short', 2), state), false);
  assert.equal(matchesFilter(peak('c', 'Flown and big', 0.9, 0.8), state), true);
  assert.equal(matchesFilter(peak('d', 'Bump', 0.04, 0.05), state), false);
});

test('the sliders add to each other rather than narrowing each other', () => {
  /*
   * The two groups a real selection is made of, and they do not overlap: a
   * mountain people fly which is nobody's landmark, and a landmark nobody
   * flies over. Intersecting the sliders can hold neither without floors low
   * enough to hold half the country as well.
   */
  const state = initialState(kinds);
  assert.equal(matchesFilter(peak('e', 'Busy shoulder', 0.95, 0.1), state), true);
  assert.equal(matchesFilter(peak('f', 'Quiet giant', 0.05, 0.95), state), true);
  // Neither slider wants it, so it stays out.
  assert.equal(matchesFilter(peak('g', 'Neither', 0.05, 0.1), state), false);
});

test('one slider at "none" leaves the other still choosing', () => {
  // What makes the two groups separable at all: turn off flight and what is
  // left is the landmarks, on their own.
  let state = initialState(kinds);
  state = setRange(state, 'peak', 'flight', [1.01, 1]);
  assert.equal(matchesFilter(peak('h', 'Busy bump', 0.95, 0.1), state), false);
  assert.equal(matchesFilter(peak('i', 'Quiet giant', 0.05, 0.95), state), true);
});

test('every slider at "none" selects nothing', () => {
  // The point of the stop is starting from an empty set and pinning a handful
  // in by hand, which a percentile could never do: its top bucket always held
  // something. Unioned, it takes both sliders to empty the set.
  let state = initialState(kinds);
  state = setRange(state, 'peak', 'flight', [1.01, 1]);
  state = setRange(state, 'peak', 'prominence', [1.01, 1]);
  assert.equal(matchesFilter(peak('j', 'The very best', 1, 1), state), false);
});

test('a hidden kind is excluded whatever its values say', () => {
  const state = setKind(initialState(kinds), 'valley', false);
  assert.equal(matchesFilter(valley('a', 'Long', 30), state), false);
  assert.equal(inclusionOf(valley('a', 'Long', 30), state), 'auto-out');
});

test('all four inclusion states are reachable', () => {
  let state = initialState(kinds);
  const long = valley('a', 'Long', 9);
  const short = valley('b', 'Short', 2);

  assert.equal(inclusionOf(long, state), 'auto-in');
  assert.equal(inclusionOf(short, state), 'auto-out');

  state = toggleOverride(state, long, matchesFilter(long, state));
  state = toggleOverride(state, short, matchesFilter(short, state));
  assert.equal(inclusionOf(long, state), 'locked-out');
  assert.equal(inclusionOf(short, state), 'locked-in');

  assert.deepEqual([long, short].map((f) => isIncluded(inclusionOf(f, state))), [false, true]);
  assert.deepEqual([long, short].map((f) => isLocked(inclusionOf(f, state))), [true, true]);
});

test('tapping locks the opposite of the filter, and tapping again resets', () => {
  const state = initialState(kinds);
  const short = valley('b', 'Short', 2); // the filter says out

  const locked = toggleOverride(state, short, matchesFilter(short, state));
  assert.equal(inclusionOf(short, locked), 'locked-in');

  const reset = toggleOverride(locked, short, matchesFilter(short, locked));
  assert.equal(inclusionOf(short, reset), 'auto-out');
  assert.deepEqual(reset.overrides, {}, 'the reset clears the entry, not just its value');
});

test('a lock survives a filter change that flips the filter verdict', () => {
  // The whole point: hand-pick a 2 km valley, then keep dragging the slider.
  let state = initialState(kinds);
  const short = valley('b', 'Short', 2);
  state = toggleOverride(state, short, matchesFilter(short, state));
  assert.equal(inclusionOf(short, state), 'locked-in');

  state = setRange(state, 'valley', 'lengthKm', [1, 40]); // now it would pass anyway
  assert.equal(isIncluded(inclusionOf(short, state)), true);

  state = setRange(state, 'valley', 'lengthKm', [10, 40]); // now far out of range
  assert.equal(inclusionOf(short, state), 'locked-in', 'still pinned in');
  assert.equal(isIncluded(inclusionOf(short, state)), true);
});

test('a feature locked out stays out however wide the filter opens', () => {
  let state = initialState(kinds);
  const long = valley('a', 'Long', 9);
  state = toggleOverride(state, long, matchesFilter(long, state));
  state = setRange(state, 'valley', 'lengthKm', [0, 40]);
  assert.equal(inclusionOf(long, state), 'locked-out');
  assert.equal(isIncluded(inclusionOf(long, state)), false);
});

test('clearing overrides hands every feature back to the filter', () => {
  let state = initialState(kinds);
  const short = valley('b', 'Short', 2);
  const long = valley('a', 'Long', 9);
  state = toggleOverride(state, short, matchesFilter(short, state));
  state = toggleOverride(state, long, matchesFilter(long, state));
  state = clearOverrides(state);
  assert.equal(inclusionOf(short, state), 'auto-out');
  assert.equal(inclusionOf(long, state), 'auto-in');
});

test('resolve returns the selection, its extent, and how much was hand-picked', () => {
  let state = initialState(kinds);
  const features = [
    valley('a', 'Long', 9),
    valley('b', 'Short', 2),
    peak('c', 'Famous', 0.9, 0.8),
    peak('d', 'Bump', 0.04, 0.05),
  ];
  // The tap pins to the opposite of what the selection is doing now.
  state = toggleOverride(state, features[1], false); // pin the short valley in
  state = toggleOverride(state, features[2], true); // pin the famous peak out

  const { included, bbox, lockedIn, lockedOut } = resolve(features, state);
  assert.deepEqual(included.map((f) => f.id), ['a', 'b']);
  assert.equal(lockedIn, 1);
  assert.equal(lockedOut, 1);
  assert.deepEqual(bbox, [11, 46, 11.1, 46.1]);
});

test('features standing on top of each other are thinned to the strongest', () => {
  // Two summits 150 m apart are one question: whichever name you would use.
  let state = initialState(kinds);
  state = setSpacing(state, 'peak', 2);
  const features = [
    peak('near', 'Shoulder', 0.8, 0.6, [11, 46]),
    peak('big', 'Summit', 0.9, 0.9, [11.002, 46]),
    peak('far', 'Next valley', 0.8, 0.6, [11.2, 46]),
  ];
  const { included, thinnedOut } = resolve(features, state);
  assert.deepEqual(included.map((f) => f.id), ['big', 'far']);
  assert.equal(thinnedOut, 1);
});

test('thinning off leaves the selection exactly as the sliders left it', () => {
  let state = setSpacing(initialState(kinds), 'peak', 0);
  const features = [
    peak('near', 'Shoulder', 0.8, 0.6, [11, 46]),
    peak('big', 'Summit', 0.9, 0.9, [11.002, 46]),
  ];
  const { included, thinnedOut } = resolve(features, state);
  assert.equal(included.length, 2);
  assert.equal(thinnedOut, 0);
});

test('valleys are never thinned, however close together they run', () => {
  // They carry no scores, so there is nothing to rank a cluster by — and two
  // valleys near each other are not the same question the way two summits on
  // one ridge are. A kind with no spacing simply never enters the pass.
  const state = setSpacing(initialState(kinds), 'valley', 8);
  const features = [valley('a', 'One', 9), valley('b', 'Two', 9)];
  const { included, thinnedOut } = resolve(features, state);
  assert.equal(included.length, 2);
  assert.equal(thinnedOut, 0);
});

test('a pinned feature survives the spacing that would have dropped it', () => {
  // What reopening a saved quiz leans on: the reconcile pass pins whatever the
  // thinned selection does not offer, and those pins have to hold.
  let state = setSpacing(initialState(kinds), 'peak', 5);
  const shoulder = peak('near', 'Shoulder', 0.5, 0.5, [11, 46]);
  const summit = peak('big', 'Summit', 0.9, 0.9, [11.002, 46]);
  assert.deepEqual(resolve([shoulder, summit], state).included.map((f) => f.id), ['big']);

  // Tapping what the spacing dropped pins it in, which is the whole point.
  state = toggleOverride(state, shoulder, false);
  const { included } = resolve([shoulder, summit], state);
  assert.deepEqual(new Set(included.map((f) => f.id)), new Set(['near', 'big']));
});

test('the top of the spacing scale asks about none of that kind', () => {
  // One control, the whole way: everything that qualifies at one end, nothing
  // at the other. Pins survive it, as they survive every other control here.
  let state = setSpacing(initialState(kinds), 'peak', SPACING_NONE);
  const summit = peak('big', 'Summit', 0.9, 0.9, [11, 46]);
  const valle = valley('v', 'A valley', 9);
  assert.deepEqual(resolve([summit, valle], state).included.map((f) => f.id), ['v']);

  state = toggleOverride(state, summit, false);
  assert.deepEqual(
    new Set(resolve([summit, valle], state).included.map((f) => f.id)),
    new Set(['v', 'big']),
  );
});

test('one kind is thinned without touching another', () => {
  const state = setSpacing(initialState(kinds), 'peak', 4);
  const features = [
    peak('near', 'Shoulder', 0.8, 0.6, [11, 46]),
    peak('big', 'Summit', 0.9, 0.9, [11.002, 46]),
    valley('v1', 'One', 9),
    valley('v2', 'Two', 9),
  ];
  const { included } = resolve(features, state);
  assert.deepEqual(included.map((f) => f.id), ['big', 'v1', 'v2']);
});

test('the extent is measured after thinning, not before', () => {
  // The frame has to cover what is actually asked. A thinned outlier that still
  // stretched the bbox would open the quiz on ground it never asks about.
  let state = setSpacing(initialState(kinds), 'peak', 3);
  const features = [
    peak('big', 'Summit', 0.9, 0.9, [11, 46]),
    peak('near', 'Shoulder', 0.8, 0.6, [11.01, 46.01]),
  ];
  const { bbox } = resolve(features, state);
  assert.deepEqual(bbox, [11, 46, 11, 46]);
});

test('the extent covers exactly the included features, not the excluded ones', () => {
  const state = initialState(kinds);
  const near = valley('a', 'Near', 9);
  const far: QuizFeature = {
    ...valley('b', 'Far', 2), // 2 km, so the filter leaves it out
    bbox: [20, 50, 21, 51],
  };
  const { bbox } = resolve([near, far], state);
  assert.deepEqual(bbox, [11, 46, 11.1, 46.1], 'the far excluded feature must not stretch it');
});

test('resolve reports no extent when nothing is selected', () => {
  const state = setKind(setKind(initialState(kinds), 'valley', false), 'peak', false);
  const { included, bbox } = resolve([valley('a', 'Long', 9)], state);
  assert.deepEqual(included, []);
  assert.equal(bbox, null);
});

test('features sharing a name count as one question', () => {
  const features = [
    valley('a', 'Valsorda', 9),
    valley('b', 'valsorda ', 9), // same name, different case and spacing
    valley('c', 'Val di Sole', 9),
  ];
  assert.equal(questionCount(features), 2);
});

test('padding grows a box, and still opens up a zero-size one', () => {
  assert.deepEqual(padBox([10, 46, 11, 47], 0.1, 0.01), [9.9, 45.9, 11.1, 47.1]);
  const point = padBox([11, 46, 11, 46], 0.1, 0.01);
  assert.deepEqual(point, [10.99, 45.99, 11.01, 46.01], 'a single point still gets an extent');
});
