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
    filters: [
      { key: 'popularity', label: 'Popularity', unit: '', min: 0, max: 100, step: 1, default: [60, 100] },
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

function peak(id: string, name: string, popularity: number): QuizFeature {
  return {
    type: 'Feature',
    id,
    bbox: [11, 46, 11, 46],
    geometry: { type: 'Point', coordinates: [11, 46] },
    properties: { name, kind: 'peak', lengthKm: 0, anchor: [11, 46], popularity },
  };
}

test('a fresh builder turns every kind on at its default range', () => {
  const state = initialState(kinds);
  assert.deepEqual(state.kinds, { valley: true, peak: true });
  assert.deepEqual(state.ranges.valley, { lengthKm: [3, 40] });
  assert.deepEqual(state.ranges.peak, { popularity: [60, 100] });
  assert.deepEqual(state.overrides, {});
});

test('the filter includes what is in range and excludes what is not', () => {
  const state = initialState(kinds);
  assert.equal(matchesFilter(valley('a', 'Long', 9), state), true);
  assert.equal(matchesFilter(valley('b', 'Short', 2), state), false);
  assert.equal(matchesFilter(peak('c', 'Famous', 95), state), true);
  assert.equal(matchesFilter(peak('d', 'Bump', 4), state), false);
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

  state = toggleOverride(state, long);
  state = toggleOverride(state, short);
  assert.equal(inclusionOf(long, state), 'locked-out');
  assert.equal(inclusionOf(short, state), 'locked-in');

  assert.deepEqual([long, short].map((f) => isIncluded(inclusionOf(f, state))), [false, true]);
  assert.deepEqual([long, short].map((f) => isLocked(inclusionOf(f, state))), [true, true]);
});

test('tapping locks the opposite of the filter, and tapping again resets', () => {
  const state = initialState(kinds);
  const short = valley('b', 'Short', 2); // the filter says out

  const locked = toggleOverride(state, short);
  assert.equal(inclusionOf(short, locked), 'locked-in');

  const reset = toggleOverride(locked, short);
  assert.equal(inclusionOf(short, reset), 'auto-out');
  assert.deepEqual(reset.overrides, {}, 'the reset clears the entry, not just its value');
});

test('a lock survives a filter change that flips the filter verdict', () => {
  // The whole point: hand-pick a 2 km valley, then keep dragging the slider.
  let state = initialState(kinds);
  const short = valley('b', 'Short', 2);
  state = toggleOverride(state, short);
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
  state = toggleOverride(state, long);
  state = setRange(state, 'valley', 'lengthKm', [0, 40]);
  assert.equal(inclusionOf(long, state), 'locked-out');
  assert.equal(isIncluded(inclusionOf(long, state)), false);
});

test('clearing overrides hands every feature back to the filter', () => {
  let state = initialState(kinds);
  const short = valley('b', 'Short', 2);
  const long = valley('a', 'Long', 9);
  state = toggleOverride(toggleOverride(state, short), long);
  state = clearOverrides(state);
  assert.equal(inclusionOf(short, state), 'auto-out');
  assert.equal(inclusionOf(long, state), 'auto-in');
});

test('resolve returns the selection, its extent, and how much was hand-picked', () => {
  let state = initialState(kinds);
  const features = [
    valley('a', 'Long', 9),
    valley('b', 'Short', 2),
    peak('c', 'Famous', 95),
    peak('d', 'Bump', 4),
  ];
  state = toggleOverride(state, features[1]); // pin the short valley in
  state = toggleOverride(state, features[2]); // pin the famous peak out

  const { included, bbox, lockedIn, lockedOut } = resolve(features, state);
  assert.deepEqual(included.map((f) => f.id), ['a', 'b']);
  assert.equal(lockedIn, 1);
  assert.equal(lockedOut, 1);
  assert.deepEqual(bbox, [11, 46, 11.1, 46.1]);
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
