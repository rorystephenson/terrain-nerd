import assert from 'node:assert/strict';
import test from 'node:test';

import { docToSpec, hasUndefined, readRef, specToDoc, MAX_FEATURES } from './codec.ts';
import type { QuizSpec } from './types.ts';

const spec = (over: Partial<QuizSpec> = {}): QuizSpec => ({
  id: 'q1',
  name: 'Brenta',
  source: 'built',
  createdAt: '2026-01-01T00:00:00.000Z',
  features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16] }],
  bbox: [10, 46, 11, 47],
  ...over,
});

test('a quiz round-trips through a document unchanged', () => {
  const before = spec({ poolAt: '2026-08-01', builder: { kinds: {}, ranges: {}, overrides: {} } });
  const after = docToSpec('q1', specToDoc(before, 'u1', '2026-09-01T00:00:00.000Z'));
  assert.deepEqual(after, before);
});

test('no optional field is ever written as undefined', () => {
  // Firestore rejects an undefined value outright rather than treating it as
  // an absent one, so a quiz with no poolAt would fail the write entirely.
  const doc = specToDoc(spec(), 'u1', '2026-09-01T00:00:00.000Z');
  assert.equal(hasUndefined(doc), false);
  assert.equal('poolAt' in doc, false);
  assert.equal('builder' in doc, false);
  assert.equal('name' in doc.features[0], true);
  assert.equal('wikidata' in doc.features[0], false);
});

test('the id comes from the path, not from the document body', () => {
  // Otherwise a quiz could claim to be a quiz it was not read from.
  const doc = { ...specToDoc(spec(), 'u1', 'now'), id: 'somebody-elses-quiz' };
  assert.equal(docToSpec('q1', doc)?.id, 'q1');
});

test('a document that is not a quiz is refused rather than half-read', () => {
  const good = specToDoc(spec(), 'u1', 'now');
  for (const broken of [
    null,
    'a string',
    42,
    { ...good, name: '' },
    { ...good, name: 123 },
    { ...good, bbox: [1, 2, 3] },
    { ...good, bbox: ['a', 'b', 'c', 'd'] },
    { ...good, bbox: [1, 2, 3, Number.NaN] },
    { ...good, features: 'not a list' },
    { ...good, features: [] },
    { ...good, features: [{ id: 'peak/n1' }] }, // no kind: not a reference
  ]) {
    assert.equal(docToSpec('q1', broken), null, `should refuse: ${JSON.stringify(broken)}`);
  }
});

test('one malformed reference does not cost the whole quiz', () => {
  // 59 of 60 questions beats no quiz at all, and the count is visible either way.
  const doc = {
    ...specToDoc(spec(), 'u1', 'now'),
    features: [
      { id: 'peak/n1', kind: 'peak', name: 'Cima Tosa' },
      { id: 'peak/n2', kind: 'wyvern' }, // not a kind this app has
      null,
      { kind: 'peak' }, // no id
      { id: 'valley/w3', kind: 'valley' },
    ],
  };
  assert.deepEqual(docToSpec('q1', doc)?.features.map((f) => f.id), ['peak/n1', 'valley/w3']);
});

test('a reference keeps what it has and omits what it does not', () => {
  assert.deepEqual(readRef({ id: 'peak/n1', kind: 'peak' }), { id: 'peak/n1', kind: 'peak' });
  assert.deepEqual(readRef({ id: 'peak/n1', kind: 'peak', at: [1, 2], name: 'X', wikidata: 'Q1' }), {
    id: 'peak/n1', kind: 'peak', name: 'X', at: [1, 2], wikidata: 'Q1',
  });
  // A malformed anchor is dropped, not carried through as a bad coordinate.
  assert.deepEqual(readRef({ id: 'peak/n1', kind: 'peak', at: [1] }), { id: 'peak/n1', kind: 'peak' });
  assert.deepEqual(readRef({ id: 'peak/n1', kind: 'peak', at: 'somewhere' }), { id: 'peak/n1', kind: 'peak' });
});

test('an oversized quiz is clamped rather than written whole', () => {
  const many = Array.from({ length: MAX_FEATURES + 50 }, (_, i) => ({
    id: `peak/n${i}`, kind: 'peak' as const,
  }));
  assert.equal(specToDoc(spec({ features: many }), 'u1', 'now').features.length, MAX_FEATURES);
});

test('a long name is clamped, not refused', () => {
  const doc = specToDoc(spec({ name: 'x'.repeat(500) }), 'u1', 'now');
  assert.equal(doc.name.length, 80);
});

test('a nonsense builder state is dropped, but the quiz still loads', () => {
  // Sliders coming back at their defaults is a nuisance; a quiz that refuses
  // to load is a loss.
  const doc = { ...specToDoc(spec(), 'u1', 'now'), builder: 'not an object' };
  const out = docToSpec('q1', doc);
  assert.notEqual(out, null);
  assert.equal(out?.builder, undefined);
});

test('ownership and timestamps come from the caller, not the quiz', () => {
  const doc = specToDoc(spec(), 'u7', '2026-09-05T10:00:00.000Z');
  assert.equal(doc.ownerId, 'u7');
  assert.equal(doc.updatedAt, '2026-09-05T10:00:00.000Z');
  assert.equal(doc.createdAt, '2026-01-01T00:00:00.000Z', 'created is the quiz’s own');
});
