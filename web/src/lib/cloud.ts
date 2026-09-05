/**
 * The only module that knows Firebase exists.
 *
 * Everything above this is plumbing-free: `session.svelte.ts` holds the state,
 * `library.ts` decides what a sign-in should do, `codec.ts` decides what a
 * document means. This file just moves bytes, which is why there is almost
 * nothing here worth a unit test — and that is the point of the arrangement.
 * Logic that matters lives where `node --test` can reach it.
 *
 * Loaded by dynamic import so the SDK never enters the initial bundle. Signed
 * out or signed in, the map paints before any of this is fetched.
 */
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  linkWithPopup,
  onIdTokenChanged,
  signInAnonymously,
  signInWithCredential,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

import { docToPublished, docToSpec, specToDoc, specToPublished, type Published } from './codec.ts';
import { firebaseConfig, useEmulator } from './firebase.ts';
import type { QuizSpec } from './types.ts';

const app = initializeApp(firebaseConfig);

/**
 * Persistent cache from the very first initialisation, deliberately.
 *
 * It is what makes an offline write queue and replay on its own, so nothing
 * above needs to hand-roll one — and two caches that disagree is a worse
 * problem than no cache at all. Changing the mode later would mean reasoning
 * about what is already sitting in people's browsers, so it is settled now.
 *
 * It throws where IndexedDB is blocked — private windows, browsers set to
 * refuse site data — and the app has always held that blocked storage degrades
 * to "it just doesn't persist" rather than to an error in front of someone
 * mid-game. So: memory cache, and carry on.
 */
function openFirestore(): Firestore {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    return initializeFirestore(app, { localCache: memoryLocalCache() });
  }
}

let db: Firestore | null = null;
let auth: Auth | null = null;

function connect(): { db: Firestore; auth: Auth } {
  if (!db || !auth) {
    db = openFirestore();
    auth = getAuth(app);
    if (useEmulator) {
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }
  }
  return { db, auth };
}

export type Account = { uid: string; name: string | null; anonymous: boolean };

const accountOf = (user: User): Account => ({
  uid: user.uid,
  name: user.displayName,
  anonymous: user.isAnonymous,
});

/**
 * Watches who is signed in, signing in anonymously when nobody is.
 *
 * Everyone gets a uid on first load, which is what lets progress reach the
 * cloud before anyone has decided whether they want an account. The prompt to
 * make one is then genuinely an offer rather than the price of not losing your
 * scores.
 *
 * `onIdTokenChanged`, not `onAuthStateChanged`. Linking a Google account to an
 * anonymous one does not change *who* is signed in — same user, same uid — so
 * `onAuthStateChanged` never fires for it, and the app went on describing
 * somebody who had just signed up as anonymous, still offering them the button
 * they had already pressed. The id token does change, because the provider list
 * is part of it.
 *
 * The cost is that this also fires on hourly token refreshes, so the caller
 * must not treat every call as a new account — see `#onAccount`.
 */
export function watchAccount(onChange: (account: Account | null) => void): () => void {
  const { auth } = connect();
  return onIdTokenChanged(auth, (user) => {
    if (user) {
      onChange(accountOf(user));
      return;
    }
    onChange(null);
    signInAnonymously(auth).catch(() => {
      // Offline, or anonymous auth switched off. Everything falls back to
      // localStorage, which is exactly where it was before any of this.
    });
  });
}

const quizzesOf = (uid: string) => collection(connect().db, 'users', uid, 'quizzes');
const progressOf = (uid: string) => collection(connect().db, 'users', uid, 'progress');

/**
 * Every listener takes an error callback, and none of them are optional.
 *
 * `onSnapshot` without one swallows a failed listen entirely — the stream just
 * never produces anything, which is indistinguishable from an account that
 * happens to be empty. That cost an hour once: the rules were denying the
 * listen, the console was clean, and the app looked like it was working.
 */
export function watchQuizzes(
  uid: string,
  onChange: (quizzes: QuizSpec[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    quizzesOf(uid),
    (snap) => {
      const quizzes: QuizSpec[] = [];
      for (const d of snap.docs) {
        const spec = docToSpec(d.id, d.data());
        if (spec) quizzes.push(spec);
      }
      quizzes.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      onChange(quizzes);
    },
    onError,
  );
}

export function watchProgress(
  uid: string,
  onChange: (best: Record<string, number>) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    progressOf(uid),
    (snap) => {
      const best: Record<string, number> = {};
      for (const d of snap.docs) {
        const pct = d.data().best;
        if (typeof pct === 'number' && Number.isFinite(pct)) best[d.id] = pct;
      }
      onChange(best);
    },
    onError,
  );
}

/**
 * Where a failed write goes.
 *
 * Writes are fire-and-forget (see below), so a rejected promise has nowhere to
 * be returned to. Dropping it on the floor was worse than useless: a quiz that
 * silently never left the browser looks exactly like one that did.
 */
let reportError: (error: Error) => void = () => {};

export function onWriteError(report: (error: Error) => void): void {
  reportError = report;
}

const failed = (error: unknown) => {
  reportError(error instanceof Error ? error : new Error(String(error)));
};

/**
 * Writes are never awaited by callers.
 *
 * A Firestore write resolves when the *server* acknowledges it, so offline it
 * simply never resolves — the local cache has already applied it and the queue
 * will replay it, but the promise stays pending for as long as the aeroplane is
 * in the air. Awaiting one in a save handler would hang the button.
 */
export function putQuiz(uid: string, spec: QuizSpec): void {
  const now = new Date().toISOString();
  void setDoc(doc(quizzesOf(uid), spec.id), specToDoc(spec, uid, now)).catch(failed);
}

export function dropQuiz(uid: string, quizId: string): void {
  void deleteDoc(doc(quizzesOf(uid), quizId)).catch(failed);
}

export function putBest(uid: string, quizId: string, best: number): void {
  void setDoc(
    doc(progressOf(uid), quizId),
    { best, lastPlayedAt: new Date().toISOString() },
    { merge: true },
  ).catch(failed);
}

/** One read of everything in the account, for the sign-in reconciliation. */
export async function readAll(uid: string): Promise<{
  quizzes: QuizSpec[];
  best: Record<string, number>;
}> {
  const [q, p] = await Promise.all([getDocs(quizzesOf(uid)), getDocs(progressOf(uid))]);
  const quizzes: QuizSpec[] = [];
  for (const d of q.docs) {
    const spec = docToSpec(d.id, d.data());
    if (spec) quizzes.push(spec);
  }
  const best: Record<string, number> = {};
  for (const d of p.docs) {
    const pct = d.data().best;
    if (typeof pct === 'number' && Number.isFinite(pct)) best[d.id] = pct;
  }
  return { quizzes, best };
}

export type Upgrade =
  /** The anonymous uid was kept. Nothing to reconcile: it was already theirs. */
  | { outcome: 'linked'; account: Account }
  /**
   * That account already existed, so we are now signed in as it — a different
   * uid, and whatever was under the anonymous one has to be carried across by
   * the caller. This is the second-machine case.
   */
  | { outcome: 'switched'; account: Account };

/**
 * Turns an anonymous visitor into a signed-up one.
 *
 * The happy path keeps the uid, so the data was never anywhere else and there
 * is nothing to merge. The exception is `credential-already-in-use`: the person
 * has signed in on another machine already, and linking would fuse two
 * accounts, which Firebase will not do.
 *
 * **The caller must have read the anonymous account's data before calling
 * this.** Once we sign in as the other account those documents are no longer
 * readable — the rules key them by uid, and the uid has changed.
 *
 * The orphaned anonymous account is deliberately left behind rather than
 * deleted. Deleting it would have to happen *before* signing in as the other
 * account, since only the current user can be deleted, and a failure at that
 * point would have thrown away the only copy. A little litter in the account
 * list beats a chance of losing someone's quizzes.
 */
export async function upgrade(): Promise<Upgrade> {
  const { auth } = connect();
  const user = auth.currentUser;
  const provider = new GoogleAuthProvider();

  if (!user) {
    const cred = await signInWithPopup(auth, provider);
    return { outcome: 'switched', account: accountOf(cred.user) };
  }

  try {
    const cred = await linkWithPopup(user, provider);
    return { outcome: 'linked', account: accountOf(cred.user) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'auth/credential-already-in-use' && code !== 'auth/email-already-in-use') throw error;

    const credential = GoogleAuthProvider.credentialFromError(error as never);
    if (!credential) throw error;
    const signedIn = await signInWithCredential(auth, credential);
    return { outcome: 'switched', account: accountOf(signedIn.user) };
  }
}

/** Signs out and straight back in anonymously, so play and progress keep working. */
export async function leave(): Promise<void> {
  const { auth } = connect();
  await signOut(auth);
  await signInAnonymously(auth).catch(() => {});
}


/**
 * The display name a published quiz is signed with.
 *
 * Taken from the provider rather than from a profile document, so publishing
 * needs no extra read and a quiz stays readable even if the author's profile
 * is later removed. The profile is written too, because a name that only
 * exists inside published copies cannot be corrected later.
 */
function nameOf(user: User): string {
  return (user.displayName ?? user.email?.split('@')[0] ?? 'Anonymous').slice(0, 40);
}

export function saveProfile(): void {
  const { auth, db } = connect();
  const user = auth.currentUser;
  if (!user || user.isAnonymous) return;
  void setDoc(
    doc(db, 'users', user.uid),
    { displayName: nameOf(user), updatedAt: new Date().toISOString() },
    { merge: true },
  ).catch(failed);
}

/**
 * Freezes a draft into its public form, and returns the version it became.
 *
 * A transaction, because the version number is derived from what is already
 * published and two devices publishing at once must not both decide they are
 * version 3. The snapshot under `versions/` is written in the same commit — it
 * is what makes a `?v=` link mean exactly what was shared, even after the
 * author has moved on.
 *
 * `players` and `hidden` are carried across rather than reset, both because the
 * rules require it and because a republish should not wipe the record of who
 * has played. Republishing is an edit to a quiz, not a new quiz.
 */
export async function publish(spec: QuizSpec): Promise<number> {
  const { auth, db } = connect();
  const user = auth.currentUser;
  if (!user || user.isAnonymous) throw new Error('Publishing needs an account.');

  const owner = { id: user.uid, name: nameOf(user) };
  const ref = doc(db, 'published', spec.id);

  const version = await runTransaction(db, async (tx) => {
    const current = await tx.get(ref);
    const previous = current.exists() ? current.data() : null;
    const next = previous ? Number(previous.version ?? 0) + 1 : 1;

    const body = specToPublished(spec, owner, next, new Date().toISOString());
    tx.set(ref, previous ? { ...body, players: previous.players, hidden: previous.hidden } : body);
    tx.set(doc(db, 'published', spec.id, 'versions', String(next)), body);
    return next;
  });

  saveProfile();
  return version;
}

/** Takes a quiz out of circulation. Existing links stop resolving; drafts are untouched. */
export async function unpublish(quizId: string): Promise<void> {
  const { db } = connect();
  await deleteDoc(doc(db, 'published', quizId));
}

/** A published quiz by id, or an exact frozen version of it. */
export async function getPublished(quizId: string, version?: number): Promise<Published | null> {
  const { db } = connect();
  const ref =
    version === undefined
      ? doc(db, 'published', quizId)
      : doc(db, 'published', quizId, 'versions', String(version));
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const published = docToPublished(quizId, snap.data());
  return published?.spec.features.length ? published : null;
}

/** What the author needs to know about their own quiz's public face. */
export async function publishedState(quizId: string): Promise<Published | null> {
  return getPublished(quizId);
}

/**
 * Counts this player, once, for as long as the quiz exists.
 *
 * The marker and the increment go up in one commit because that is the only
 * shape the rules will accept: `players` may move by one, and only alongside
 * the creation of a document this uid can create once and can never delete. So
 * the number is distinct people who finished a round, not rounds — replaying
 * a quiz all afternoon moves it not at all.
 *
 * Checked first rather than attempted and caught, because a second attempt is
 * the ordinary case — most rounds are replays — and a denied write is not
 * something to report to somebody who has just finished a quiz.
 */
export async function recordPlay(quizId: string): Promise<void> {
  const { auth, db } = connect();
  const user = auth.currentUser;
  if (!user) return;

  const marker = doc(db, 'published', quizId, 'players', user.uid);
  const already = await getDoc(marker).catch(() => null);
  if (!already || already.exists()) return;

  const batch = writeBatch(db);
  batch.set(marker, { at: serverTimestamp() });
  batch.update(doc(db, 'published', quizId), { players: increment(1) });
  await batch.commit().catch(() => {
    // A race with another tab, or the quiz was unpublished mid-round. The
    // counter is only ever an approximation of counting the markers, so
    // losing one is not worth telling anybody about.
  });
}
