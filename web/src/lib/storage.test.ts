import assert from 'node:assert/strict';
import test from 'node:test';

import { hasSeen, markSeen } from './storage.ts';

/** localStorage, near enough for the two things this module does with it. */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
  return store;
}

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
