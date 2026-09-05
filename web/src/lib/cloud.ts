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
  getDocs,
  initializeFirestore,
  memoryLocalCache,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

import { docToSpec, specToDoc } from './codec.ts';
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
