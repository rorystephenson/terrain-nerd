import assert from 'node:assert/strict';
import test from 'node:test';

import { healSpec } from './heal.ts';
import { resolveFeatures } from './resolve.ts';
import type { FeatureRef, QuizFeature, QuizSpec } from './types.ts';

const peak = (id: string, name: string, at: [number, number], wikidata?: string): QuizFeature => ({
  type: 'Feature',
  id,
  bbox: [at[0], at[1], at[0], at[1]],
  geometry: { type: 'Point', coordinates: at },
  properties: { name, kind: 'peak', lengthKm: 0, anchor: at, ...(wikidata ? { wikidata } : {}) },
});

const spec = (features: FeatureRef[]): QuizSpec => ({
  id: 'q1',
  name: 'Brenta',
  source: 'built',
  createdAt: '2026-01-01T00:00:00.000Z',
  features,
  bbox: [10, 46, 11, 47],
});

test('a quiz that held bare ids learns names and anchors by being played', () => {
  const pool = [peak('peak/n1', 'Cima Tosa', [10.87, 46.16], 'Q7')];
  const before = spec([{ id: 'peak/n1', kind: 'peak' }]);

  const after = healSpec(before, resolveFeatures(pool, before.features));

  assert.notEqual(after, before, 'something was learnt, so it is a new object');
  assert.deepEqual(after.features, [
    { id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16], wikidata: 'Q7' },
  ]);
});

test('a quiz that already knew everything is returned untouched', () => {
  // Identity, not equality: a round that taught us nothing must not write.
  const pool = [peak('peak/n1', 'Cima Tosa', [10.87, 46.16])];
  const before = spec([
    { id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16] },
  ]);

  assert.equal(healSpec(before, resolveFeatures(pool, before.features)), before);
});

test('a repaired reference adopts the id it resolved to', () => {
  // Paid for once. Next round it is an exact hit like any other.
  const pool = [peak('peak/n2', 'Cima Tosa', [10.87, 46.16], 'Q7')];
  const before = spec([
    { id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16], wikidata: 'Q7' },
  ]);

  const after = healSpec(before, resolveFeatures(pool, before.features));
  assert.deepEqual(after.features.map((f) => f.id), ['peak/n2']);
});

test('a feature that is genuinely gone is kept, not quietly dropped', () => {
  const pool = [peak('peak/n1', 'Cima Tosa', [10.87, 46.16])];
  const before = spec([
    { id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16] },
    { id: 'peak/n9', kind: 'peak', name: 'Gone', at: [10.9, 46.2] },
  ]);

  const after = healSpec(before, resolveFeatures(pool, before.features));
  assert.deepEqual(after.features.map((f) => f.id), ['peak/n1', 'peak/n9']);
});

test('healing preserves everything else about the quiz', () => {
  const pool = [peak('peak/n1', 'Cima Tosa', [10.87, 46.16])];
  const before = { ...spec([{ id: 'peak/n1', kind: 'peak' as const }]), poolAt: '2026-01-01' };

  const after = healSpec(before, resolveFeatures(pool, before.features));
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
  assert.equal(after.poolAt, before.poolAt);
  assert.deepEqual(after.bbox, before.bbox);
});
