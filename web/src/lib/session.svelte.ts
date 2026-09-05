/**
 * Where the quizzes and the scores come from, whoever you are.
 *
 * One object, so that the question "localStorage or Firestore?" is answered in
 * exactly one file and never inside a component. `App.svelte` reads
 * `session.quizzes` and `session.best` and calls `session.save()`; it does not
 * know whether anything reached a server, and it should not have to.
 *
 * The order of events matters and is deliberate:
 *
 * 1. `init()` reads localStorage **synchronously**, so the quiz list paints on
 *    the first frame exactly as it always has. No spinner appears where there
 *    was never a wait.
 * 2. The Firebase SDK is then fetched by dynamic import — a few hundred
 *    kilobytes that the map must not be made to wait behind.
 * 3. When an account arrives, cloud snapshots take over as the source of truth.
 *
 * If step 2 or 3 never happens — offline, blocked storage, anonymous auth
 * switched off — everything keeps working against localStorage, which is where
 * it all was before any of this existed.
 */
import { mergeBest, planSync, type SyncPlan } from './library.ts';
import {
  deleteQuiz as removeLocal,
  loadBest,
  loadQuizzes,
  recordBest,
  saveQuiz as saveLocal,
  saveQuizzes as saveLocalAll,
} from './storage.ts';
import type { QuizSpec } from './types.ts';
import type { Account } from './cloud.ts';

type Cloud = typeof import('./cloud.ts');

/** Whether what you are looking at is only in this browser. */
export type Status = 'local' | 'syncing' | 'synced';

class Session {
  account = $state.raw<Account | null>(null);
  quizzes = $state.raw<QuizSpec[]>([]);
  best = $state.raw<Record<string, number>>({});
  status = $state<Status>('local');

  /**
   * Quizzes on this device that are not in the account.
   *
   * Only ever populated on the second-machine path — signing in to an account
   * that already existed. Everywhere else a quiz goes up automatically, because
   * it is the same person on the same browser and no boundary was crossed.
   *
   * They are *not* second-class: they show in the list, they persist, they
   * play. The only thing they are not is in the account, and the offer below is
   * how that changes. Declining hides the offer and keeps the quizzes, because
   * "don't put this in my account" and "throw this away" are different answers
   * and only one of them was asked.
   */
  localOnly = $state.raw<QuizSpec[]>([]);

  /** Whether to put the offer in front of them. Declining lowers it, not the quizzes. */
  offering = $state(false);

  /** What the offer is about. */
  get offered(): QuizSpec[] {
    return this.offering ? this.localOnly : [];
  }

  /** Set when the cloud refused us. The app carries on against localStorage. */
  error = $state<string | null>(null);

  /**
   * Set while signing in to an account that may already exist.
   *
   * `#attach` uploads whatever this browser has that the account has not, which
   * is right for every path except this one — here the account belongs to the
   * same person's *other* machine, and quietly moving this machine's quizzes
   * into it is exactly what the offer exists to avoid. The flag is set before
   * the popup opens, because the auth listener can fire before `upgrade()`
   * returns.
   */
  #switching = false;

  #cloud: Cloud | null = null;
  #stopAuth: (() => void) | null = null;
  #stopData: Array<() => void> = [];

  init(): void {
    this.quizzes = loadQuizzes();
    this.best = loadBest();

    void import('./cloud.ts')
      .then((cloud) => {
        this.#cloud = cloud;
        this.status = 'syncing';
        cloud.onWriteError((error) => {
          this.error = error.message;
        });
        this.#stopAuth = cloud.watchAccount((account) => this.#onAccount(account));
      })
      .catch(() => {
        // No cloud today. localStorage is doing the job.
      });
  }

  dispose(): void {
    this.#detach();
    this.#stopAuth?.();
    this.#stopAuth = null;
  }

  #detach(): void {
    for (const stop of this.#stopData.splice(0)) stop();
  }

  /**
   * Only re-attach when the *uid* changes.
   *
   * The auth listener fires on every id token change, which includes hourly
   * refreshes and the moment an anonymous account gains a Google provider.
   * Attaching again on each of those would stack a second set of snapshot
   * listeners on the same collections and never release the first — so the
   * account is always updated, and the data is only re-wired when it is
   * genuinely a different account's data.
   */
  #onAccount(account: Account | null): void {
    const changed = account?.uid !== this.account?.uid;
    this.account = account;
    if (!changed) return;

    this.#detach();
    if (!account || !this.#cloud) return;
    void this.#attach(this.#cloud, account.uid);
  }

  /**
   * Bring this browser and the account into agreement, then follow the account.
   *
   * The catching-up is done from an explicit read rather than from the first
   * snapshot. Hanging it off the listener made the upload depend on the
   * listener working, and a listener that fails produces no callback at all —
   * which looks exactly like an account that happens to be empty. One
   * mechanism for "what is there now", another for "tell me when it changes".
   */
  async #attach(cloud: Cloud, uid: string): Promise<void> {
    try {
      const theirs = await cloud.readAll(uid);

      const missing = this.quizzes.filter(
        (mine) => !theirs.quizzes.some((quiz) => quiz.id === mine.id),
      );
      if (this.#switching) {
        // An account that already existed. These wait to be asked about.
        this.#switching = false;
        this.localOnly = missing;
        this.offering = missing.length > 0;
      } else {
        // Same person, same browser, no boundary crossed — straight up.
        for (const mine of missing) cloud.putQuiz(uid, mine);
      }

      const merged = mergeBest(this.best, theirs.best);
      for (const [quizId, pct] of Object.entries(merged)) {
        if (theirs.best[quizId] === undefined || theirs.best[quizId] < pct) {
          cloud.putBest(uid, quizId, pct);
        }
      }
      this.best = merged;
      this.status = 'synced';
      this.error = null;
    } catch (error) {
      this.status = 'local';
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }

    const fail = (error: Error) => {
      this.status = 'local';
      this.error = error.message;
    };

    this.#stopData.push(
      cloud.watchQuizzes(
        uid,
        (quizzes) => {
          // An empty account is not a reason to forget what is in this browser:
          // the upload above may not have landed yet.
          if (quizzes.length === 0 && this.localOnly.length === 0) return;
          // Quizzes this device holds but the account does not are kept in the
          // list and on disk. Writing only the account's copy over the top
          // would delete the very quizzes we are still asking about.
          const byId = new Map(quizzes.map((quiz) => [quiz.id, quiz]));
          for (const quiz of this.localOnly) if (!byId.has(quiz.id)) byId.set(quiz.id, quiz);
          this.quizzes = [...byId.values()];
          saveLocalAll(this.quizzes);
        },
        fail,
      ),
    );

    this.#stopData.push(
      cloud.watchProgress(
        uid,
        (best) => {
          this.best = mergeBest(this.best, best);
        },
        fail,
      ),
    );
  }

  save(spec: QuizSpec): void {
    this.quizzes = saveLocal(spec);
    if (this.account && this.#cloud) this.#cloud.putQuiz(this.account.uid, spec);
  }

  remove(id: string): void {
    this.quizzes = removeLocal(id);
    if (this.account && this.#cloud) this.#cloud.dropQuiz(this.account.uid, id);
  }

  /** A merged import, or any bulk replacement of the list. */
  replace(quizzes: QuizSpec[]): void {
    saveLocalAll(quizzes);
    this.quizzes = quizzes;
    if (this.account && this.#cloud) {
      for (const spec of quizzes) this.#cloud.putQuiz(this.account.uid, spec);
    }
  }

  /** Records a round, if it beat what was already there. Never awaited. */
  recordScore(quizId: string, pct: number): void {
    const before = this.best[quizId];
    this.best = recordBest(this.best, quizId, pct);
    if (this.best[quizId] === before) return;
    if (this.account && this.#cloud) this.#cloud.putBest(this.account.uid, quizId, pct);
  }

  /**
   * Signing up.
   *
   * The anonymous account's contents are read **before** the attempt, because
   * on the second-machine path we end up signed in as a different uid and can
   * no longer see them — see `cloud.upgrade`.
   */
  async signIn(): Promise<SyncPlan | null> {
    if (!this.#cloud) return null;
    const cloud = this.#cloud;
    const mine = { quizzes: this.quizzes, best: this.best };

    this.#switching = true;
    let result;
    try {
      result = await cloud.upgrade();
    } catch (error) {
      this.#switching = false;
      throw error;
    }
    if (result.outcome === 'linked') {
      // Same uid, so the data never moved and there is nothing to ask about.
      this.#switching = false;
      return null;
    }

    // A different account, already populated. Scores merge on their own; the
    // quizzes wait to be asked about.
    const theirs = await cloud.readAll(result.account.uid);
    const plan = planSync(mine, theirs);
    for (const [quizId, pct] of Object.entries(plan.bestToPush)) {
      cloud.putBest(result.account.uid, quizId, pct);
    }
    this.localOnly = plan.upload;
    this.offering = plan.upload.length > 0;
    return plan;
  }

  /** Yes: put this device's quizzes into the account as well. */
  acceptOffered(): void {
    if (!this.account || !this.#cloud) return;
    for (const spec of this.localOnly) this.#cloud.putQuiz(this.account.uid, spec);
    this.localOnly = [];
    this.offering = false;
  }

  /**
   * Not now.
   *
   * Lowers the offer and keeps the quizzes exactly where they are — on this
   * device, in the list, playable. They were never asked to be thrown away.
   */
  declineOffered(): void {
    this.offering = false;
  }

  async signOut(): Promise<void> {
    if (!this.#cloud) return;
    this.#detach();
    await this.#cloud.leave();
  }
}

export const session = new Session();

/*
 * A handle on the session in development only.
 *
 * The sync path has almost no visible surface — a quiz reaching the account
 * looks exactly like a quiz that was already there — so the headless tests
 * assert on this rather than on the DOM. Stripped from production builds by
 * the `import.meta.env.DEV` guard, which Vite resolves at build time.
 */
if (import.meta.env?.DEV) {
  (globalThis as Record<string, unknown>).__session = session;
}
