import assert from 'node:assert/strict';
import test from 'node:test';

import { stitch } from '../../../pipeline/src/stitch.ts';
import type { LonLat } from '../../../pipeline/src/geo.ts';

/*
 * The stitcher lives in the pipeline but is tested here, where the test runner
 * is — the same arrangement as `placeZoom.test.ts`.
 */

const p = (x: number, y: number): LonLat => [x, y];
const total = (lines: LonLat[][]) => lines.reduce((n, l) => n + l.length, 0);

test('a chain through a two-way join becomes one line', () => {
  // The whole point: three OSM fragments of the same road, six vertices, come
  // out as one line of four.
  const out = stitch([
    [p(0, 0), p(1, 0)],
    [p(1, 0), p(2, 0)],
    [p(2, 0), p(3, 0)],
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], [p(0, 0), p(1, 0), p(2, 0), p(3, 0)]);
});

test('a junction is not crossed', () => {
  // Four ends meet at (1,0), so which line continues which is a guess. It stays
  // a junction: a stitcher that guessed would draw a road that does not exist.
  const out = stitch([
    [p(0, 0), p(1, 0)],
    [p(1, 0), p(2, 0)],
    [p(1, 0), p(1, 1)],
  ]);
  assert.equal(out.length, 3);
});

test('fragments are joined regardless of the direction they were drawn in', () => {
  // OSM way direction is arbitrary, so half the fragments of a road meet
  // tail-to-tail. Reversed on the way in, they are still one road.
  const out = stitch([
    [p(0, 0), p(1, 0)],
    [p(2, 0), p(1, 0)],
    [p(2, 0), p(3, 0)],
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 4);
  assert.deepEqual([out[0][0], out[0][3]].sort(), [p(0, 0), p(3, 0)].sort());
});

test('a closed ring is left alone', () => {
  const ring = [p(0, 0), p(1, 0), p(1, 1), p(0, 0)];
  assert.deepEqual(stitch([ring]), [ring]);
});

test('a loop with no ends still comes back whole, and only once', () => {
  // Four fragments round a square: every join is two-degree, so there is no end
  // to start from. Walked anyway, or it would be dropped entirely.
  const out = stitch([
    [p(0, 0), p(1, 0)],
    [p(1, 0), p(1, 1)],
    [p(1, 1), p(0, 1)],
    [p(0, 1), p(0, 0)],
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 5, 'closes back on itself');
});

test('no vertex is lost and none is duplicated at a join', () => {
  const lines = [
    [p(0, 0), p(1, 0), p(2, 0)],
    [p(2, 0), p(3, 0)],
    [p(9, 9), p(8, 8)],
  ];
  const out = stitch(lines);
  // Six vertices in, one shared node at (2,0) collapsed, so five out.
  assert.equal(total(out), total(lines) - 1);
});

test('every input line comes out exactly once', () => {
  // A stitcher that consumed a line twice would double the geometry; one that
  // dropped it would leave a hole in the road with no error.
  const lines: LonLat[][] = [];
  for (let i = 0; i < 40; i++) lines.push([p(i, 0), p(i + 1, 0)]);
  for (let i = 0; i < 15; i++) lines.push([p(i, 5), p(i + 1, 5)]);
  lines.push([p(3, 0), p(3, 2)]); // a junction partway along the first road
  const out = stitch(lines);
  assert.equal(total(out) - out.length, total(lines) - lines.length);
});

test('a stitched road actually simplifies, which is the reason for all this', async () => {
  const { simplify } = await import('../../../pipeline/src/simplify.ts');
  // A gently curving road, cut into two-point fragments the way OSM stores it.
  const whole: LonLat[] = [];
  for (let i = 0; i <= 200; i++) whole.push(p(11 + i * 0.001, 46 + Math.sin(i / 40) * 0.0004));
  const fragments = whole.slice(0, -1).map((point, i) => [point, whole[i + 1]]);

  const loose = fragments.map((f) => simplify(f, 0.8)).reduce((n, l) => n + l.length, 0);
  const stitched = stitch(fragments).map((f) => simplify(f, 0.8)).reduce((n, l) => n + l.length, 0);

  assert.equal(loose, 400, 'unstitched, Douglas-Peucker cannot drop below two points a fragment');
  assert.ok(stitched < 20, `stitched simplifies to almost nothing, got ${stitched}`);
});
