/**
 * Signing in, across two machines, against the emulator suite.
 *
 * This is the path with the least visible surface and the most to lose: a quiz
 * reaching an account looks exactly like a quiz that was already there, and
 * getting it wrong means someone's work quietly moves somewhere they did not
 * ask it to go — or quietly does not.
 *
 * It has already caught three things that every unit test passed through:
 *   - `onAuthStateChanged` does not fire when an anonymous account is linked,
 *     so the app went on calling a signed-up person anonymous;
 *   - the auth listener firing on token refresh stacked a fresh set of snapshot
 *     listeners each time;
 *   - the second-machine offer was theatre, because the quizzes had already
 *     been uploaded by the time it was shown.
 *
 * Needs the emulator suite and a dev server pointed at it, in two terminals:
 *
 *   firebase emulators:start --only auth,firestore
 *   echo 'VITE_FIREBASE_EMULATOR=1' > web/.env.development.local && npm run dev
 *
 * The emulator must run under the project id in `web/src/lib/firebase.ts`,
 * because it partitions data by project id and will silently serve an empty
 * database for any other one. `.firebaserc` makes that the default.
 */
import { chromium } from 'playwright';

const APP = 'http://localhost:5173/';
const FS = 'http://127.0.0.1:8080/v1/projects/terrain-nerd/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099';
const ADMIN = { headers: { Authorization: 'Bearer owner' } };

const reset = async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/terrain-nerd/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH}/emulator/v1/projects/terrain-nerd/accounts`, { method: 'DELETE' });
};
const cloud = async (uid, sub) => {
  const j = await (await fetch(`${FS}/users/${uid}/${sub}`, ADMIN)).json();
  return Object.fromEntries((j.documents ?? []).map((d) => [d.name.split('/').pop(), d.fields]));
};
const bests = async (uid) =>
  Object.fromEntries(Object.entries(await cloud(uid, 'progress')).map(([k, v]) => [k, Number(v.best.integerValue)]));
const emailOf = async (uid) => {
  const j = await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/terrain-nerd/accounts:query`,
    { method: 'POST', headers: { ...ADMIN.headers, 'Content-Type': 'application/json' }, body: '{}' })).json();
  return (j.userInfo ?? []).find((u) => u.localId === uid)?.email;
};

const seed = (label) => ([{
  id: 'q-' + label, name: 'From ' + label, source: 'built', createdAt: '2026-01-01T00:00:00.000Z',
  features: [{ id: 'peak/n26862712', kind: 'peak', name: 'Cima Tosa', at: [10.87113, 46.15652] }],
  bbox: [10.70, 46.05, 10.95, 46.30],
}]);

/**
 * Signs in through the Auth emulator's popup.
 *
 * `reuseEmail` is what makes the second-machine case reachable: without it the
 * emulator mints a fresh Google account every time, which links cleanly and
 * never exercises the path that matters.
 */
async function signInViaPopup(page, reuseEmail) {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('button:has-text("Sign in")').first().click(),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  if (reuseEmail) {
    await popup.locator(`.js-reuse-account:has-text("${reuseEmail}")`).click();
  } else {
    await popup.locator('.js-new-account').first().click();
    await popup.locator('button:has-text("Auto-generate user information")').click();
    await popup.locator('button:has-text("Sign in with Google.com")').click();
  }
  await popup.waitForEvent('close', { timeout: 20000 }).catch(() => {});
}

const openApp = async (browser, quizzes) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([q]) => localStorage.setItem('terrain-nerd:quizzes', JSON.stringify(q)), [quizzes]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__session?.status === 'synced', { timeout: 25000 });
  return page;
};
const state = (page) => page.evaluate(() => ({
  uid: globalThis.__session.account.uid,
  anon: globalThis.__session.account.anonymous,
  offered: globalThis.__session.offered.map((q) => q.name),
  quizzes: globalThis.__session.quizzes.map((q) => q.id),
  best: globalThis.__session.best,
}));

await reset();
const browser = await chromium.launch();

// ---- A: anonymous, one quiz, one score, then signs up -----------------------
const A = await openApp(browser, seed('A'));
const anonA = (await state(A)).uid;
await A.evaluate(() => globalThis.__session.recordScore('q-A', 80));
await A.waitForTimeout(1200);
console.log('A anonymous  :', anonA);
console.log('  cloud quizzes :', Object.keys(await cloud(anonA, 'quizzes')));
console.log('  cloud scores  :', JSON.stringify(await bests(anonA)));

await signInViaPopup(A, null);
await A.waitForTimeout(2500);
const a2 = await state(A);
const email = await emailOf(a2.uid);
console.log('A signed up  :', a2.uid, '| anonymous:', a2.anon, '| uid kept:', a2.uid === anonA);
console.log('  account     :', email);

// ---- B: a different machine, its own quiz and scores, same Google account ---
const B = await openApp(browser, seed('B'));
const anonB = (await state(B)).uid;
await B.evaluate(() => {
  globalThis.__session.recordScore('q-A', 55); // worse than A's 80
  globalThis.__session.recordScore('q-B', 95); // the account has never seen this
});
await B.waitForTimeout(1200);
console.log('\nB anonymous  :', anonB, '| different account:', anonB !== a2.uid);

await signInViaPopup(B, email);
await B.waitForTimeout(3500);
const b2 = await state(B);
console.log('B signed in  :', b2.uid, '| anonymous:', b2.anon);
console.log('  landed on A\'s account :', b2.uid === a2.uid);
console.log('  offered to keep       :', JSON.stringify(b2.offered));
console.log('  scores now on account :', JSON.stringify(await bests(a2.uid)), '<- 80 kept, 95 gained');
console.log('  quizzes before accept :', Object.keys(await cloud(a2.uid, 'quizzes')));

// Declining must not destroy the quiz: it is still on this device, in the list.
await B.evaluate(() => globalThis.__session.declineOffered());
await B.waitForTimeout(1200);
const declined = await state(B);
console.log('  after DECLINING       : account has', Object.keys(await cloud(a2.uid, 'quizzes')),
            '| list still shows', declined.quizzes);

await B.evaluate(() => { globalThis.__session.offering = true; globalThis.__session.acceptOffered(); });
await B.waitForTimeout(2000);
console.log('  after ACCEPTING       : account has', Object.keys(await cloud(a2.uid, 'quizzes')));

await browser.close();
