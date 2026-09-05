/**
 * Publishing a quiz and opening it from a link, against the emulator suite.
 *
 * The share path has a failure mode that looks like success: a link that
 * resolves to a quiz with no features in it plays as a very short round rather
 * than as an error. So this checks what actually came back, not just that a
 * screen appeared.
 *
 * Needs the emulator suite and a dev server pointed at it — see `flow.mjs`.
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

const quiz = [{
  id: 'brenta1', name: 'The Brenta', source: 'built', createdAt: '2026-01-01T00:00:00.000Z',
  features: [
    { id: 'peak/n26862712', kind: 'peak', name: 'Cima Tosa', at: [10.87113, 46.15652] },
    { id: 'peak/n26862689', kind: 'peak', name: 'Cima Brenta', at: [10.89991, 46.17946] },
    { id: 'peak/n206124143', kind: 'peak', name: 'Doss del Sabion', at: [10.80658, 46.16749] },
  ],
  bbox: [10.70, 46.05, 10.95, 46.30],
}];

async function signUp(page) {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('button:has-text("Sign in")').first().click(),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  await popup.locator('.js-new-account').first().click();
  await popup.locator('button:has-text("Auto-generate user information")').click();
  await popup.locator('button:has-text("Sign in with Google.com")').click();
  await popup.waitForEvent('close', { timeout: 20000 }).catch(() => {});
}

const open = async (browser, url, seed) => {
  const ctx = await browser.newContext();
  if (seed) await ctx.addInitScript(([q]) => localStorage.setItem('terrain-nerd:quizzes', JSON.stringify(q)), [seed]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__session?.status === 'synced', { timeout: 25000 });
  return page;
};

await reset();
const browser = await chromium.launch();

// ---- The author publishes ---------------------------------------------------
const author = await open(browser, APP, quiz);
await signUp(author);
await author.waitForTimeout(2500);

await author.locator('button[aria-label="Share The Brenta"]').click();
await author.locator('button:has-text("Publish and get a link")').click();
await author.waitForSelector('input[readonly]', { timeout: 20000 });
const link = await author.locator('input[readonly]').inputValue();
console.log('link          :', link);
console.log('panel says    :', (await author.locator('.sheet .muted').first().innerText()).replace(/\n/g, ' '));

const pub = await (await fetch(`${FS}/published/brenta1`, ADMIN)).json();
console.log('published doc : version', pub.fields.version.integerValue,
            '| questions', pub.fields.counts.mapValue.fields.questions.integerValue,
            '| players', pub.fields.players.integerValue,
            '| cells', pub.fields.cells.arrayValue.values.map((v) => v.stringValue).join(','));
const v1 = await (await fetch(`${FS}/published/brenta1/versions/1`, ADMIN)).json();
console.log('frozen v1     :', v1.fields ? 'stored' : 'MISSING');

// ---- A stranger opens the link ---------------------------------------------
// A fresh context: different anonymous uid, nothing in localStorage.
const visitor = await open(browser, link);
await visitor.waitForTimeout(2500);
const seen = await visitor.evaluate(() => ({
  url: location.pathname,
  text: document.body.innerText.split('\n').filter(Boolean).slice(0, 2),
  quizzes: globalThis.__session.quizzes.map((q) => q.id),
  anon: globalThis.__session.account.anonymous,
}));
console.log('\nvisitor url   :', seen.url, '| anonymous:', seen.anon);
console.log('visitor sees  :', seen.text.join(' | '));
console.log('in their list :', seen.quizzes, '(empty: looking is not keeping)');

// The round is built from the published features, not from an empty list.
const asked = await visitor.evaluate(() => globalThis.__session ? document.body.innerText.match(/1 \/ (\d+)/)?.[1] : null);
console.log('questions     :', asked, '(3 features, 3 distinct names)');

// ---- Counting, keeping, and the back button --------------------------------
await visitor.evaluate(() => globalThis.__session.countPlay('brenta1'));
await visitor.waitForTimeout(1500);
const after = await (await fetch(`${FS}/published/brenta1`, ADMIN)).json();
console.log('players now   :', after.fields.players.integerValue);
await visitor.evaluate(() => globalThis.__session.countPlay('brenta1'));
await visitor.waitForTimeout(1500);
const again = await (await fetch(`${FS}/published/brenta1`, ADMIN)).json();
console.log('after replay  :', again.fields.players.integerValue, '(people, not rounds)');

// Keeping it is a deliberate act, and only then is it theirs.
await visitor.evaluate((spec) => globalThis.__session.keep(spec), quiz[0]);
await visitor.waitForTimeout(1500);
const kept = await visitor.evaluate(() => globalThis.__session.quizzes.map((q) => `${q.id}:${q.source}`));
console.log('after keeping :', kept);

// ---- Republishing --------------------------------------------------------
// The rules require the version to step and the counter to be carried across
// untouched; the client has to actually do that or the write is refused.
await author.evaluate(() => {
  const s = globalThis.__session;
  const q = s.quizzes.find((x) => x.id === 'brenta1');
  s.save({ ...q, name: 'The Brenta (revised)', features: q.features.slice(0, 2) });
});
await author.waitForTimeout(1200);
await author.locator('button:has-text("Publish the changes")').click();
await author.waitForTimeout(2500);
const v2 = await (await fetch(`${FS}/published/brenta1`, ADMIN)).json();
console.log('\nrepublished   : version', v2.fields.version.integerValue,
            '| questions', v2.fields.counts.mapValue.fields.questions.integerValue,
            '| players', v2.fields.players.integerValue, '(kept, not reset)');
const stillV1 = await (await fetch(`${FS}/published/brenta1/versions/1`, ADMIN)).json();
console.log('v1 still says :', stillV1.fields.name.stringValue,
            'with', stillV1.fields.features.arrayValue.values.length, 'features');

const missing = await open(browser, APP.replace(/\/$/, '') + '/q/doesnotexist');
await missing.waitForTimeout(2000);
console.log('dead link     :', (await missing.locator('.missing').innerText()).split('.')[0] + '.');

await browser.close();
