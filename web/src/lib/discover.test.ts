import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_QUERY_CELLS,
  areaKm2,
  boundsOf,
  centreOf,
  cluster,
  footprints,
  mergeFound,
  queryCells,
  spanKm,
  unasked,
  visiblePins,
} from './discover.ts';
import type { Published } from './codec.ts';
import type { BBox } from './grid.ts';

const quiz = (id: string, bbox: BBox, over: Partial<Published> = {}): Published => ({
  spec: {
    id,
    name: id,
    source: 'shared',
    createdAt: '2026-01-01T00:00:00.000Z',
    features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa' }],
    bbox,
  },
  ownerId: 'u1',
  ownerName: 'Rory',
  version: 1,
  publishedAt: '2026-01-01T00:00:00.000Z',
  questions: 1,
  players: 0,
  ...over,
});

/** Roughly the plates the browse map draws: wide and short. */
const REACH = { x: 60, y: 24 };

/** The Brenta, near enough: a quiz-sized box in the Alps. */
const BRENTA: BBox = [10.8, 46.0, 11.1, 46.3];

test('a view small enough to ask by ground comes back as cells', () => {
  const cells = queryCells(BRENTA);
  assert.notEqual(cells, null);
  assert.ok(cells!.length > 0 && cells!.length <= MAX_QUERY_CELLS);
});

test('a view too wide to ask by ground is refused rather than quietly cut short', () => {
  // Slicing to thirty would drop whole regions off the map with nothing said,
  // so the caller is made to choose a different query instead.
  assert.equal(queryCells([-20, 20, 40, 60]), null);
});

test('only ground not already asked about is asked about again', () => {
  assert.deepEqual(unasked(new Set(['x1y1']), ['x1y1', 'x2y1']), ['x2y1']);
  assert.deepEqual(unasked(new Set(['x1y1', 'x2y1']), ['x1y1']), [], 'a pan back asks nothing');
  assert.deepEqual(unasked(new Set(), ['x1y1']), ['x1y1']);
});

test('the span is the longer side in km, with longitude shortened by latitude', () => {
  // A degree of longitude at 46°N is about 0.69 of a degree of latitude, so a
  // square-in-degrees box in the Alps is markedly taller than it is wide.
  const span = spanKm([10.0, 46.0, 11.0, 47.0]);
  assert.ok(Math.abs(span - 111.195) < 0.5, `taller than wide, got ${span}`);
  // And a box that really is wider reports its width.
  assert.ok(spanKm([10.0, 46.0, 12.0, 46.2]) > 100);
});

test('area orders quizzes by how much ground they cover', () => {
  assert.ok(areaKm2([10, 46, 11, 47]) > areaKm2([10, 46, 10.5, 46.5]));
  assert.ok(areaKm2(BRENTA) > 0);
});

test('the centre of a box is its middle', () => {
  assert.deepEqual(centreOf([10, 46, 11, 47]), [10.5, 46.5]);
});

test('what is found accumulates, so panning back does not lose a quiz', () => {
  const first = mergeFound([], [quiz('a', BRENTA), quiz('b', BRENTA)]);
  const second = mergeFound(first, [quiz('c', BRENTA)]);
  assert.deepEqual(second.map((q) => q.spec.id).sort(), ['a', 'b', 'c']);
});

test('a quiz found again brings its counters up to date rather than doubling', () => {
  const held = mergeFound([], [quiz('a', BRENTA, { players: 2 })]);
  const again = mergeFound(held, [quiz('a', BRENTA, { players: 9 })]);
  assert.equal(again.length, 1);
  assert.equal(again[0].players, 9);
});

test('the order is total, so a pan cannot reshuffle pins under the cursor', () => {
  const same = { players: 3, publishedAt: '2026-02-01T00:00:00.000Z' };
  const one = mergeFound([], [quiz('b', BRENTA, same), quiz('a', BRENTA, same)]);
  const other = mergeFound([], [quiz('a', BRENTA, same), quiz('b', BRENTA, same)]);
  assert.deepEqual(
    one.map((q) => q.spec.id),
    other.map((q) => q.spec.id),
    'the id breaks a tie the counters cannot',
  );
});

test('most played comes first, because that is the pin a cluster keeps', () => {
  const found = mergeFound(
    [],
    [quiz('quiet', BRENTA, { players: 1 }), quiz('busy', BRENTA, { players: 40 })],
  );
  assert.equal(found[0].spec.id, 'busy');
});

test('a footprint is the quiz’s own ground, closed and carrying its id', () => {
  const collection = footprints([quiz('a', [10, 46, 11, 47])]);
  const shape = collection.features[0];
  assert.equal(shape.id, 'a', 'promoted to the feature id, so selection is feature state');
  const ring = (shape.geometry as GeoJSON.Polygon).coordinates[0];
  assert.equal(ring.length, 5, 'a closed ring repeats its first point');
  assert.deepEqual(ring[0], ring[4]);
  assert.deepEqual(ring[0], [10, 46]);
  assert.deepEqual(ring[2], [11, 47]);
});

test('pins far apart are left alone', () => {
  const groups = cluster(
    [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 200, y: 0 },
    ],
    REACH,
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.ids), [['a'], ['b']]);
});

test('pins too close to tell apart become one, named by the first', () => {
  // Passed in `byInterest` order, so the survivor is the most-played quiz —
  // the right one to name when only one name fits.
  const groups = cluster(
    [
      { id: 'busy', x: 100, y: 100 },
      { id: 'quiet', x: 110, y: 105 },
      { id: 'quieter', x: 95, y: 92 },
    ],
    REACH,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].at.id, 'busy');
  assert.deepEqual(groups[0].ids, ['busy', 'quiet', 'quieter']);
});

test('a cluster reaches only as far as its own radius, never along a chain', () => {
  // Three in a row, each within reach of its neighbour but not of the far one.
  // Absorbing transitively is single-linkage clustering, whose failure is
  // exactly this shape: a line of pins a screen wide collapsing into one group
  // centred on ground none of them are on. So `b` joins `a`, and `c` — 90px
  // from the seed, past the 60 it reaches — starts its own.
  const groups = cluster(
    [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 30, y: 0 },
      { id: 'c', x: 90, y: 0 },
    ],
    REACH,
  );
  assert.deepEqual(groups.map((g) => g.ids), [['a', 'b'], ['c']]);
});

test('plates side by side are one plate; the same gap stacked is two', () => {
  // The reason the reach is an ellipse. A plate is a name on a rounded
  // rectangle: 50 px apart across, two of them are printed on top of each
  // other and neither is readable; 50 px apart down, both are perfectly
  // legible, one above the other. A single radius gets one of these wrong.
  const across = cluster(
    [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 50, y: 0 },
    ],
    REACH,
  );
  assert.deepEqual(across.map((g) => g.ids), [['a', 'b']], 'overlapping, so merged');

  const down = cluster(
    [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 50 },
    ],
    REACH,
  );
  assert.deepEqual(down.map((g) => g.ids), [['a'], ['b']], 'stacked, so left alone');
});

test('clustering keeps every pin exactly once', () => {
  const pins = Array.from({ length: 25 }, (_, i) => ({ id: `q${i}`, x: i * 7, y: (i % 5) * 7 }));
  const seen = cluster(pins, { x: 20, y: 20 }).flatMap((g) => g.ids);
  assert.equal(seen.length, pins.length);
  assert.equal(new Set(seen).size, pins.length);
});

test('a cluster zooms to a box holding all of it', () => {
  const box = boundsOf([[10, 46, 11, 47], [12, 45, 13, 46]]);
  assert.ok(box![0] < 10 && box![1] < 45 && box![2] > 13 && box![3] > 47, 'padded outwards');
});

test('a single quiz still gets a box with width, so fitting it cannot divide by zero', () => {
  const box = boundsOf([[10.5, 46.5, 10.5, 46.5]]);
  assert.ok(box![2] - box![0] > 0);
  assert.ok(box![3] - box![1] > 0);
});

test('nothing to fit is nothing, not an empty box at null island', () => {
  assert.equal(boundsOf([]), null);
});

test('a pin off the edge is not drawn, but one half over it is', () => {
  // These are DOM buttons: one left in the document for a quiz five hundred
  // kilometres away is clipped out of sight and still in the tab order.
  const size = { width: 800, height: 600 };
  const pins = [
    { id: 'middle', x: 400, y: 300 },
    { id: 'grazing', x: -40, y: 300 },
    { id: 'gone', x: -3000, y: 300 },
    { id: 'below', x: 400, y: 2000 },
  ];
  assert.deepEqual(
    visiblePins(pins, size).map((p) => p.id),
    ['middle', 'grazing'],
  );
});

test('an off-screen quiz cannot be counted in a cluster you can see', () => {
  // Filtered before clustering, or a plate reading "3 quizzes" flies you to
  // ground two of which were never in view.
  const size = { width: 800, height: 600 };
  const pins = [
    { id: 'here', x: 400, y: 300 },
    { id: 'far', x: 420, y: 4000 },
  ];
  const groups = cluster(visiblePins(pins, size), REACH);
  assert.deepEqual(groups.map((g) => g.ids), [['here']]);
});
