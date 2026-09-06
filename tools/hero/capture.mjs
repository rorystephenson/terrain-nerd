/**
 * The home page's hero image, captured from the app itself.
 *
 * The hero has to be a real frame, not a mock-up: the whole point of putting it
 * on the home page is that the terrain render is the most characteristic thing
 * this app has, and a drawing of it would be a worse version of something we
 * already own. So this drives the actual quiz screen and photographs it.
 *
 * The frame is the first question of a round — the prompt bar with a real
 * question above violet unanswered markers. That state needs no clicks to reach,
 * which is what makes the capture deterministic: no timing race against
 * feedback animations, no dependence on which feature got asked first.
 *
 * Needs a dev server, and the tiles the dev server serves out of pipeline/cache:
 *
 *   npm run dev
 *   npm run capture:hero
 *
 * Writes web/public/hero/, which is committed. Re-run it whenever the basemap
 * or the map's own type changes.
 */
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const APP = 'http://localhost:5173';
/*
 * `public/`, not `src/assets/`: the Open Graph tag needs a stable URL, and
 * anything imported through the bundler gets a content hash in its name.
 */
const OUT = new URL('web/public/hero/', root);

/** Adamello–Brenta: high relief, a lake, and enough named ground to read as a map. */
const BBOX = [10.62, 45.98, 11.12, 46.35];
const KINDS = ['peak', 'valley', 'pass'];
const WANTED = 16;

/** The pipeline's chunk grid, so we only read the cells the bbox touches. */
const cellsFor = ([w, s, e, n], zoom) => {
  const scale = 2 ** zoom;
  const x = (lon) => Math.floor(((lon + 180) / 360) * scale);
  const y = (lat) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale);
  };
  const out = [];
  for (let cx = x(w); cx <= x(e); cx++) for (let cy = y(n); cy <= y(s); cy++) out.push(`x${cx}y${cy}`);
  return out;
};

const inside = (feature, [w, s, e, n]) => {
  const [fw, fs, fe, fn] = feature.bbox;
  return fw >= w && fs >= s && fe <= e && fn <= n;
};

/**
 * Picks what the hero shows, on the builder's own terms: prominence first, so
 * the names on the image are the ones somebody flying there would actually know.
 */
async function pickFeatures() {
  const index = JSON.parse(await readFile(new URL('pipeline/cache/data/index.json', root), 'utf8'));
  const cells = cellsFor(BBOX, index.chunkZoom);
  const found = [];
  for (const kind of KINDS) {
    for (const cell of cells) {
      const path = new URL(`pipeline/cache/data/${kind}/${cell}.geojson`, root);
      const raw = await readFile(path, 'utf8').catch(() => null);
      if (!raw) continue;
      for (const feature of JSON.parse(raw).features) {
        if (!inside(feature, BBOX)) continue;
        found.push({
          id: feature.id,
          kind: feature.properties.kind,
          name: feature.properties.name,
          score: feature.properties.prominence ?? 0,
        });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  // One name per place: the pool holds a summit and its ridge under near-identical
  // names, and two of those side by side on the image reads as a bug.
  const seen = new Set();
  const picked = [];
  for (const f of found) {
    const key = f.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ id: f.id, kind: f.kind, name: f.name });
    if (picked.length === WANTED) break;
  }
  return picked;
}

/**
 * Chromium encodes the WebP, so this script needs nothing installed beyond the
 * browser Playwright already brings. `width` is the CSS width we want the file
 * to be; the screenshot comes in at twice that and is scaled down here.
 */
async function toWebp(page, png, width, height) {
  const encoded = await page.evaluate(
    async ([data, w, h]) => {
      const blob = await (await fetch(data)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
      const buffer = await out.arrayBuffer();
      let binary = '';
      for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    [`data:image/png;base64,${png.toString('base64')}`, width, height],
  );
  return Buffer.from(encoded, 'base64');
}

const shoot = async (browser, { width, height, quiz }) => {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(
    ([q]) => localStorage.setItem('terrain-nerd:quizzes', JSON.stringify([q])),
    [quiz],
  );
  const page = await context.newPage();
  // The map's own zoom buttons would land under the headline, and a still has
  // nothing to zoom. Everything else on screen is the app as it really renders.
  await page.addStyleTag({ content: '.maplibregl-ctrl-top-right { display: none }' }).catch(() => {});
  await page.goto(`${APP}/q/${quiz.id}`);
  // The prompt renders as soon as the quiz is built; the tiles behind it are
  // what actually takes the time, and they have no event worth waiting on.
  await page.waitForSelector('.bar', { timeout: 30_000 });
  await page.addStyleTag({ content: '.maplibregl-ctrl-top-right { display: none }' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);

  /*
   * The prompt bar is cropped off.
   *
   * It is the best single frame of the app, but on the home page it would sit
   * directly under the nav as a second white bar, and two of those stacked read
   * as one mushy band rather than as chrome over a map. What the hero needs from
   * this screen is the terrain and the markers; the question is better told by
   * the headline sitting on top of it.
   */
  const bar = await page.locator('.prompt').boundingBox();
  const top = Math.ceil(bar?.height ?? 0);
  const png = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: top, width, height: height - top },
  });
  await context.close();
  return { png, height: height - top };
};

const features = await pickFeatures();
if (features.length < 8) {
  console.error(
    `Only ${features.length} features in the hero bbox — run npm run extract:data && npm run build:data first.`,
  );
  process.exit(1);
}

const quiz = {
  id: 'hero',
  name: 'Adamello - Brenta',
  source: 'built',
  createdAt: '2026-01-01T00:00:00.000Z',
  features,
  bbox: BBOX,
};

const browser = await chromium.launch();
const scratch = await (await browser.newContext()).newPage();

const shots = [
  { file: 'hero.webp', width: 1600, height: 900 },
  { file: 'hero@2x.webp', width: 1600, height: 900, scale: 2 },
  { file: 'hero-narrow.webp', width: 760, height: 1180 },
];

for (const { file, width, height, scale = 1 } of shots) {
  const shot = await shoot(browser, { width, height, quiz });
  const webp = await toWebp(scratch, shot.png, width * scale, shot.height * scale);
  await writeFile(new URL(file, OUT), webp);
  console.log(`${file}  ${width * scale}×${shot.height * scale}  ${(webp.length / 1024).toFixed(0)} KB`);
}

await browser.close();
console.log(`\n${features.length} features: ${features.map((f) => f.name).join(', ')}`);
