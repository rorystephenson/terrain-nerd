/**
 * Saved quizzes and best scores, in localStorage.
 *
 * Every access is wrapped: private browsing and blocked site data throw on
 * plain reads, and a quiz being unsaveable is not a reason to interrupt someone
 * mid-game. Failures degrade to "it just doesn't persist".
 */
import type { QuizSpec } from './types.ts';

const QUIZ_KEY = 'terrain-nerd:quizzes';
const BEST_KEY = 'terrain-nerd:best';
const SEEN_KEY = 'terrain-nerd:seen';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadQuizzes = (): QuizSpec[] => read<QuizSpec[]>(QUIZ_KEY, []);

/** Adds or replaces by id, newest first. */
export function saveQuiz(quiz: QuizSpec): QuizSpec[] {
  const rest = loadQuizzes().filter((q) => q.id !== quiz.id);
  const next = [quiz, ...rest];
  write(QUIZ_KEY, next);
  return next;
}

export function deleteQuiz(id: string): QuizSpec[] {
  const next = loadQuizzes().filter((q) => q.id !== id);
  write(QUIZ_KEY, next);
  return next;
}

export const loadBest = (): Record<string, number> => read<Record<string, number>>(BEST_KEY, {});

/** Records a score only when it beats what is already there. */
export function recordBest(
  best: Record<string, number>,
  quizId: string,
  pct: number,
): Record<string, number> {
  if (best[quizId] !== undefined && best[quizId] >= pct) return best;
  const next = { ...best, [quizId]: pct };
  write(BEST_KEY, next);
  return next;
}

/**
 * Explainers that have already had their one showing.
 *
 * The builder's panels each carry a paragraph saying how that step works. It is
 * worth reading once and is dead weight forever after — and on a phone it is
 * dead weight occupying a third of the panel, above the controls it explains.
 * So each is shown until it has been, and then the space goes back to the map.
 *
 * Stored per explainer rather than as one "has built a quiz before" flag,
 * because the two steps are not necessarily met together: someone editing a
 * saved quiz lands straight on the features panel and may never have seen the
 * area one.
 */
export const hasSeen = (id: string): boolean =>
  read<Record<string, boolean>>(SEEN_KEY, {})[id] === true;

export function markSeen(id: string): void {
  const seen = read<Record<string, boolean>>(SEEN_KEY, {});
  if (seen[id]) return;
  write(SEEN_KEY, { ...seen, [id]: true });
}

export const newQuizId = (): string =>
  `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Persists a whole list in one go.
 *
 * Used by the session to mirror the account's quizzes locally, so a browser
 * that opens offline still has them.
 */
export const saveQuizzes = (quizzes: QuizSpec[]): boolean => write(QUIZ_KEY, quizzes);
