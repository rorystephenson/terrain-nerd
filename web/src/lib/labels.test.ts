import assert from 'node:assert/strict';
import test from 'node:test';

import { labelReachesScreen, labelRect, scaleForRank } from './labels.ts';

/*
 * This file used to be mostly about `layoutLabels`, the greedy screen-space
 * collision pass that chose which place names to draw. Two of those cases —
 * 'panning does not reshuffle which labels are drawn' and 'a label off the edge
 * still blocks one on screen' — were the stability guards, and they passed while
 * the map still churned, because they could only ever test the pass against a
 * fixed candidate list. The choice now happens offline over the whole country,
 * and those properties are asserted far more strongly in `placeZoom.test.ts`.
 * What is left here is the box model itself.
 */

const size = { width: 1000, height: 800 };

test('labelReachesScreen tests the ink, not the anchor', () => {
  // "Pinzolo" is ~64px wide, so it reaches the map from 32px outside the edge.
  assert.equal(labelReachesScreen({ x: -20, y: 400 }, 'Pinzolo', size), true);
  assert.equal(labelReachesScreen({ x: -60, y: 400 }, 'Pinzolo', size), false);
  assert.equal(labelReachesScreen({ x: 1020, y: 400 }, 'Pinzolo', size), true);
  // Anchored bottom: the name hangs above the point, so it is on screen from
  // just below the bottom edge but not from just above the top one.
  assert.equal(labelReachesScreen({ x: 400, y: 815 }, 'Pinzolo', size), true);
  assert.equal(labelReachesScreen({ x: 400, y: -5 }, 'Pinzolo', size), false);
});

test('a label hangs above its point, centred on it', () => {
  const rect = labelRect({ x: 500, y: 400 }, 'Pinzolo');
  assert.equal((rect.x1 + rect.x2) / 2, 500, 'centred on the anchor');
  assert.equal(rect.y2, 400, 'the anchor is the bottom edge');
  assert.ok(rect.y1 < rect.y2, 'the ink is above it');
});

test('a city name is measured larger than a hamlet of the same length', () => {
  const city = labelRect({ x: 0, y: 0 }, 'Bolzano', scaleForRank(1));
  const hamlet = labelRect({ x: 0, y: 0 }, 'Bolzano', scaleForRank(4));
  assert.ok(city.x2 - city.x1 > hamlet.x2 - hamlet.x1);
  // One flat width for all four ranks under-measured city names by a quarter,
  // which is what let long city names overlap their neighbours.
  assert.ok(scaleForRank(1) > 1 && scaleForRank(4) < 1);
});

test('a city name reaches the screen from further out than a hamlet', () => {
  const at = { x: -35, y: 400 };
  assert.equal(labelReachesScreen(at, 'Bolzano', size, scaleForRank(1)), true);
  assert.equal(labelReachesScreen(at, 'Bolzano', size, scaleForRank(4)), false);
});
