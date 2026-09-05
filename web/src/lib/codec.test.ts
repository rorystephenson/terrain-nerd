import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CELL_ZOOM,
  docToPublished,
  docToSpec,
  hasUndefined,
  readRef,
  specToDoc,
  specToPublished,
  MAX_FEATURES,
} from './codec.ts';
import type { QuizSpec } from './types.ts';

const spec = (over: Partial<QuizSpec> = {}): QuizSpec => ({
  id: 'q1',
  name: 'Brenta',
  source: 'built',
  createdAt: '2026-01-01T00:00:00.000Z',
  features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa' }],
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
      { id: 'peak/n2', kind: 'wyvern', name: 'X' }, // not a kind this app has
      null,
      { kind: 'peak', name: 'X' }, // no id
      { id: 'peak/n4', kind: 'peak' }, // no name: could not say what was lost
      { id: 'valley/w3', kind: 'valley', name: 'Val' },
    ],
  };
  assert.deepEqual(docToSpec('q1', doc)?.features.map((f) => f.id), ['peak/n1', 'valley/w3']);
});

test('a reference is exactly three fields, and nothing else is carried', () => {
  assert.deepEqual(readRef({ id: 'peak/n1', kind: 'peak', name: 'X' }), {
    id: 'peak/n1', kind: 'peak', name: 'X',
  });
  // Whatever else a document holds is not a reference's business — an older
  // shape carrying anchors and wikidata reads as the three fields it has.
  assert.deepEqual(readRef({ id: 'peak/n1', kind: 'peak', name: 'X', at: [1, 2], wikidata: 'Q1' }), {
    id: 'peak/n1', kind: 'peak', name: 'X',
  });
  assert.equal(readRef({ id: 'peak/n1', kind: 'peak' }), null, 'no name');
  assert.equal(readRef({ id: 'peak/n1', kind: 'peak', name: '' }), null, 'an empty name is no name');
  assert.equal(readRef({ kind: 'peak', name: 'X' }), null, 'no id');
  assert.equal(readRef({ id: 'peak/n1', kind: 'wyvern', name: 'X' }), null, 'not a kind we have');
  assert.equal(readRef(null), null);
});

test('an oversized quiz is clamped rather than written whole', () => {
  const many = Array.from({ length: MAX_FEATURES + 50 }, (_, i) => ({
    id: `peak/n${i}`, kind: 'peak' as const, name: `Peak ${i}`,
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

test('publishing keeps what a round needs and drops what only the builder wanted', () => {
  const draft = spec({
    poolAt: '2026-08-01',
    builder: { kinds: { peak: true }, ranges: {}, overrides: { 'peak/n1': 'in' } },
    features: [
      { id: 'peak/n1', kind: 'peak', name: 'Cima Tosa' },
      { id: 'valley/w2', kind: 'valley', name: 'Val Rendena' },
    ],
  });
  const doc = specToPublished(draft, { id: 'u1', name: 'Rory' }, 1, '2026-09-05T00:00:00.000Z');

  assert.equal('builder' in doc, false, 'editing state is not published');
  assert.equal(doc.poolAt, '2026-08-01', 'which pool build the ids were true of');
  assert.equal(doc.ownerName, 'Rory');
  assert.equal(doc.version, 1);
  assert.equal(doc.players, 0);
  assert.equal(doc.hidden, false);
  assert.deepEqual(doc.counts, { valley: 1, peak: 1, pass: 0, questions: 2 });
  assert.deepEqual([...doc.kinds].sort(), ['peak', 'valley']);
  assert.equal(hasUndefined(doc), false);
});

test('the headline count is questions, not features', () => {
  // Two features sharing a name are one question, and the score is a
  // percentage of questions — so a quiz must not advertise the other number.
  const draft = spec({
    features: [
      { id: 'valley/w1', kind: 'valley', name: 'Valsorda' },
      { id: 'valley/w2', kind: 'valley', name: 'valsorda ' },
      { id: 'peak/n3', kind: 'peak', name: 'Cima Tosa' },
    ],
  });
  const doc = specToPublished(draft, { id: 'u1', name: 'Rory' }, 1, 'now');
  assert.equal(doc.features.length, 3);
  assert.equal(doc.counts.questions, 2);
});

test('a published quiz carries the cells it sits in, for finding it by ground', () => {
  const doc = specToPublished(spec(), { id: 'u1', name: 'Rory' }, 1, 'now');
  assert.equal(doc.cellZoom, CELL_ZOOM);
  assert.ok(doc.cells.length > 0 && doc.cells.length <= 24);
  assert.ok(doc.cells.every((c) => /^x\d+y\d+$/.test(c)), 'the pool’s own cell key shape');
});

test('a published document round-trips into something playable', () => {
  const draft = spec({ name: 'Brenta' });
  const doc = specToPublished(draft, { id: 'u1', name: 'Rory' }, 3, '2026-09-05T00:00:00.000Z');
  const back = docToPublished('q1', doc);

  assert.equal(back?.ownerName, 'Rory');
  assert.equal(back?.version, 3);
  assert.equal(back?.spec.name, 'Brenta');
  assert.deepEqual(back?.spec.features, draft.features);
});

test('a published document that is not a quiz is refused', () => {
  assert.equal(docToPublished('q1', { ownerName: 'Rory', version: 1 }), null);
  assert.equal(docToPublished('q1', null), null);
});

test('missing or nonsense metadata falls back rather than failing the quiz', () => {
  // Someone else wrote this document and no rule has looked inside `features`.
  const doc = { ...specToPublished(spec(), { id: 'u1', name: 'Rory' }, 1, 'now') };
  const back = docToPublished('q1', { ...doc, version: -5, players: 'lots', counts: 'nope', ownerName: 42 });
  assert.equal(back?.version, 1);
  assert.equal(back?.players, 0);
  assert.equal(back?.ownerName, '');
  assert.equal(back?.questions, 1, 'recomputed from the features it does have');
});
