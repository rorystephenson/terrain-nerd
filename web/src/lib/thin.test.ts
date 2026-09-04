import assert from 'node:assert/strict';
import test from 'node:test';

import { haversineKm as pipelineHaversine } from '../../../pipeline/src/geo.ts';
import { haversineKm, thin, type Spaced } from './thin.ts';

/*
 * The spacing pass is the only control in the builder that takes away something
 * the sliders already said yes to, so what it drops and what it must never drop
 * are both worth pinning.
 */

let next = 0;
const at = (lon: number, lat: number, strength = 0.5, kind = 'peak'): Spaced => ({
  id: `${kind}/n${next++}`,
  kind,
  at: [lon, lat],
  strength,
  locked: false,
});

/** A regular grid, so what survives is easy to reason about. */
function lattice(rows: number, columns: number, stepDeg: number): Spaced[] {
  const out: Spaced[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      out.push(at(11 + column * stepDeg, 46 + row * stepDeg, 0.5));
    }
  }
  return out;
}

const closestPair = (items: Spaced[]): number => {
  let best = Infinity;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].kind !== items[j].kind) continue;
      best = Math.min(best, haversineKm(items[i].at, items[j].at));
    }
  }
  return best;
};

test('the distance is the same one the pipeline measures', () => {
  // `web/src/lib` has no distance helper, so this is a copy — and a copy that
  // drifts would thin against different ground than the scores were built on.
  for (const [a, b] of [
    [[11, 46], [11.1, 46.1]],
    [[5.9, 45.75], [6.45, 46]],
    [[10.45, 45.8], [11.11, 46.43]],
  ] as [[number, number], [number, number]][]) {
    assert.ok(Math.abs(haversineKm(a, b) - pipelineHaversine(a, b)) < 1e-9);
  }
});

test('off changes nothing at all', () => {
  const items = lattice(6, 6, 0.005);
  assert.deepEqual(thin(items, 0), items);
  assert.deepEqual(thin(items, -1), items);
});

test('nothing kept stands closer than the spacing', () => {
  // The invariant the whole pass exists for.
  for (const spacing of [1, 2, 4]) {
    const kept = thin(lattice(8, 8, 0.01), spacing);
    assert.ok(kept.length > 0, 'something survives');
    assert.ok(
      closestPair(kept) >= spacing,
      `spacing ${spacing}km: closest pair is ${closestPair(kept).toFixed(2)}km`,
    );
  }
});

test('a wider spacing never keeps more', () => {
  const items = lattice(8, 8, 0.01);
  let previous = Infinity;
  for (const spacing of [0.5, 1, 2, 3, 5]) {
    const kept = thin(items, spacing).length;
    assert.ok(kept <= previous, `${spacing}km kept ${kept}, more than the step before`);
    previous = kept;
  }
});

test('the strongest of a cluster is the one that survives', () => {
  const weak = at(11, 46, 0.2);
  const strong = at(11.001, 46.001, 0.9);
  const kept = thin([weak, strong], 3);
  assert.deepEqual(kept.map((i) => i.id), [strong.id]);
});

test('the answer does not depend on the order they arrive in', () => {
  // Without the id tiebreak this comes out differently depending on how the
  // chunks happened to load, and dragging a slider back can return a different
  // set than it started with.
  const items = lattice(7, 7, 0.008);
  const forwards = thin(items, 1.5).map((i) => i.id);
  const backwards = thin([...items].reverse(), 1.5).map((i) => i.id);
  assert.deepEqual(new Set(backwards), new Set(forwards));
});

test('equal strength is broken by id, not by luck', () => {
  const a = { ...at(11, 46, 0.5), id: 'peak/a' };
  const b = { ...at(11.001, 46, 0.5), id: 'peak/b' };
  assert.deepEqual(thin([a, b], 3).map((i) => i.id), ['peak/a']);
  assert.deepEqual(thin([b, a], 3).map((i) => i.id), ['peak/a']);
});

test('what survives comes back in the order it went in', () => {
  // The caller's list is what the map draws; reordering it would reshuffle the
  // whole selection on every drag of the slider.
  const items = lattice(5, 5, 0.02);
  const kept = thin(items, 1);
  const positions = kept.map((i) => items.indexOf(i));
  assert.deepEqual(positions, [...positions].sort((x, y) => x - y));
});

test('a pin is never thinned away', () => {
  // Everywhere else in the builder a pin survives whatever the filters say, and
  // reopening a saved quiz depends on that holding here too.
  const pinned = { ...at(11, 46, 0.01), locked: true };
  const giant = at(11.001, 46.001, 1);
  const kept = thin([giant, pinned], 5);
  assert.ok(kept.some((i) => i.id === pinned.id), 'the pin survives a stronger neighbour');
});

test('two pins on top of each other both survive', () => {
  const one = { ...at(11, 46, 0.5), locked: true };
  const two = { ...at(11.0005, 46, 0.5), locked: true };
  assert.equal(thin([one, two], 5).length, 2);
});

test('a pin takes no ground of its own', () => {
  /*
   * Adding something by hand must not quietly remove something else — and
   * reopening a saved quiz pins back everything the spacing dropped, so a pin
   * that crowded its neighbours would lose features a second way.
   */
  const pinned = { ...at(11, 46, 0.1), locked: true };
  const neighbour = at(11.002, 46, 0.9);
  const kept = thin([neighbour, pinned], 4);
  assert.deepEqual(new Set(kept.map((i) => i.id)), new Set([pinned.id, neighbour.id]));
});

test('a kind never crowds out another kind', () => {
  // A pass and the peak above it are two different questions about one col.
  const peak = at(11, 46, 0.9, 'peak');
  const pass = at(11.0005, 46.0005, 0.2, 'pass');
  assert.equal(thin([peak, pass], 5).length, 2);
});

test('a lone weak feature outlives a crowd of strong ones', () => {
  /*
   * The case the whole thing is for: ten prominent, well-flown summits packed
   * into one massif are not ten questions, while the modest thing alone at the
   * end of the ridge is the only name for where it is.
   */
  const massif = Array.from({ length: 10 }, (_, i) => at(11 + i * 0.002, 46 + i * 0.002, 0.9));
  const lonely = at(11.3, 46.3, 0.3);
  const kept = thin([...massif, lonely], 3);
  assert.ok(kept.some((i) => i.id === lonely.id), 'the lone one is kept');
  assert.equal(kept.filter((i) => i.id !== lonely.id).length, 1, 'the massif speaks once');
});

test('an empty set is not a special case', () => {
  assert.deepEqual(thin([], 3), []);
});
