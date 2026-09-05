/**
 * The Firebase project, and the one place its configuration is written down.
 *
 * None of this is a secret. A Firebase web config ships inside every client
 * bundle by design — it identifies the project, it does not authorise anything.
 * What stands between a stranger and the data is `firestore.rules`, which is
 * why that file is where the care went. So this is a plain committed module
 * rather than an environment variable: the values are identical in development
 * and production, and hiding them would only imply a secrecy that does not
 * exist.
 *
 * `VITE_FIREBASE_EMULATOR` is the exception worth having, because that genuinely
 * does differ per machine.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyCmrOB5eBtKo9nUlhPU1XB50RERcK0uxr4',
  authDomain: 'terrain-nerd.firebaseapp.com',
  projectId: 'terrain-nerd',
  storageBucket: 'terrain-nerd.firebasestorage.app',
  messagingSenderId: '759606882230',
  appId: '1:759606882230:web:e4926b1cd02c36d7d31b17',
};

/** Set in `.env.development.local` to point a dev server at the emulator suite. */
export const useEmulator = import.meta.env?.VITE_FIREBASE_EMULATOR === '1';
