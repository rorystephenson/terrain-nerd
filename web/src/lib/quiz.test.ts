import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attempt,
  createQuiz,
  currentQuestion,
  isFinished,
  reveal,
  score,
  triesLeft,
  MAX_TRIES,
  type QuizState,
} from './quiz.ts';
import type { QuizFeature } from './types.ts';

const feature = (id: string, name: string): QuizFeature => ({
  type: 'Feature',
  id,
  bbox: [0, 0, 1, 1],
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  properties: { name, kind: 'valley', lengthKm: 10, anchor: [0.5, 0.5] },
});

const pool = Array.from({ length: 30 }, (_, i) => feature(`way/${i}`, `Val ${i}`));

/** Deterministic stand-in for Math.random. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

/** A feature id that is never the answer to the current question. */
const wrongId = (state: QuizState) =>
  pool.find((f) => !currentQuestion(state)!.acceptedIds.includes(f.id))!.id;

test('asks every feature in the zone', () => {
  assert.equal(createQuiz(pool, seeded(1)).questions.length, pool.length);
});

test('never repeats a question within a round', () => {
  const { questions } = createQuiz(pool, seeded(7));
  assert.equal(new Set(questions.map((q) => q.targetId)).size, pool.length);
});

test('replaying a zone asks the same set in a different order', () => {
  const first = createQuiz(pool, seeded(11)).questions.map((q) => q.targetId);
  const second = createQuiz(pool, seeded(29)).questions.map((q) => q.targetId);
  assert.deepEqual(new Set(first), new Set(second), 'same set of valleys');
  assert.notDeepEqual(first, second, 'different order');
});

test('a correct first click advances and counts as first-try', () => {
  const state = createQuiz(pool, seeded(2));
  const result = attempt(state, currentQuestion(state)!.targetId);
  assert.equal(result.kind, 'correct');
  assert.equal(result.state.index, 1);
  assert.equal(result.state.answers[0].firstTry, true);
  assert.equal(result.state.answers[0].revealed, false);
  assert.equal(result.state.answers[0].grade, 0, 'pure green');
});

test('a wrong click keeps the same question open and costs a try', () => {
  const state = createQuiz(pool, seeded(2));
  const asked = currentQuestion(state)!.name;
  const result = attempt(state, wrongId(state));
  assert.equal(result.kind, 'retry');
  assert.equal(result.state.index, 0, 'still on the same question');
  assert.equal(currentQuestion(result.state)!.name, asked);
  assert.equal(triesLeft(result.state), MAX_TRIES - 1);
});

/** Burns all the tries on the current question and returns the revealing state. */
const exhaust = (start: QuizState) => {
  let state = start;
  for (let i = 1; i < MAX_TRIES; i++) {
    const result = attempt(state, wrongId(state));
    assert.equal(result.kind, 'retry', `click ${i} should still allow a retry`);
    state = result.state;
  }
  const final = attempt(state, wrongId(state));
  assert.equal(final.kind, 'reveal');
  return final.state;
};

test(`shows the answer after ${MAX_TRIES} wrong clicks but does not advance`, () => {
  const state = exhaust(createQuiz(pool, seeded(2)));
  assert.equal(state.revealing, true);
  assert.equal(state.index, 0, 'stays on the same question until it is found');
  assert.equal(state.answers.length, 0);
  assert.equal(triesLeft(state), 0);
});

test('wrong clicks while the answer is showing cost nothing', () => {
  let state = exhaust(createQuiz(pool, seeded(2)));
  const before = state.misses.length;
  for (let i = 0; i < 3; i++) {
    const result = attempt(state, wrongId(state));
    assert.equal(result.kind, 'nudge');
    state = result.state;
  }
  assert.equal(state.misses.length, before, 'no extra misses recorded');
  assert.equal(state.index, 0, 'still on the same question');
  assert.equal(state.revealing, true);
});

test('clicking the shown answer advances and grades it as revealed', () => {
  const state = exhaust(createQuiz(pool, seeded(2)));
  const result = attempt(state, currentQuestion(state)!.targetId);
  assert.equal(result.kind, 'found');
  assert.equal(result.state.index, 1);
  assert.equal(result.state.revealing, false);
  assert.equal(result.state.answers[0].revealed, true);
  assert.equal(result.state.answers[0].firstTry, false);
  assert.equal(result.state.answers[0].grade, 1, 'fully red');
});

test('asking to be shown lands in the same place as running out of tries', () => {
  const state = createQuiz(pool, seeded(2));
  const asked = currentQuestion(state)!.name;
  const shown = reveal(state);
  assert.equal(shown.kind, 'reveal');
  assert.equal(shown.state.revealing, true);
  assert.equal(shown.state.index, 0, 'the question stays open until it is clicked');
  assert.equal(currentQuestion(shown.state)!.name, asked);
  assert.equal(triesLeft(shown.state), 0);

  const found = attempt(shown.state, currentQuestion(shown.state)!.targetId);
  assert.equal(found.kind, 'found');
  assert.equal(found.state.index, 1);
  assert.equal(found.state.answers[0].revealed, true);
  assert.equal(found.state.answers[0].firstTry, false);
  assert.equal(found.state.answers[0].grade, 1, 'no cheaper than being beaten by it');
});

test('asking to be shown again while it is already showing changes nothing', () => {
  const shown = reveal(createQuiz(pool, seeded(2))).state;
  const again = reveal(shown);
  assert.equal(again.kind, 'nudge');
  assert.equal(again.state, shown);
});

test('recovering on a later try is not revealed, and not first-try', () => {
  let state = createQuiz(pool, seeded(2));
  state = (attempt(state, wrongId(state)) as { state: QuizState }).state;
  const result = attempt(state, currentQuestion(state)!.targetId);
  assert.equal(result.kind, 'correct');
  assert.equal(result.state.answers[0].revealed, false);
  assert.equal(result.state.answers[0].firstTry, false);
});

test('grade darkens with each miss, from green to red', () => {
  // Every number of misses you can recover from gets its own grade, evenly
  // spaced below 1 — so each has a distinct colour, whatever MAX_TRIES is.
  const grades: number[] = [];
  for (let missCount = 0; missCount < MAX_TRIES; missCount++) {
    let state = createQuiz(pool, seeded(2));
    for (let i = 0; i < missCount; i++) {
      state = (attempt(state, wrongId(state)) as { state: QuizState }).state;
    }
    grades.push(attempt(state, currentQuestion(state)!.targetId).state.answers[0].grade);
  }
  assert.deepEqual(
    grades,
    Array.from({ length: MAX_TRIES }, (_, i) => i / MAX_TRIES),
  );
  assert.ok(grades.every((g) => g < 1), 'recovering is never graded as a reveal');
  // And a revealed answer sits at the far end.
  const shown = exhaust(createQuiz(pool, seeded(2)));
  assert.equal(attempt(shown, currentQuestion(shown)!.targetId).state.answers[0].grade, 1);
});

test('tries reset for the next question', () => {
  let state = createQuiz(pool, seeded(8));
  state = (attempt(state, wrongId(state)) as { state: QuizState }).state;
  assert.equal(triesLeft(state), MAX_TRIES - 1);
  state = attempt(state, currentQuestion(state)!.targetId).state;
  assert.equal(triesLeft(state), MAX_TRIES);
});

test('clicking empty terrain is not an answer and costs nothing', () => {
  const state = createQuiz(pool, seeded(4));
  const result = attempt(state, null);
  assert.equal(result.kind, 'nudge');
  assert.equal(result.state, state);
  assert.equal(triesLeft(result.state), MAX_TRIES);
});

test('clicking empty terrain while the answer is showing changes nothing either', () => {
  let state = createQuiz(pool, seeded(4));
  state = reveal(state).state;
  const result = attempt(state, null);
  assert.equal(result.kind, 'nudge');
  assert.equal(result.state, state);
});

test('accepts either feature when two share a name', () => {
  const twins = [feature('way/a', 'Valsorda'), feature('way/b', 'Valsorda')];
  const state = createQuiz(twins, seeded(1));
  assert.equal(state.questions.length, 1, 'one question for one name');
  assert.deepEqual(new Set(state.questions[0].acceptedIds), new Set(['way/a', 'way/b']));
  assert.equal(attempt(state, 'way/b').kind, 'correct');
});

test('percentage counts first-try answers; solved is tracked separately', () => {
  const play = (firstTry: number, recovered: number) => {
    let state = createQuiz(pool.slice(0, 4), seeded(9));
    for (let i = 0; i < 4; i++) {
      if (i < firstTry) {
        state = attempt(state, currentQuestion(state)!.targetId).state;
      } else if (i < firstTry + recovered) {
        state = (attempt(state, wrongId(state)) as { state: QuizState }).state;
        state = attempt(state, currentQuestion(state)!.targetId).state;
      } else {
        for (let t = 0; t < MAX_TRIES; t++) state = attempt(state, wrongId(state)).state;
        state = attempt(state, currentQuestion(state)!.targetId).state;
      }
    }
    return score(state);
  };
  assert.deepEqual(play(4, 0), { correct: 4, solved: 4, total: 4, pct: 100 });
  assert.deepEqual(play(0, 0), { correct: 0, solved: 0, total: 4, pct: 0 });
  assert.deepEqual(play(1, 1), { correct: 1, solved: 2, total: 4, pct: 25 });
});

test('reports finished only after the last question', () => {
  let state = createQuiz(pool.slice(0, 2), seeded(5));
  assert.equal(isFinished(state), false);
  state = attempt(state, currentQuestion(state)!.targetId).state;
  assert.equal(isFinished(state), false);
  state = attempt(state, currentQuestion(state)!.targetId).state;
  assert.equal(isFinished(state), true);
  assert.equal(currentQuestion(state), null);
});

test('attempting past the end is a no-op', () => {
  let state = createQuiz(pool.slice(0, 1), seeded(6));
  state = attempt(state, currentQuestion(state)!.targetId).state;
  assert.deepEqual(attempt(state, 'way/0').state, state);
});
