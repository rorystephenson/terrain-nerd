import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FILE_VERSION,
  hasSeen,
  makeQuizFile,
  markSeen,
  mergeQuizFile,
  quizFilename,
  readQuizFile,
} from './storage.ts';
import type { QuizSpec } from './types.ts';

const quiz = (id: string, name = id, ids = ['peak/n1']): QuizSpec => ({
  id,
  name,
  source: 'built',
  createdAt: '2026-08-29T00:00:00.000Z',
  features: ids.map((featureId) => ({
    id: featureId,
    kind: featureId.split('/')[0] as QuizSpec['features'][number]['kind'],
    name: 'Cima Tosa',
    at: [10.87, 46.16] as [number, number],
  })),
  bbox: [10, 46, 11, 47],
});

test('a quiz file round-trips through JSON', () => {
  const parsed = readQuizFile(JSON.stringify(makeQuizFile([quiz('a', 'Val Rendena')])));
  assert.equal(parsed.quizzes.length, 1);
  assert.equal(parsed.quizzes[0].name, 'Val Rendena');
});

test('a saved file carries the quiz and nothing about progress', () => {
  // Scores are personal to the browser that earned them; a quiz file is the
  // quiz as a thing you made.
  const file = makeQuizFile([quiz('a')]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(file).sort(), ['app', 'exportedAt', 'quizzes', 'version']);
  assert.equal('best' in file, false);
  assert.equal(JSON.stringify(file).includes('best'), false);
});

test('non-JSON is refused with a readable message', () => {
  assert.throws(() => readQuizFile('not json at all'), /not JSON/);
});

test('someone else’s JSON is refused', () => {
  assert.throws(() => readQuizFile(JSON.stringify({ hello: 'world' })), /not a Terrain Nerd/);
  assert.throws(() => readQuizFile(JSON.stringify({ app: 'other', version: 1 })), /not a Terrain Nerd/);
});

test('an unsupported version is refused rather than half-read', () => {
  const future = { ...makeQuizFile([quiz('a')]), version: 99 };
  assert.throws(() => readQuizFile(JSON.stringify(future)), /version 99/);
});

test('malformed quizzes are refused, not silently dropped', () => {
  const broken = { ...makeQuizFile([]), quizzes: [{ id: 'a', name: 'no ids or bbox' }] };
  assert.throws(() => readQuizFile(JSON.stringify(broken)), /readable quiz/);

  const badBbox = { ...makeQuizFile([]), quizzes: [{ ...quiz('a'), bbox: [10, 46, 11] }] };
  assert.throws(() => readQuizFile(JSON.stringify(badBbox)), /readable quiz/);
});

test('an older file carrying scores still imports, ignoring them', () => {
  const legacy = { ...makeQuizFile([quiz('a')]), best: { a: 80 } };
  const parsed = readQuizFile(JSON.stringify(legacy)) as Record<string, unknown>;
  assert.equal('best' in parsed, false, 'scores in the file are dropped, not honoured');
  assert.equal((parsed.quizzes as QuizSpec[]).length, 1);
});

test('importing merges rather than replacing what is already here', () => {
  const merged = mergeQuizFile([quiz('mine')], makeQuizFile([quiz('theirs')]));
  assert.deepEqual(merged.quizzes.map((q) => q.id).sort(), ['mine', 'theirs']);
  assert.equal(merged.added, 1);
  assert.equal(merged.replaced, 0);
});

test('a quiz with the same id is replaced by the incoming copy', () => {
  const merged = mergeQuizFile([quiz('a', 'old name')], makeQuizFile([quiz('a', 'new name')]));
  assert.equal(merged.quizzes.length, 1);
  assert.equal(merged.quizzes[0].name, 'new name');
  assert.equal(merged.replaced, 1);
  assert.equal(merged.added, 0);
});

test('importing the same file twice changes nothing the second time', () => {
  const file = makeQuizFile([quiz('a'), quiz('b')]);
  const once = mergeQuizFile([], file);
  const twice = mergeQuizFile(once.quizzes, file);
  assert.deepEqual(twice.quizzes.map((q) => q.id), once.quizzes.map((q) => q.id));
  assert.equal(twice.added, 0, 'nothing new the second time');
});

test('quiz filenames are safe and readable', () => {
  assert.equal(quizFilename('Val Rendena'), 'terrain-nerd-val-rendena.json');
  assert.equal(quizFilename("Carè Alto & Val d'Algone"), 'terrain-nerd-care-alto-val-d-algone.json');
  assert.equal(quizFilename('  ///  '), 'terrain-nerd-quiz.json', 'a nameless quiz still gets a file');
  assert.equal(quizFilename('../../etc/passwd'), 'terrain-nerd-etc-passwd.json', 'no path separators');
  assert.ok(quizFilename('x'.repeat(200)).length < 80, 'long names are trimmed');
});

/** Just enough of the Storage interface for the two calls under test. */
function fakeStorage(fails = false) {
  const cells = new Map<string, string>();
  return {
    getItem: (key: string) => {
      if (fails) throw new Error('site data is blocked');
      return cells.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (fails) throw new Error('site data is blocked');
      cells.set(key, value);
    },
  } as unknown as Storage;
}

test('an explainer is shown until it has been seen, then never again', () => {
  globalThis.localStorage = fakeStorage();
  assert.equal(hasSeen('build:area'), false, 'first time through');
  markSeen('build:area');
  assert.equal(hasSeen('build:area'), true);
  assert.equal(hasSeen('build:features'), false, 'seeing one says nothing about the other');
});

test('a browser that refuses site data just shows the explainer again', () => {
  // Private browsing throws on the plain read; the builder should still work,
  // it should not blow up.
  globalThis.localStorage = fakeStorage(true);
  assert.doesNotThrow(() => markSeen('build:area'));
  assert.equal(hasSeen('build:area'), false);
});

test('a version 1 file still imports, and its ids become references', () => {
  // The shape written before features carried their own names. Someone has one
  // of these on disk; refusing it would lose them the quiz.
  const v1 = JSON.stringify({
    app: 'terrain-nerd',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    quizzes: [
      {
        id: 'q1',
        name: 'Brenta',
        source: 'built',
        createdAt: '2026-01-01T00:00:00.000Z',
        featureIds: ['peak/n1', 'valley/w2'],
        bbox: [10, 46, 11, 47],
      },
    ],
  });

  const file = readQuizFile(v1);
  assert.equal(file.version, FILE_VERSION);
  assert.deepEqual(file.quizzes[0].features, [
    { id: 'peak/n1', kind: 'peak' },
    { id: 'valley/w2', kind: 'valley' },
  ]);
  assert.equal(file.quizzes[0].featureIds, undefined, 'the legacy field is not carried forward');
});

test('a file from a future version is refused rather than half-read', () => {
  const v9 = JSON.stringify({ app: 'terrain-nerd', version: 9, quizzes: [] });
  assert.throws(() => readQuizFile(v9), /version 9 is not supported/);
});
