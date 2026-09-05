import assert from 'node:assert/strict';
import test from 'node:test';

import { hasSeen, markSeen, recordBest } from './storage.ts';
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
