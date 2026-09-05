import assert from 'node:assert/strict';
import test from 'node:test';

import { hasSeen, markSeen, migrateSpec, recordBest } from './storage.ts';
import type { QuizSpec } from './types.ts';

/** localStorage, near enough for the two things this module does with it. */
function stubStorage(): void {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

const quiz = (over: Partial<QuizSpec> = {}): QuizSpec => ({
  id: 'q1',
  name: 'Brenta',
  source: 'built',
  createdAt: '2026-01-01T00:00:00.000Z',
  features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa', at: [10.87, 46.16] }],
  bbox: [10, 46, 11, 47],
  ...over,
});

test('a quiz saved before features carried names is lifted to references', () => {
  // The kind is recoverable from the id's prefix, and nothing else is: the
  // names and anchors live in the pool, so they arrive the first time it is
  // played. See `heal.ts`.
  const old = { ...quiz(), features: undefined, featureIds: ['peak/n1', 'valley/w2'] };
  const lifted = migrateSpec(old as unknown as QuizSpec);

  assert.deepEqual(lifted.features, [
    { id: 'peak/n1', kind: 'peak' },
    { id: 'valley/w2', kind: 'valley' },
  ]);
  assert.equal('featureIds' in lifted, false, 'the legacy field is not carried forward');
  assert.equal(lifted.name, 'Brenta', 'everything else survives');
});

test('a quiz that is already current is returned untouched', () => {
  const current = quiz();
  assert.equal(migrateSpec(current), current);
});

test('a quiz with neither field migrates to an empty set rather than throwing', () => {
  const broken = { ...quiz(), features: undefined, featureIds: undefined };
  assert.deepEqual(migrateSpec(broken as unknown as QuizSpec).features, []);
});

test('a score is recorded only when it beats what is already there', () => {
  stubStorage();
  const first = recordBest({}, 'q1', 40);
  assert.deepEqual(first, { q1: 40 });

  const better = recordBest(first, 'q1', 90);
  assert.deepEqual(better, { q1: 90 });

  // Identity, not equality: an unbeaten score must not touch storage at all.
  const worse = recordBest(better, 'q1', 50);
  assert.equal(worse, better);
  assert.equal(recordBest(better, 'q1', 90), better, 'equalling it is not beating it');
});

test('scores for different quizzes do not disturb each other', () => {
  stubStorage();
  const both = recordBest(recordBest({}, 'q1', 40), 'q2', 90);
  assert.deepEqual(both, { q1: 40, q2: 90 });
});

test('an explainer is shown until it has been seen, then never again', () => {
  stubStorage();
  assert.equal(hasSeen('area'), false);
  markSeen('area');
  assert.equal(hasSeen('area'), true);
  assert.equal(hasSeen('features'), false, 'each is remembered on its own');
});

test('a browser that refuses site data just shows the explainer again', () => {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(hasSeen('area'), false);
  assert.doesNotThrow(() => markSeen('area'));
  assert.equal(hasSeen('area'), false);
});
