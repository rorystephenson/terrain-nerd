import assert from 'node:assert/strict';
import test from 'node:test';

import { levelFor } from './places.ts';

const box = (span: number): [number, number, number, number] => [10, 46, 10 + span, 46 + span];

test('detail follows the scale being looked at', () => {
  assert.equal(levelFor(box(8)), 1, 'half a country: cities only');
  assert.equal(levelFor(box(2)), 2, 'a region: towns');
  assert.equal(levelFor(box(0.6)), 3, 'a valley system: villages');
  assert.equal(levelFor(box(0.1)), 4, 'one valley: everything');
});

test('the level never depends on where the viewport sits', () => {
  // The whole point: panning at a fixed zoom must not change which names are
  // eligible, only which of them happen to be on screen.
  const here: [number, number, number, number] = [10, 46, 10.2, 46.2];
  const there: [number, number, number, number] = [14.5, 41, 14.7, 41.2];
  assert.equal(levelFor(here), levelFor(there));
});

test('a tall narrow view is judged by its longer side', () => {
  // Otherwise a portrait window would quietly show more detail than a landscape
  // one covering the same ground.
  assert.equal(levelFor([10, 46, 10.1, 48]), levelFor([10, 46, 12, 46.1]));
});
