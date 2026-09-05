import type { QuizFeature } from './types.ts';

export type Question = {
  /** The name shown to the player. */
  name: string;
  /** Every feature that this name legitimately refers to. */
  acceptedIds: string[];
  /** The canonical one, highlighted when revealing the answer. */
  targetId: string;
};

export type AnsweredQuestion = Question & {
  /** Wrong clicks that counted against the tries. */
  misses: string[];
  /** Found without a single wrong click — what the score is based on. */
  firstTry: boolean;
  /** The tries ran out and the answer had to be pointed out. */
  revealed: boolean;
  /**
   * 0 = found first try, 1 = had to be shown. Drives the colour the feature
   * keeps on the map, so a near miss reads differently from a blank.
   */
  grade: number;
};

export type QuizState = {
  questions: Question[];
  index: number;
  /** Wrong clicks so far on the current question. */
  misses: string[];
  /**
   * True once the tries are spent. The answer is on screen and the question
   * stays open until the player clicks it — further wrong clicks cost nothing.
   */
  revealing: boolean;
  answers: AnsweredQuestion[];
};

/** Wrong clicks allowed before the answer is given away. */
export const MAX_TRIES = 3;

/** What a click did. The UI drives its feedback off this. */
export type AttemptOutcome =
  | { kind: 'correct'; state: QuizState }
  | { kind: 'retry'; state: QuizState; missedId: string | null; triesLeft: number }
  /** Tries just ran out. Does not advance — the answer must be clicked. */
  | { kind: 'reveal'; state: QuizState; missedId: string | null }
  /** A wrong click while the answer is showing. Costs nothing. */
  | { kind: 'nudge'; state: QuizState }
  /** The revealed answer was finally clicked. */
  | { kind: 'found'; state: QuizState };

/** Fisher–Yates, on a copy. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Two spellings of a name are one name.
 *
 * Exported because this rule decides what counts as a single question, and
 * everything that counts questions — the builder's tally, a published quiz's
 * headline number, the fallback that finds a feature whose id has moved — has
 * to agree with the round itself about it. It had drifted into four copies.
 */
export const normalizeName = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Turns a zone's features into a round of questions.
 *
 * Every feature in the zone is asked — only the order is shuffled. That is the
 * whole point of zones: replaying the same fixed set is what lets you tell
 * whether you are improving, which a fresh random sample never could.
 *
 * Questions are keyed by *name*, not by feature: where two features share a
 * name there is no way for the player to tell which one is meant, so a click on
 * either counts.
 */
export function createQuiz(
  features: readonly QuizFeature[],
  random: () => number = Math.random,
): QuizState {
  const byName = new Map<string, QuizFeature[]>();
  for (const feature of features) {
    const key = normalizeName(feature.properties.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(feature);
    else byName.set(key, [feature]);
  }

  const questions = shuffle([...byName.values()], random).map((group) => ({
    name: group[0].properties.name,
    acceptedIds: group.map((f) => f.id),
    targetId: group[0].id,
  }));

  return { questions, index: 0, misses: [], revealing: false, answers: [] };
}

export const currentQuestion = (state: QuizState): Question | null =>
  state.questions[state.index] ?? null;

export const isFinished = (state: QuizState): boolean => state.index >= state.questions.length;

export const triesLeft = (state: QuizState): number =>
  state.revealing ? 0 : Math.max(0, MAX_TRIES - state.misses.length);

/** 0 when found first try, 1 when it had to be shown. */
export const gradeFor = (misses: number, revealed: boolean): number =>
  revealed ? 1 : Math.min(1, misses / MAX_TRIES);

function complete(
  state: QuizState,
  question: Question,
  misses: string[],
  revealed: boolean,
): QuizState {
  return {
    ...state,
    index: state.index + 1,
    misses: [],
    revealing: false,
    answers: [
      ...state.answers,
      {
        ...question,
        misses,
        firstTry: !revealed && misses.length === 0,
        revealed,
        grade: gradeFor(misses.length, revealed),
      },
    ],
  };
}

/**
 * Registers one click on the current question.
 *
 * A wrong click costs a try. When the tries run out the answer is shown but the
 * question stays open: the player has to click it before moving on, and wrong
 * clicks in the meantime cost nothing. Being shown where it is teaches far less
 * than having to go and find it.
 *
 * Clicking bare ground is not an answer at all. It says nothing about what the
 * player thinks — a slipped finger, a tap to dismiss something, a click meant
 * for the map itself — so it costs nothing and leaves the question untouched.
 */
export function attempt(state: QuizState, clickedId: string | null): AttemptOutcome {
  const question = currentQuestion(state);
  if (!question) return { kind: 'correct', state };
  if (clickedId === null) return { kind: 'nudge', state };

  const hit = question.acceptedIds.includes(clickedId);

  if (state.revealing) {
    if (hit) return { kind: 'found', state: complete(state, question, state.misses, true) };
    return { kind: 'nudge', state };
  }

  if (hit) return { kind: 'correct', state: complete(state, question, state.misses, false) };

  const misses = [...state.misses, clickedId];
  if (misses.length >= MAX_TRIES) {
    return { kind: 'reveal', state: { ...state, misses, revealing: true }, missedId: clickedId };
  }
  return {
    kind: 'retry',
    state: { ...state, misses },
    missedId: clickedId,
    triesLeft: MAX_TRIES - misses.length,
  };
}

/**
 * The player asks to be shown, without spending the tries first.
 *
 * It lands in exactly the same place as running out of tries: the answer starts
 * flashing, the question stays open until it is clicked, and it grades as
 * revealed. Clicking three wrong things on purpose to get there taught nothing,
 * so there is no reason to make anyone do it — and grading it any softer than a
 * genuine reveal would quietly make giving up the cheaper move.
 */
export function reveal(state: QuizState): AttemptOutcome {
  const question = currentQuestion(state);
  if (!question || state.revealing) return { kind: 'nudge', state };
  return { kind: 'reveal', state: { ...state, revealing: true }, missedId: null };
}

export function score(state: QuizState): {
  correct: number;
  solved: number;
  total: number;
  pct: number;
} {
  const correct = state.answers.filter((a) => a.firstTry).length;
  const solved = state.answers.filter((a) => !a.revealed).length;
  const total = state.questions.length;
  return { correct, solved, total, pct: total === 0 ? 0 : Math.round((correct / total) * 100) };
}
