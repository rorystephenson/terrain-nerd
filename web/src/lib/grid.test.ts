import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boxesOverlap,
  cellsCovering,
  geometryIntersectsBox,
  keyOf,
  pointInBox,
  worldSizeAt,
  worldX,
  worldY,
} from './grid.ts';
import { cellsCovering as pipelineCells, bboxOfCell } from '../../../pipeline/src/grid.ts';
import {
  worldSizeAt as pipelineWorldSizeAt,
  worldX as pipelineWorldX,
  worldY as pipelineWorldY,
} from '../../../pipeline/src/mercator.ts';

/** The z9 tile over the lower Adige, used as the worked example throughout. */
const CELL = 'x271y182';
const CHUNK_ZOOM = 9;

test('key format matches what the pipeline writes', () => {
  // The pipeline names its chunk files with the same scheme; if these ever
  // disagree every fetch 404s, so the format is pinned on both sides.
  assert.equal(keyOf(271, 182), 'x271y182');
  assert.equal(keyOf(-3, 70), 'x-3y70');
});

test('the two copies of the tile maths agree', () => {
  // `grid.ts` here is a deliberate copy of the pipeline's, so that the browser
  // bundle does not depend on the pipeline. This is the test that keeps the
  // copy honest — a divergence would send the app fetching cells that were
  // never written.
  for (const zoom of [0, 6, 9, 10, 14]) {
    assert.equal(worldSizeAt(zoom), pipelineWorldSizeAt(zoom));
    for (const lon of [-180, -0.1, 0, 11.12, 179.9]) {
      assert.equal(worldX(lon, worldSizeAt(zoom)), pipelineWorldX(lon, worldSizeAt(zoom)));
    }
    for (const lat of [-84, 0, 37, 46.07, 84]) {
      assert.equal(worldY(lat, worldSizeAt(zoom)), pipelineWorldY(lat, worldSizeAt(zoom)));
    }
  }
  for (const box of [
    [10.7, 45.7, 11.2, 46.0],
    [10.6, 45.7, 11.6, 46.4],
    [-0.2, 45.8, -0.1, 45.9],
  ] as [number, number, number, number][]) {
    assert.deepEqual(cellsCovering(box, CHUNK_ZOOM), pipelineCells(box, CHUNK_ZOOM));
  }
});

test('a box inside one cell asks for exactly that cell', () => {
  assert.deepEqual(cellsCovering([10.7, 45.7, 11.2, 46.0], CHUNK_ZOOM), [CELL]);
});

test('a box spanning a seam asks for both cells', () => {
  const keys = cellsCovering([11.2, 45.7, 11.4, 46.0], CHUNK_ZOOM);
  assert.deepEqual(keys.sort(), ['x271y182', 'x272y182']);
});

test('a box landing exactly on a boundary does not drag in the neighbour', () => {
  // A cell's own bounds must resolve to itself alone, or every chunk would pull
  // in the three neighbours it merely touches.
  assert.deepEqual(cellsCovering(bboxOfCell(CELL, CHUNK_ZOOM), CHUNK_ZOOM), [CELL]);
});

test('a degenerate box still resolves to one cell', () => {
  assert.deepEqual(cellsCovering([11.0, 45.8, 11.0, 45.8], CHUNK_ZOOM), [CELL]);
});

test('negative longitudes floor the right way', () => {
  assert.deepEqual(cellsCovering([-0.2, 45.8, -0.1, 45.9], CHUNK_ZOOM), ['x255y182']);
});

test('a wide box covers the whole rectangle of cells', () => {
  const keys = cellsCovering([10.6, 45.7, 11.6, 46.4], CHUNK_ZOOM);
  assert.deepEqual(keys.sort(), ['x271y181', 'x271y182', 'x272y181', 'x272y182']);
});

test('tile rows count southward', () => {
  // The one thing that inverted when the grid stopped being degrees. Ground to
  // the north gets a *lower* row index, and getting this backwards would send
  // every fetch to the cell on the wrong side of the map.
  const north = cellsCovering([10.7, 46.2, 11.2, 46.4], CHUNK_ZOOM);
  assert.deepEqual(north, ['x271y181']);
  assert.ok(Number(north[0].split('y')[1]) < 182, 'further north, lower row');
});

test('a chunk contains exactly its four coverage cells', () => {
  // Coverage is picked at z10 and shipped at z9, so the two grids have to nest
  // exactly or a covered cell could straddle two chunks.
  const inside = cellsCovering(bboxOfCell(CELL, CHUNK_ZOOM), CHUNK_ZOOM + 1);
  assert.deepEqual(inside.sort(), ['x542y364', 'x542y365', 'x543y364', 'x543y365']);
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
