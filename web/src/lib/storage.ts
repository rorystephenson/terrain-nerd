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

export const newQuizId = (): string =>
  `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * A saved quiz file.
 *
 * Deliberately carries the quiz only, never your scores. A saved file is the
 * quiz as a thing you made — something you could keep, re-import after clearing
 * site data, or hand to another pilot — and progress is personal to the browser
 * that earned it. Restoring therefore never touches your best scores either way.
 */
export type QuizFile = {
  app: 'terrain-nerd';
  version: 1;
  exportedAt: string;
  quizzes: QuizSpec[];
};

export const FILE_VERSION = 1;

export function makeQuizFile(quizzes: QuizSpec[]): QuizFile {
  return {
    app: 'terrain-nerd',
    version: FILE_VERSION,
    exportedAt: new Date().toISOString(),
    quizzes,
  };
}

const isQuiz = (value: unknown): value is QuizSpec => {
  const quiz = value as QuizSpec | null;
  return (
    typeof quiz?.id === 'string' &&
    typeof quiz.name === 'string' &&
    Array.isArray(quiz.featureIds) &&
    quiz.featureIds.every((id) => typeof id === 'string') &&
    Array.isArray(quiz.bbox) &&
    quiz.bbox.length === 4 &&
    quiz.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
};

/**
 * Validates a file someone hands us.
 *
 * A quiz file is the one thing here that comes from outside the app, so it is
 * checked rather than trusted: a malformed import that half-succeeded would be
 * worse than one that refused.
 */
export function readQuizFile(text: string): QuizFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON.');
  }

  const file = parsed as Partial<QuizFile> | null;
  if (file?.app !== 'terrain-nerd') throw new Error('That is not a Terrain Nerd quiz file.');
  if (file.version !== FILE_VERSION) {
    throw new Error(`Quiz file version ${String(file.version)} is not supported.`);
  }
  if (!Array.isArray(file.quizzes) || !file.quizzes.every(isQuiz)) {
    throw new Error('That file does not contain a readable quiz.');
  }

  // Any other fields — an older file's scores, say — are ignored rather than
  // rejected, so a file written before scores were dropped still imports.
  return {
    app: 'terrain-nerd',
    version: FILE_VERSION,
    exportedAt: String(file.exportedAt ?? ''),
    quizzes: file.quizzes,
  };
}

export type MergeResult = {
  quizzes: QuizSpec[];
  added: number;
  replaced: number;
};

/**
 * Folds an imported file into what is already here.
 *
 * Merges rather than overwrites, so importing onto a browser that has its own
 * quizzes cannot silently destroy them. Same id means the same quiz and the
 * incoming copy wins — but your best score for it is left exactly as it was,
 * since the file never carried one.
 */
export function mergeQuizFile(current: QuizSpec[], file: QuizFile): MergeResult {
  const byId = new Map(current.map((quiz) => [quiz.id, quiz]));
  let added = 0;
  let replaced = 0;

  for (const quiz of file.quizzes) {
    if (byId.has(quiz.id)) replaced++;
    else added++;
    byId.set(quiz.id, quiz);
  }

  return { quizzes: [...byId.values()], added, replaced };
}

/** Persists a merged import in one go. */
export const saveQuizzes = (quizzes: QuizSpec[]): boolean => write(QUIZ_KEY, quizzes);

/** A quiz name turned into something safe to write to disk. */
export function quizFilename(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Val d'Algone, Care Alto: strip the accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `terrain-nerd-${slug || 'quiz'}.json`;
}
