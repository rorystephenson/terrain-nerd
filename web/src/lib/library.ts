/**
 * Reconciling what is in this browser with what is in the account.
 *
 * Signing in is the one moment where two sets of quizzes and two sets of scores
 * have to become one. Anonymous auth means the usual case is not a merge at all
 * — `linkWithPopup` keeps the uid, so the data was already the account's data.
 * The merge is for the case that link cannot handle: signing in with a Google
 * account that already exists, which is what happens on the second machine.
 *
 * Kept pure and Firebase-free on purpose. This is the logic that can lose
 * someone's quizzes if it is wrong, so it is the logic that gets tested.
 *
 * The property that makes it safe to run on *every* sign-in rather than only
 * the first is idempotence: applying a plan and re-planning yields nothing to
 * do. Best scores merge by `Math.max`, which is commutative, associative and
 * idempotent, so there is no ordering to get right and never a conflict to ask
 * anybody about.
 */
import type { QuizSpec } from './types.ts';

export type Conflict = { local: QuizSpec; remote: QuizSpec };

export type SyncPlan = {
  /** Here but not in the account. Needs the owner's say-so before it goes up. */
  upload: QuizSpec[];
  /** In the account but not here. Arrives silently — it is already theirs. */
  adopt: QuizSpec[];
  /**
   * The same id on both sides with different contents.
   *
   * Only reachable by exporting a quiz to a file and importing it elsewhere,
   * since ids are minted per browser. Rare, but not rare enough to lose an
   * edit over.
   */
  conflicts: Conflict[];
  /** Every score either side knew about, at the best value either side had. */
  best: Record<string, number>;
  /** The subset the account does not yet know is that good. */
  bestToPush: Record<string, number>;
  /** True when both sides already agree and nothing needs doing. */
  settled: boolean;
};

export type Side = { quizzes: readonly QuizSpec[]; best: Readonly<Record<string, number>> };

/** When a quiz was last touched, falling back for quizzes saved before that was recorded. */
export const touchedAt = (quiz: QuizSpec): string => quiz.updatedAt ?? quiz.createdAt;

/**
 * Same quiz, same contents?
 *
 * Compares what a round is built from and what the list shows, not the whole
 * object: a quiz healed on one machine and not the other differs in ways that
 * are derivable from the pool, and treating that as a conflict would put a
 * question in front of someone for no reason.
 */
export function sameQuiz(a: QuizSpec, b: QuizSpec): boolean {
  if (a.name !== b.name) return false;
  if (a.features.length !== b.features.length) return false;
  return a.features.every((ref, i) => ref.id === b.features[i].id);
}

/** The better of two scores for every quiz either side has heard of. */
export function mergeBest(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [id, pct] of Object.entries(b)) {
    if (out[id] === undefined || pct > out[id]) out[id] = pct;
  }
  return out;
}

export function planSync(local: Side, remote: Side): SyncPlan {
  const mine = new Map(local.quizzes.map((quiz) => [quiz.id, quiz]));
  const theirs = new Map(remote.quizzes.map((quiz) => [quiz.id, quiz]));

  const upload: QuizSpec[] = [];
  const conflicts: Conflict[] = [];
  for (const quiz of local.quizzes) {
    const other = theirs.get(quiz.id);
    if (!other) upload.push(quiz);
    else if (!sameQuiz(quiz, other)) conflicts.push({ local: quiz, remote: other });
  }

  const adopt = remote.quizzes.filter((quiz) => !mine.has(quiz.id));

  const best = mergeBest(local.best, remote.best);
  const bestToPush: Record<string, number> = {};
  for (const [id, pct] of Object.entries(best)) {
    if (remote.best[id] === undefined || remote.best[id] < pct) bestToPush[id] = pct;
  }

  return {
    upload,
    adopt,
    conflicts,
    best,
    bestToPush,
    settled:
      upload.length === 0 &&
      adopt.length === 0 &&
      conflicts.length === 0 &&
      Object.keys(bestToPush).length === 0,
  };
}

/**
 * Which side of a conflict wins: the one edited most recently.
 *
 * The loser is not thrown away by this function — the caller is expected to
 * offer it as a file. Losing an edit silently is the one outcome this whole
 * path exists to avoid, and a tie goes to the account, because that is the copy
 * the other machines will also see.
 */
export const winnerOf = ({ local, remote }: Conflict): QuizSpec =>
  touchedAt(local) > touchedAt(remote) ? local : remote;
