import assert from 'node:assert/strict';
import test from 'node:test';

import { coverageHash, staleTiles } from '../../../pipeline/src/coverage.ts';

/*
 * Coverage lives in the pipeline but is tested here, where the test runner is —
 * the same arrangement as `placeZoom.test.ts` and `stitch.test.ts`.
 *
 * These two decide what a coverage change costs. Getting `staleTiles` wrong is
 * expensive in one direction and invisible in the other: too eager and every
 * edit redraws the pyramid, too shy and the map keeps drawing the old edge of
 * coverage at the zooms nobody thinks to check.
 */

const at = (zoom: number, cells: string[]) => ({ zoom, cells });

test('coverage hash ignores the order cells were picked in', () => {
  assert.equal(
    coverageHash(at(10, ['x1y1', 'x2y2', 'x3y3'])),
    coverageHash(at(10, ['x3y3', 'x1y1', 'x2y2'])),
  );
});

test('coverage hash separates the same keys at another zoom', () => {
  assert.notEqual(coverageHash(at(10, ['x1y1'])), coverageHash(at(9, ['x1y1'])));
});

test('unchanged coverage invalidates nothing', () => {
  const held = at(10, ['x100y200', 'x101y200']);
  assert.deepEqual(staleTiles(held, held, 4, 11), []);
});

test('an added cell invalidates only the wider tiles above it', () => {
  const before = at(10, ['x100y200']);
  const after = at(10, ['x100y200', 'x400y300']);
  const stale = staleTiles(before, after, 8, 11).sort();

  // z8 and z9 ancestors of the new cell, and nothing at z10 or z11: those tiles
  // have never been drawn, so there is nothing there to be wrong.
  assert.deepEqual(stale, ['8/100/75', '9/200/150']);
});

test('a cell added beside an old one shares its ancestors', () => {
  // x401y300 sits in the same z9 tile as x400y300, so growing into it costs the
  // same two tiles rather than two more.
  const stale = staleTiles(at(10, ['x400y300']), at(10, ['x400y300', 'x401y300']), 8, 11);
  assert.deepEqual(stale.sort(), ['8/100/75', '9/200/150']);
});

test('a dropped cell takes its own tiles with it', () => {
  const stale = staleTiles(at(10, ['x400y300']), at(10, []), 10, 11).sort();
  assert.deepEqual(stale, [
    '10/400/300',
    '11/800/600',
    '11/800/601',
    '11/801/600',
    '11/801/601',
  ]);
});

test('the widest zoom is included, and nothing wider', () => {
  const stale = staleTiles(at(10, []), at(10, ['x400y300']), 4, 11);
  assert.ok(stale.includes('4/6/4'));
  assert.ok(!stale.some((tile) => Number(tile.split('/')[0]) < 4));
});

test('a coverage zoom at the ceiling still invalidates the wider tiles', () => {
  // maxZoom below the coverage zoom is not a configuration anyone wants, but it
  // must not silently invalidate nothing.
  const stale = staleTiles(at(10, []), at(10, ['x400y300']), 4, 9);
  assert.deepEqual(stale.sort(), ['4/6/4', '5/12/9', '6/25/18', '7/50/37', '8/100/75', '9/200/150']);
});
