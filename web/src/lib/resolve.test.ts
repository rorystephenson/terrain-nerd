import assert from 'node:assert/strict';
import test from 'node:test';

import { matchedFeatures, repairs, resolveFeatures } from './resolve.ts';
import type { FeatureRef, KindId, QuizFeature } from './types.ts';

const feature = (
  id: string,
  name: string,
  at: [number, number],
  extra: { kind?: KindId; wikidata?: string } = {},
): QuizFeature => {
  const kind = extra.kind ?? (id.split('/')[0] as KindId);
  return {
    type: 'Feature',
    id,
    bbox: [at[0], at[1], at[0], at[1]],
    geometry: { type: 'Point', coordinates: at },
    properties: {
      name,
      kind,
      lengthKm: 0,
      anchor: at,
      ...(extra.wikidata ? { wikidata: extra.wikidata } : {}),
    },
  };
};

const ref = (id: string, name: string, at: [number, number], wikidata?: string): FeatureRef => ({
  id,
  kind: id.split('/')[0] as KindId,
  name,
  at,
  ...(wikidata ? { wikidata } : {}),
});

test('ids that still resolve are used as they are', () => {
  const pool = [feature('peak/n1', 'Cima Tosa', [10.87, 46.16])];
  const out = resolveFeatures(pool, [ref('peak/n1', 'Cima Tosa', [10.87, 46.16])]);

  assert.deepEqual(matchedFeatures(out).map((f) => f.id), ['peak/n1']);
  assert.deepEqual(repairs(out), []);
  assert.deepEqual(out.missing, []);
});

test('a moved id is rescued by its wikidata entity, however far it moved', () => {
  // The way was redrawn and renamed; the entity is the same mountain.
  const pool = [feature('peak/n999', 'Cima Tosa (Brenta)', [11.4, 46.4], { wikidata: 'Q7' })];
  const out = resolveFeatures(pool, [
    ref('peak/n1', 'Cima Tosa', [10.87, 46.16], 'Q7'),
  ]);

  assert.deepEqual(matchedFeatures(out).map((f) => f.id), ['peak/n999']);
  assert.deepEqual(repairs(out).map((m) => m.by), ['wikidata']);
});

test('a moved id is rescued by name when it is still in the right place', () => {
  const pool = [feature('valley/w2', 'Val Rendena', [10.75, 46.1])];
  const out = resolveFeatures(pool, [
    ref('valley/w1', 'val  rendena', [10.76, 46.11]),
  ]);

  assert.deepEqual(matchedFeatures(out).map((f) => f.id), ['valley/w2']);
  assert.deepEqual(repairs(out).map((m) => m.by), ['name']);
});

test('the same name far away is not the same feature', () => {
  // Two Valsordas, 70 km apart. A name match alone would take the wrong one.
  const pool = [feature('valley/w2', 'Valsorda', [11.6, 46.1])];
  const out = resolveFeatures(pool, [ref('valley/w1', 'Valsorda', [10.7, 46.1])]);

  assert.deepEqual(matchedFeatures(out), []);
  assert.deepEqual(out.missing.map((r) => r.id), ['valley/w1']);
});

test('valleys get more slack than peaks, because their anchor slides', () => {
  // 5 km off. Inside a valley's rescue radius, outside a peak's — the same
  // displacement means something different for a midpoint than for a summit.
  const at: [number, number] = [10.75, 46.1];
  const moved: [number, number] = [10.75, 46.145];

  const asValley = resolveFeatures(
    [feature('valley/w2', 'Testa', moved)],
    [ref('valley/w1', 'Testa', at)],
  );
  const asPeak = resolveFeatures(
    [feature('peak/n2', 'Testa', moved)],
    [ref('peak/n1', 'Testa', at)],
  );

  assert.deepEqual(matchedFeatures(asValley).map((f) => f.id), ['valley/w2'], 'valley rescued');
  assert.deepEqual(matchedFeatures(asPeak), [], 'peak not rescued');
});

test('one pool feature is never handed to two references', () => {
  // Two segments of a valley that have since merged into one feature. Without
  // the claim, the round would ask the same question twice and the second
  // could never be answered.
  const pool = [feature('valley/w1', 'Val Rendena', [10.75, 46.1])];
  const out = resolveFeatures(pool, [
    ref('valley/w1', 'Val Rendena', [10.75, 46.1]),
    ref('valley/w9', 'Val Rendena', [10.76, 46.1]),
  ]);

  assert.deepEqual(matchedFeatures(out).map((f) => f.id), ['valley/w1']);
  assert.deepEqual(out.missing.map((r) => r.id), ['valley/w9']);
});

test('an exact id wins over a rescue that would have taken it', () => {
  // Order matters here: the ref that names the feature outright comes second.
  // If rescues ran in sequence, the first ref would claim it by name and the
  // one that actually owns the id would be reported missing.
  const pool = [feature('valley/w2', 'Val Rendena', [10.75, 46.1])];
  const out = resolveFeatures(pool, [
    ref('valley/w1', 'Val Rendena', [10.75, 46.1]),
    ref('valley/w2', 'Val Rendena', [10.75, 46.1]),
  ]);

  assert.deepEqual(matchedFeatures(out).map((f) => f.id), ['valley/w2']);
  assert.deepEqual(out.missing.map((r) => r.id), ['valley/w1']);
});

test('a name match of the wrong kind is not a match', () => {
  // Passo Rolle the pass and Passo Rolle the peak are different questions.
  const pool = [feature('peak/n2', 'Passo Rolle', [11.79, 46.29])];
  const out = resolveFeatures(pool, [
    ref('pass/n1', 'Passo Rolle', [11.79, 46.29]),
  ]);

  assert.deepEqual(matchedFeatures(out), []);
  assert.deepEqual(out.missing.map((r) => r.id), ['pass/n1']);
});

test('quiz order is preserved, and what is gone is reported', () => {
  const pool = [
    feature('peak/n1', 'Cima Tosa', [10.87, 46.16]),
    feature('peak/n3', 'Crozzon', [10.88, 46.17]),
  ];
  const out = resolveFeatures(pool, [
    ref('peak/n3', 'Crozzon', [10.88, 46.17]),
    ref('peak/n2', 'Gone', [10.9, 46.2]),
    ref('peak/n1', 'Cima Tosa', [10.87, 46.16]),
  ]);

  assert.deepEqual(matchedFeatures(out).map((f) => f.id), ['peak/n3', 'peak/n1']);
  assert.deepEqual(out.missing.map((r) => r.name), ['Gone']);
});
