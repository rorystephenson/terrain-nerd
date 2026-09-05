/**
 * Browsing shared quizzes on a map, against the emulator suite.
 *
 * `discover.test.ts` covers the arithmetic — clustering, the elliptical reach,
 * what is on screen, where a group flies to. What it cannot cover is any of it
 * meeting a real projection, a real style and a real component lifetime, which
 * is where this screen's bugs have actually been:
 *
 *   - pins for quizzes hundreds of kilometres off screen stayed in the document,
 *     clipped out of sight but still in the tab order;
 *   - lighting a footprint by feature state threw on the way out of the screen,
 *     because the teardown ran after the map had been removed.
 *
 * Neither is visible to a unit test and neither is visible on the screen. So
 * this drives the real thing and listens for page errors while it does.
 *
 * Needs the emulator suite and a dev server pointed at it — see `flow.mjs`.
 */
import { chromium } from 'playwright';

const APP = 'http://localhost:5173';
const FS = 'http://127.0.0.1:8080/v1/projects/terrain-nerd/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099';
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

const reset = async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/terrain-nerd/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH}/emulator/v1/projects/terrain-nerd/accounts`, { method: 'DELETE' });
};

// The client's own z7 cell arithmetic, because a published quiz is found by the
// cells it stores and a seed that stored the wrong ones would be found by
// nothing. `grid.test.ts` pins this shape against the pipeline's copy.
const TILE = 512;
const LIMIT = 85.051129;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const worldX = (lon, size) => ((lon + 180) / 360) * size;
const worldY = (lat, size) => {
  const phi = (clamp(lat, -LIMIT, LIMIT) * Math.PI) / 180;
  return (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * size;
};
function cellsCovering([w, s, e, n], zoom = 7) {
  const size = TILE * 2 ** zoom;
  const minX = Math.floor(worldX(w, size) / TILE);
  const minY = Math.floor(worldY(n, size) / TILE);
  const maxX = Math.max(minX, Math.ceil(worldX(e, size) / TILE) - 1);
  const maxY = Math.max(minY, Math.ceil(worldY(s, size) / TILE) - 1);
  const out = [];
  for (let ix = minX; ix <= maxX; ix++) for (let iy = minY; iy <= maxY; iy++) out.push(`x${ix}y${iy}`);
  return out;
}

/**
 * Quizzes spread the way real ones are: a knot of them over one flying site,
 * and a few scattered far enough to be their own pins. The knot is the case
 * that matters — six plates on one valley is the normal state of this screen,
 * not the pathological one.
 */
const QUIZZES = [
  ['Dolomiti di Brenta', 'Rory', [10.80, 46.05, 11.05, 46.30], 12],
  ['Val Rendena',        'Rory', [10.70, 46.00, 10.85, 46.20], 4],
  ['Paganella',          'Ana',  [11.00, 46.10, 11.12, 46.22], 7],
  ['Marmolada',          'Ana',  [11.75, 46.38, 11.95, 46.50], 3],
  ['Monte Baldo',        'Kit',  [10.80, 45.60, 10.95, 45.85], 9],
  ['Monte Bianco',       'Ana',  [ 6.80, 45.75,  7.05, 45.92], 21],
  ['Etna',               'Kit',  [14.90, 37.65, 15.10, 37.85], 6],
];

const str = (v) => ({ stringValue: v });
const num = (v) => ({ integerValue: String(v) });

async function seed() {
  for (const [name, owner, bbox, players] of QUIZZES) {
    const id = 'q' + name.toLowerCase().replace(/[^a-z]/g, '');
    const count = 4 + players;
    const body = { fields: {
      schema: num(1),
      ownerId: str('u-' + owner),
      ownerName: str(owner),
      name: str(name),
      version: num(1),
      publishedAt: str(new Date(Date.now() - players * 3.6e6).toISOString()),
      features: { arrayValue: { values: Array.from({ length: count }, (_, i) => ({
        mapValue: { fields: { id: str(`peak/n${i}${id}`), kind: str('peak'), name: str(`${name} ${i + 1}`) } },
      })) } },
      bbox: { arrayValue: { values: bbox.map((v) => ({ doubleValue: v })) } },
      kinds: { arrayValue: { values: [str('peak')] } },
      counts: { mapValue: { fields: {
        valley: num(0), peak: num(count), pass: num(0), questions: num(count),
      } } },
      cells: { arrayValue: { values: cellsCovering(bbox).map(str) } },
      cellZoom: num(7),
      players: num(players),
      hidden: { booleanValue: false },
    } };
    const response = await fetch(`${FS}/published?documentId=${id}`, {
      method: 'POST', headers: ADMIN, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`could not seed ${id}: ${response.status}`);
  }
}

const plates = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.pin')].map((p) => p.innerText.replace(/\n/g, ' ')));

await reset();
await seed();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });

/**
 * Every page error, kept rather than printed as it arrives.
 *
 * The teardown crash threw while the screen was already changing to the round,
 * so nothing on screen looked wrong and nothing failed. Collected here and
 * reported at the end, it cannot be missed.
 */
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.goto(`${APP}/browse`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

console.log('tabs offered  :', await page.evaluate(() =>
  [...document.querySelectorAll('nav button')].map((b) => b.innerText)));
console.log('opens showing :', JSON.stringify(await plates(page)));
console.log('  spoken as   :', await page.evaluate(() =>
  [...document.querySelectorAll('.pin')].map((p) => p.getAttribute('aria-label'))));

// Nothing off screen may be left in the document: it is clipped from sight but
// not from the tab order.
console.log('all on screen :', await page.evaluate(() => {
  const box = document.querySelector('.map').getBoundingClientRect();
  return [...document.querySelectorAll('.pin')].every((pin) => {
    const at = pin.getBoundingClientRect();
    return at.right > box.left - 1 && at.left < box.right + 1
      && at.bottom > box.top - 1 && at.top < box.bottom + 1;
  });
}));

// A group of quizzes is pressed to separate it, and the keyboard must do it too.
const group = page.locator('.pin--many').first();
if (await group.count()) {
  console.log('\npressing      :', await group.innerText());
  await group.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  console.log('  splits into :', JSON.stringify(await plates(page)));
}

// One quiz, its card, and the round it starts.
await page.locator('.pin:not(.pin--many)').first().click();
await page.waitForTimeout(800);
console.log('\ncard          :', (await page.locator('.card').innerText()).replace(/\n/g, ' · '));
console.log('  lit         :', await page.evaluate(() => Boolean(document.querySelector('.pin--on'))));

await page.locator('.play').click();
await page.waitForTimeout(3500);
console.log('  plays        :', await page.evaluate(() => location.pathname));

console.log('\npage errors   :', errors.length === 0 ? 'none' : errors);
await browser.close();
if (errors.length > 0) process.exitCode = 1;
