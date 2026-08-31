import assert from 'node:assert/strict';
import test from 'node:test';

import { labelReachesScreen, layoutLabels } from './labels.ts';

type Point = { id: string; x: number; y: number };

const view = { width: 1000, height: 800, max: 100 };
/** Production always passes a pad; tests about screen edges need it too. */
const padded = { width: 1000, height: 800, pad: 320, max: 100 };
const project = (p: Point) => ({ x: p.x, y: p.y });

const candidate = (id: string, x: number, y: number, priority = 1, text = 'Somewhere') => ({
  priority,
  text,
  item: { id, x, y },
  key: id,
});

test('well-spaced labels are all drawn', () => {
  const out = layoutLabels(
    [candidate('a', 100, 100), candidate('b', 500, 400), candidate('c', 900, 700)],
    project,
    view,
  );
  assert.deepEqual(out.map((o) => o.item.id).sort(), ['a', 'b', 'c']);
});

test('overlapping labels are dropped, strongest kept', () => {
  const out = layoutLabels(
    [candidate('weak', 300, 300, 1), candidate('strong', 305, 302, 9)],
    project,
    view,
  );
  assert.deepEqual(out.map((o) => o.item.id), ['strong']);
});

test('priority decides, not input order', () => {
  const first = layoutLabels([candidate('a', 300, 300, 1), candidate('b', 302, 300, 5)], project, view);
  const second = layoutLabels([candidate('b', 302, 300, 5), candidate('a', 300, 300, 1)], project, view);
  assert.deepEqual(first.map((o) => o.item.id), ['b']);
  assert.deepEqual(second.map((o) => o.item.id), ['b']);
});

test('a label is drawn as soon as its text reaches the screen', () => {
  // Anchor 20px off the left edge, but "Somewhere" is ~79px wide and centred on
  // it, so half the name is over the map and it has to be drawn. Needs `pad`:
  // without it the candidate is culled by its anchor before its ink is measured.
  const out = layoutLabels([candidate('edge', -20, 400)], project, padded);
  assert.deepEqual(out.map((o) => o.item.id), ['edge']);
});

test('a label hanging up into the screen from below is drawn', () => {
  // Markers are anchored bottom, so a point just under the edge still puts its
  // name on the map.
  const out = layoutLabels([candidate('under', 400, 810)], project, padded);
  assert.deepEqual(out.map((o) => o.item.id), ['under']);
});

test('a label whose text never reaches the screen is not drawn', () => {
  const out = layoutLabels([candidate('gone', -80, 400)], project, padded);
  assert.deepEqual(out.map((o) => o.item.id), []);
});

test('labels off screen are dropped before they can block anything', () => {
  const out = layoutLabels(
    [candidate('off', -50, 400, 9), candidate('on', 400, 400, 1)],
    project,
    view,
  );
  assert.deepEqual(out.map((o) => o.item.id), ['on']);
});

test('a label with no projection is skipped', () => {
  const out = layoutLabels(
    [candidate('nowhere', 0, 0, 9), candidate('here', 400, 400)],
    (p) => (p.id === 'nowhere' ? null : { x: p.x, y: p.y }),
    view,
  );
  assert.deepEqual(out.map((o) => o.item.id), ['here']);
});

test('the cap is respected, taking the strongest', () => {
  // Spread far enough apart that the cap is what limits the result, not collisions.
  const many = Array.from({ length: 8 }, (_, i) =>
    candidate(`p${i}`, 150 + (i % 4) * 220, 150 + Math.floor(i / 4) * 300, i),
  );
  assert.equal(layoutLabels(many, project, { ...view, max: 100 }).length, 8, 'all fit uncapped');

  const out = layoutLabels(many, project, { ...view, max: 3 });
  assert.deepEqual(out.map((o) => o.item.id), ['p7', 'p6', 'p5']);
});

test('a longer name needs more room, so it collides where a short one would not', () => {
  const near: [number, number] = [400, 300];
  const short = layoutLabels(
    [candidate('a', ...near, 9, 'Ala'), candidate('b', near[0] + 70, near[1], 1, 'Ala')],
    project,
    view,
  );
  const long = layoutLabels(
    [
      candidate('a', ...near, 9, 'Cima Presanella Occidentale'),
      candidate('b', near[0] + 70, near[1], 1, 'Cima Presanella Occidentale'),
    ],
    project,
    view,
  );
  assert.equal(short.length, 2, 'short names fit side by side');
  assert.equal(long.length, 1, 'long ones do not');
});

test('a label off the edge still blocks one on screen', () => {
  // The whole point of `pad`. Without it, the off-screen label is discarded, its
  // neighbour is drawn, and panning it into view makes that neighbour vanish.
  const out = layoutLabels(
    [candidate('offscreen', -60, 300, 9), candidate('onscreen', 10, 302, 1)],
    project,
    padded,
  );
  assert.deepEqual(out.map((o) => o.item.id), [], 'the weaker one loses to a label it cannot see');
  // ...and the off-screen winner is not itself drawn.
  assert.equal(out.length, 0);
});

test('panning does not reshuffle which labels are drawn', () => {
  // The regression this guards: at a fixed zoom, sliding the viewport must only
  // add and remove labels at the edges, never change the verdict on one that
  // stays put.
  const town = (id: string, x: number, priority: number) => candidate(id, x, 400, priority);
  const places = [town('a', 100, 5), town('b', 160, 9), town('c', 700, 5), town('d', 1300, 9)];

  const at = (shift: number) =>
    layoutLabels(places, (p) => ({ x: p.x - shift, y: p.y }), padded)
      .map((o) => o.item.id)
      .sort();

  // 'a' loses to 'b' at every offset, rather than appearing when 'b' scrolls off.
  for (const shift of [0, 120, 260, 400]) {
    const drawn = at(shift);
    assert.equal(drawn.includes('a'), false, `'a' must never win, shift ${shift}`);
  }
});

test('ties are broken stably, not by arrival order', () => {
  const spread = { width: 1000, height: 800, pad: 0, max: 100 };
  const one = layoutLabels([candidate('zed', 300, 300, 5), candidate('amy', 305, 302, 5)], project, spread);
  const two = layoutLabels([candidate('amy', 305, 302, 5), candidate('zed', 300, 300, 5)], project, spread);
  assert.deepEqual(one.map((o) => o.item.id), two.map((o) => o.item.id));
});

test('labelReachesScreen tests the ink, not the anchor', () => {
  const size = { width: 1000, height: 800 };
  // "Pinzolo" is ~64px wide, so it reaches the map from 32px outside the edge.
  assert.equal(labelReachesScreen({ x: -20, y: 400 }, 'Pinzolo', size), true);
  assert.equal(labelReachesScreen({ x: -60, y: 400 }, 'Pinzolo', size), false);
  assert.equal(labelReachesScreen({ x: 1020, y: 400 }, 'Pinzolo', size), true);
  // Anchored bottom: the name hangs above the point, so it is on screen from
  // just below the bottom edge but not from just above the top one.
  assert.equal(labelReachesScreen({ x: 400, y: 815 }, 'Pinzolo', size), true);
  assert.equal(labelReachesScreen({ x: 400, y: -5 }, 'Pinzolo', size), false);
});
