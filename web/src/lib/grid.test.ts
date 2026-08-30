import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boxesOverlap,
  cellsCovering,
  geometryIntersectsBox,
  keyOf,
  pointInBox,
} from './grid.ts';

test('key format matches what the pipeline writes', () => {
  // The pipeline names its chunk files with the same scheme; if these ever
  // disagree every fetch 404s, so the format is pinned on both sides.
  assert.equal(keyOf(22, 92), 'x22y92');
  assert.equal(keyOf(-3, 70), 'x-3y70');
});

test('a box inside one cell asks for exactly that cell', () => {
  assert.deepEqual(cellsCovering([11.1, 46.1, 11.3, 46.3], 0.5), ['x22y92']);
});

test('a box spanning a seam asks for both cells', () => {
  const keys = cellsCovering([11.4, 46.1, 11.6, 46.3], 0.5);
  assert.deepEqual(keys.sort(), ['x22y92', 'x23y92']);
});

test('a box landing exactly on a boundary does not drag in the neighbour', () => {
  assert.deepEqual(cellsCovering([11.0, 46.0, 11.5, 46.5], 0.5), ['x22y92']);
});

test('a degenerate box still resolves to one cell', () => {
  assert.deepEqual(cellsCovering([11.2, 46.2, 11.2, 46.2], 0.5), ['x22y92']);
});

test('negative longitudes floor the right way', () => {
  assert.deepEqual(cellsCovering([-0.2, 46.1, -0.1, 46.2], 0.5), ['x-1y92']);
});

test('a wide box covers the whole rectangle of cells', () => {
  const keys = cellsCovering([10.6, 46.0, 11.4, 46.4], 0.5);
  assert.deepEqual(keys.sort(), ['x21y92', 'x22y92']);
  assert.equal(cellsCovering([10.4, 45.6, 11.6, 46.6], 0.5).length, 12, 'x20..x23 by y91..y93');
});

test('point containment is inclusive of the edges', () => {
  const box: [number, number, number, number] = [10, 46, 11, 47];
  assert.equal(pointInBox([10.5, 46.5], box), true);
  assert.equal(pointInBox([10, 46], box), true);
  assert.equal(pointInBox([11, 47], box), true);
  assert.equal(pointInBox([9.99, 46.5], box), false);
  assert.equal(pointInBox([10.5, 47.01], box), false);
});

test('overlap is false for boxes that merely touch', () => {
  assert.equal(boxesOverlap([0, 0, 1, 1], [0.5, 0.5, 2, 2]), true);
  assert.equal(boxesOverlap([0, 0, 1, 1], [1, 0, 2, 1]), false);
  assert.equal(boxesOverlap([0, 0, 1, 1], [2, 2, 3, 3]), false);
});

test('a line crossing the box counts, even with both ends outside', () => {
  // The case that matters: a long valley running clean through the area you
  // picked, whose midpoint and both ends are well beyond the edge.
  const box: [number, number, number, number] = [10, 46, 11, 47];
  const through: GeoJSON.Geometry = {
    type: 'LineString',
    coordinates: [[9, 46.5], [12, 46.5]],
  };
  assert.equal(geometryIntersectsBox(through, box), true);
});

test('a line that merely shares a bounding box does not count', () => {
  // A diagonal valley's bbox can clip the corner of an area it never enters.
  const box: [number, number, number, number] = [10, 46, 11, 47];
  const diagonal: GeoJSON.Geometry = {
    type: 'LineString',
    coordinates: [[11.5, 46.5], [12, 47.5]],
  };
  assert.equal(boxesOverlap([11.5, 46.5, 12, 47.5], [10, 46, 12, 47.5]), true, 'boxes do overlap');
  assert.equal(geometryIntersectsBox(diagonal, box), false, 'but the line stays outside');
});

test('containment and touching both count', () => {
  const box: [number, number, number, number] = [10, 46, 11, 47];
  const inside: GeoJSON.Geometry = { type: 'LineString', coordinates: [[10.2, 46.2], [10.8, 46.8]] };
  const clipping: GeoJSON.Geometry = { type: 'LineString', coordinates: [[9, 46.5], [10.2, 46.5]] };
  const away: GeoJSON.Geometry = { type: 'LineString', coordinates: [[8, 40], [9, 41]] };
  assert.equal(geometryIntersectsBox(inside, box), true);
  assert.equal(geometryIntersectsBox(clipping, box), true);
  assert.equal(geometryIntersectsBox(away, box), false);
});

test('points and multi-geometries are handled', () => {
  const box: [number, number, number, number] = [10, 46, 11, 47];
  assert.equal(geometryIntersectsBox({ type: 'Point', coordinates: [10.5, 46.5] }, box), true);
  assert.equal(geometryIntersectsBox({ type: 'Point', coordinates: [12, 46.5] }, box), false);
  assert.equal(
    geometryIntersectsBox(
      { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[9, 46.5], [12, 46.5]]] },
      box,
    ),
    true,
    'any part crossing is enough',
  );
});
