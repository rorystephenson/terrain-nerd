/**
 * Where the quizzes and the scores come from, whoever you are.
 *
 * One object, so that the question "whose copy is authoritative?" is answered
 * in exactly one file and never inside a component. `App.svelte` reads
 * `session.quizzes` and `session.best` and calls `session.save()`; it does not
 * know how any of that is stored, and it should not have to.
 *
 * **Firestore is the only store.** There used to be a localStorage mirror
 * alongside it, written through on every save and read synchronously at start-up
 * so the list painted on the first frame. It is gone, and the reasons it went
 * are worth writing down because they are not the reasons it was kept:
 *
 * - It was never a second source of truth. Every snapshot overwrote it, so it
 *   only ever answered with what the account had already said.
 * - The docstrings justified it by offline resilience, which it did not provide.
 *   There is no service worker, so the app cannot cold-start offline at all;
 *   and *mid-session* offline is `persistentLocalCache`'s job, which queues
 *   writes and replays them. Two caches for one job, and `cloud.ts` already
 *   argued that two caches that disagree is worse than none.
 * - It leaked. Catching up the mirror to the account meant uploading anything
 *   the account lacked, so deleting a quiz server-side brought it straight back
 *   on the next load.
 *
 * What it genuinely bought was a synchronous first paint. That is now a
 * spinner: `status` is `'loading'` until the first snapshot lands, and `ready`
 * is how anything that needs the quizzes before it can decide what to show —
 * `goTo` in `App.svelte` — waits for them.
 *
 * The cost of the trade is honest and worth knowing: with no uid there is
 * nowhere to save, so a failed anonymous sign-in is now an error rather than a
 * degraded mode. `#fail` is where that lands.
 */
import { CELL_ZOOM } from './codec.ts';
import { cellsCovering } from './grid.ts';
import { planSync, recordBest, type SyncPlan } from './library.ts';
import type { QuizSpec } from './types.ts';
import type { Account } from './cloud.ts';

type Cloud = typeof import('./cloud.ts');

/**
 * Whether there is anything to look at yet.
 *
 * `'loading'` is the honest state before the first snapshot: the list is not
 * empty, it is unknown, and those must not look the same. `'error'` is the end
 * of the road — no uid, or the account cannot be read — which is a real
 * possibility now that nothing is kept locally.
 */
export type Status = 'loading' | 'ready' | 'error';

class Session {
  account = $state.raw<Account | null>(null);
  quizzes = $state.raw<QuizSpec[]>([]);
  best = $state.raw<Record<string, number>>({});
  status = $state<Status>('loading');

  /** Set when a write was refused, or the account could not be read. */
  error = $state<string | null>(null);

  #cloud: Cloud | null = null;
  /** Resolves once the SDK has loaded, or to null if it never will. */
  #cloudReady: Promise<Cloud | null> = Promise.resolve(null);
  #stopAuth: (() => void) | null = null;
  #stopData: Array<() => void> = [];

  /**
   * Resolves when the quizzes have arrived, or when it is settled that they
   * never will.
   *
   * This is what replaces the synchronous read at start-up. Anything that has
   * to know whether a quiz id belongs to *you* before it can decide what to
   * show — opening `/q/{id}` or `/build/{id}` cold — has to wait for it, or it
   * will read an empty list and conclude the quiz is a stranger's, or gone.
   *
   * It resolves rather than rejects on failure, because every caller wants the
   * same thing from it: permission to stop waiting. `status` says how it went.
   */
  ready: Promise<void> = Promise.resolve();
  #settle: () => void = () => {};

  init(): void {
    this.ready = new Promise((resolve) => {
      this.#settle = resolve;
    });

    this.#cloudReady = import('./cloud.ts')
      .then((cloud) => {
        this.#cloud = cloud;
        cloud.onWriteError((error) => {
          this.error = error.message;
        });
        this.#stopAuth = cloud.watchAccount(
          (account) => this.#onAccount(account),
          (error) => this.#fail(error),
        );
        return cloud;
      })
      .catch(() => {
        this.#fail(new Error('Could not load the quiz store.'));
        return null;
      });
  }

  /**
   * The end of the road, and the honest end of it.
   *
   * There is no local fallback to drop back to any more, so this is not a
   * degraded mode that quietly keeps working — it is a state in which nothing
   * can be saved. It still settles `ready`: a caller waiting to find out
   * whether a quiz is yours is owed an answer even when the answer is "we
   * cannot tell".
   */
  #fail(error: Error): void {
    this.status = 'error';
    this.error = error.message;
    this.#settle();
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
    if (!account || !this.#cloud) {
      // Signed out, with nothing kept locally to fall back to. Showing the
      // previous account's quizzes until the anonymous sign-in lands would be
      // showing somebody else's, so the list empties and `status` says why.
      this.quizzes = [];
      this.best = {};
      this.status = 'loading';
      return;
    }
    this.#attach(this.#cloud, account.uid);
  }

  /**
   * Follow the account.
   *
   * There is nothing to reconcile here any more. The snapshots *are* the state,
   * so this is a subscription and not a merge — the catching-up that used to
   * happen first was localStorage's, and it went with it. Nothing is layered on
   * top either: every quiz the app knows about is in the account by the time it
   * is shown, which is what makes a snapshot the whole truth.
   */
  #attach(cloud: Cloud, uid: string): void {
    const fail = (error: Error) => this.#fail(error);

    this.#stopData.push(
      cloud.watchQuizzes(
        uid,
        (quizzes) => {
          this.quizzes = [...quizzes];
          this.status = 'ready';
          this.error = null;
          this.#settle();
        },
        fail,
      ),
    );

    this.#stopData.push(
      cloud.watchProgress(
        uid,
        (best) => {
          this.best = best;
        },
        fail,
      ),
    );
  }

  /**
   * Saves a quiz, or says why it could not be.
   *
   * The list is not updated here. Firestore's own cache applies a write before
   * it leaves the machine and fires the snapshot listener with it included, so
   * `watchQuizzes` has the quiz in hand by the time the next frame paints —
   * updating `this.quizzes` as well would be a second copy of the same
   * bookkeeping, which is the habit this whole change is getting rid of.
   *
   * With no account there is nowhere for it to go, and that has to be said. It
   * used to be the case that this still worked, quietly, against localStorage.
   */
  save(spec: QuizSpec): void {
    if (!this.account || !this.#cloud) {
      this.error = 'Not signed in, so this quiz could not be saved.';
      return;
    }
    this.#cloud.putQuiz(this.account.uid, spec);
  }

  remove(id: string): void {
    this.quizzes = this.quizzes.filter((quiz) => quiz.id !== id);
    if (this.account && this.#cloud) this.#cloud.dropQuiz(this.account.uid, id);
  }

  /**
   * Records a round, if it beat what was already there. Never awaited.
   *
   * Applied here as well as written, unlike `save`: the results screen reads
   * the best score in the same tick it is set, and `recordBest` returning the
   * same object when nothing improved is what keeps a good-but-not-best round
   * from touching the network at all.
   */
  recordScore(quizId: string, pct: number): void {
    const next = recordBest(this.best, quizId, pct);
    if (next === this.best) return;
    this.best = next;
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

    const result = await cloud.upgrade();
    if (result.outcome === 'linked') {
      // Same uid, so the data never moved and there is nothing to ask about.
      return null;
    }

    // A different account, already populated. Both sides merge, and neither
    // asks: there used to be a panel here offering to keep this device's
    // quizzes, and it stopped being a fair question when localStorage went.
    // "Not now" had meant "they stay on this device" — with nowhere local to
    // stay, it would have meant "lose them on the next reload", which is not
    // an option worth putting in front of anybody. So they go up, and the
    // orphaned anonymous account is left behind as it always was.
    const theirs = await cloud.readAll(result.account.uid);
    const plan = planSync(mine, theirs);
    for (const spec of plan.upload) cloud.putQuiz(result.account.uid, spec);
    for (const [quizId, pct] of Object.entries(plan.bestToPush)) {
      cloud.putBest(result.account.uid, quizId, pct);
    }
    return plan;
  }

  /** Freezes a quiz into its public form. Returns the version it became. */
  async publish(spec: QuizSpec): Promise<number> {
    if (!this.#cloud) throw new Error('Not connected.');
    return this.#cloud.publish(spec);
  }

  async unpublish(quizId: string): Promise<void> {
    await this.#cloud?.unpublish(quizId);
  }

  /** What a quiz's public face looks like right now, or nothing if it has none. */
  async published(quizId: string) {
    return (await this.#cloud?.publishedState(quizId)) ?? null;
  }

  /**
   * Counts a finished round of a published quiz towards its popularity.
   *
   * Deliberately keyed on the quiz rather than the round: this can be called
   * after every replay and will only ever count once.
   */
  countPlay(quizId: string): void {
    void this.#cloud?.recordPlay(quizId).catch(() => {});
  }

  /**
   * Keeps someone else's quiz among your own.
   *
   * The id is deliberately unchanged, so your best score on it stays the score
   * on *that* quiz and remains comparable with everyone else's. It is marked
   * `shared` because it is not yours to publish — and the rules would refuse
   * that anyway, since the published copy already names an owner.
   */
  keep(shared: QuizSpec): void {
    this.save({ ...shared, source: 'shared' });
  }

  /**
   * The ground this person already cares about, as discovery cells.
   *
   * Taken from their own quizzes rather than from the browser's location. It is
   * a better answer and it asks for no permission: someone with two quizzes in
   * the Brenta has said plainly which mountains they are interested in, where a
   * location prompt is both intrusive and wrong for anyone planning a trip
   * somewhere they are not currently standing.
   */
  get myCells(): string[] {
    const cells = new Set<string>();
    for (const quiz of this.quizzes) {
      for (const cell of cellsCovering(quiz.bbox, CELL_ZOOM)) cells.add(cell);
    }
    return [...cells];
  }

  /**
   * Waits for the SDK rather than reporting an empty catalogue without it.
   *
   * Discovery is the one thing that runs on mount, and the SDK is fetched by
   * dynamic import so the map does not wait behind it — so on a cold load of
   * `/browse`, which is exactly how somebody arrives at this screen, the query
   * was being asked before there was anything to ask. It answered "nothing
   * published", which is indistinguishable from the truth and never retried.
   */
  async discover(what: 'popular' | 'new' | 'near') {
    const cloud = this.#cloud ?? (await this.#cloudReady);
    if (!cloud) return [];
    if (what === 'popular') return cloud.listPopular();
    if (what === 'new') return cloud.listNewest();
    return cloud.listNear(this.myCells);
  }

  /**
   * Quizzes over a particular piece of ground, for the browse map.
   *
   * `null` cells mean the view is too wide to ask by ground — see `queryCells`
   * — so the answer becomes "the most played anywhere", which is the honest one
   * at a view that covers half a country. Asking for a sliced cell list instead
   * would leave whole regions blank with nothing to say they had been dropped.
   */
  async discoverIn(cells: readonly string[] | null) {
    const cloud = this.#cloud ?? (await this.#cloudReady);
    if (!cloud) return [];
    return cells === null ? cloud.listPopular() : cloud.listNear(cells);
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
