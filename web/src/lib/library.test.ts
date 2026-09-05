import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeBest, planSync, sameQuiz, winnerOf, type Side } from './library.ts';
import type { QuizSpec } from './types.ts';

const quiz = (id: string, over: Partial<QuizSpec> = {}): QuizSpec => ({
  id,
  name: id,
  source: 'built',
  createdAt: '2026-01-01T00:00:00.000Z',
  features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa' }],
  bbox: [10, 46, 11, 47],
  ...over,
});

const side = (quizzes: QuizSpec[], best: Record<string, number> = {}): Side => ({ quizzes, best });

test('a first sign-in offers what is here and takes what is there', () => {
  const plan = planSync(side([quiz('a')]), side([quiz('b')]));
  assert.deepEqual(plan.upload.map((q) => q.id), ['a']);
  assert.deepEqual(plan.adopt.map((q) => q.id), ['b']);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.settled, false);
});

test('best scores merge by max, in both directions', () => {
  const plan = planSync(side([], { a: 90, b: 10 }), side([], { a: 40, c: 70 }));
  assert.deepEqual(plan.best, { a: 90, b: 10, c: 70 });
  // The account already knows about a=40 and c=70; it needs a=90 and b=10.
  assert.deepEqual(plan.bestToPush, { a: 90, b: 10 });
});

test('a score the account already has better is not pushed back down', () => {
  const plan = planSync(side([], { a: 40 }), side([], { a: 90 }));
  assert.deepEqual(plan.best, { a: 90 });
  assert.deepEqual(plan.bestToPush, {});
});

test('planning is idempotent: apply it, re-plan, and there is nothing to do', () => {
  // This is what makes it safe to run on every sign-in rather than only the
  // first one.
  const local = side([quiz('a')], { a: 90, b: 10 });
  const remote = side([quiz('b')], { a: 40, c: 70 });

  const first = planSync(local, remote);
  const applied = side(
    [...remote.quizzes, ...first.upload],
    { ...remote.best, ...first.bestToPush },
  );
  const second = planSync(side([...local.quizzes, ...first.adopt], first.best), applied);

  assert.equal(second.settled, true, 'nothing left to do');
  assert.deepEqual(second.upload, []);
  assert.deepEqual(second.adopt, []);
  assert.deepEqual(second.bestToPush, {});
});

test('two sides that already agree are settled', () => {
  const both = [quiz('a')];
  assert.equal(planSync(side(both, { a: 50 }), side(both, { a: 50 })).settled, true);
});

test('the same id with different contents is a conflict, not a silent overwrite', () => {
  const mine = quiz('a', { name: 'Brenta' });
  const theirs = quiz('a', { name: 'Adamello' });
  const plan = planSync(side([mine]), side([theirs]));

  assert.deepEqual(plan.upload, [], 'not treated as new');
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].local.name, 'Brenta');
});

test('a difference only in derived detail is not a conflict', () => {
  // Names and anchors come from the pool, so a difference in them says nothing
  // about intent and must not put a question in front of anyone.
  const here = quiz('a', {
    features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa' }],
  });
  const there = quiz('a', {
    // The same feature, described from a pool built a day apart: the anchor
    // moved a few metres and the spelling was tidied in OSM.
    features: [{ id: 'peak/n1', kind: 'peak', name: 'Cima Tosa ' }],
  });

  assert.equal(sameQuiz(here, there), true);
  assert.deepEqual(planSync(side([here]), side([there])).conflicts, []);
});

test('a different set of features is a conflict even under the same name', () => {
  const four = quiz('a', {
    features: [
      { id: 'peak/n1', kind: 'peak', name: 'A' },
      { id: 'peak/n2', kind: 'peak', name: 'B' },
    ],
  });
  assert.equal(sameQuiz(quiz('a'), four), false);
});

test('the most recently edited side wins, and a tie goes to the account', () => {
  const older = quiz('a', { updatedAt: '2026-01-01T00:00:00.000Z' });
  const newer = quiz('a', { updatedAt: '2026-06-01T00:00:00.000Z' });

  assert.equal(winnerOf({ local: newer, remote: older }), newer);
  assert.equal(winnerOf({ local: older, remote: newer }), newer);

  const tie = quiz('a', { updatedAt: '2026-06-01T00:00:00.000Z' });
  assert.equal(winnerOf({ local: tie, remote: newer }), newer, 'the account holds a tie');
});

test('a quiz saved before updatedAt existed falls back to when it was created', () => {
  const old = quiz('a', { createdAt: '2026-01-01T00:00:00.000Z' });
  const recent = quiz('a', { createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' });
  assert.equal(winnerOf({ local: recent, remote: old }), recent);
});

test('merging scores never loses a quiz either side had heard of', () => {
  assert.deepEqual(mergeBest({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(mergeBest({}, {}), {});
  // Order cannot matter, or sync would depend on which machine went first.
  assert.deepEqual(mergeBest({ a: 1, b: 5 }, { a: 9 }), mergeBest({ a: 9 }, { a: 1, b: 5 }));
});
