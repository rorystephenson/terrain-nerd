/**
 * Drives the render page over every tile the coverage needs.
 *
 * Two things make this bearable to run. Tiles are drawn 16 at a time — a 2048px
 * canvas is exactly a 4x4 block at its own zoom — so the pyramid costs a couple
 * of hundred screenshots rather than a couple of thousand. And the Terrarium DEM
 * is cached to disk on the way through, so a re-render after a style change
 * costs no network at all.
 *
 * Resumable: a tile already on disk is never redrawn.
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { readCoverage } from '../../pipeline/src/coverage.ts';

const REPO = resolve(import.meta.dirname, '../..');
const OUT = join(REPO, 'pipeline/cache/tiles');
const DEM_CACHE = join(REPO, 'pipeline/cache/dem');
const PAGE = 'http://localhost:5175/';

const MIN_ZOOM = 4;
const MAX_ZOOM = Number(process.env.TILE_MAX_ZOOM ?? 11);

const exists = (path) => stat(path).then(() => true, () => false);

/** Every tile the coverage needs, by zoom, as `x/y` keys. */
function wanted(coverage) {
  const byZoom = new Map();
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) byZoom.set(z, new Set());
  for (const cell of coverage.cells) {
    const m = /^x(-?\d+)y(-?\d+)$/.exec(cell);
    const [cx, cy] = [Number(m[1]), Number(m[2])];
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
      if (z >= coverage.zoom) {
        const f = 2 ** (z - coverage.zoom);
        for (let dx = 0; dx < f; dx++)
          for (let dy = 0; dy < f; dy++) byZoom.get(z).add(`${cx * f + dx}/${cy * f + dy}`);
      } else {
        const f = 2 ** (coverage.zoom - z);
        byZoom.get(z).add(`${Math.floor(cx / f)}/${Math.floor(cy / f)}`);
      }
    }
  }
  return byZoom;
}

const coverage = readCoverage();
if (!coverage) throw new Error('No pipeline/coverage.json — pick coverage first with `npm run coverage`.');

const byZoom = wanted(coverage);
const total = [...byZoom.values()].reduce((n, s) => n + s.size, 0);
console.log(`coverage ${coverage.cells.length} cells -> ${total.toLocaleString()} tiles, z${MIN_ZOOM}-z${MAX_ZOOM}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 2048, height: 2048 }, deviceScaleFactor: 1 });

// The DEM is the slow part of a first run and pure waste on later ones.
await mkdir(DEM_CACHE, { recursive: true });
let demHits = 0;
let demFetches = 0;
await page.route('**/elevation-tiles-prod/**', async (route) => {
  const key = createHash('sha1').update(route.request().url()).digest('hex');
  const path = join(DEM_CACHE, `${key}.png`);
  if (await exists(path)) {
    demHits++;
    return route.fulfill({ status: 200, contentType: 'image/png', body: await readFile(path) });
  }
  const response = await route.fetch();
  const body = await response.body();
  if (response.status() === 200) { demFetches++; await writeFile(path, body); }
  return route.fulfill({ response, body });
});

page.on('pageerror', (error) => console.error('page error:', String(error).slice(0, 200)));
await page.goto(PAGE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.renderBlock === 'function', null, { timeout: 30000 });
const BLOCK = await page.evaluate(() => window.blockSize);

let written = 0;
let skipped = 0;
const started = Date.now();

for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
  const need = byZoom.get(z);
  // Group into blocks aligned to the grid, so a block always maps to whole tiles.
  const blocks = new Set();
  for (const key of need) {
    const [x, y] = key.split('/').map(Number);
    blocks.add(`${Math.floor(x / BLOCK) * BLOCK}/${Math.floor(y / BLOCK) * BLOCK}`);
  }

  let done = 0;
  for (const block of blocks) {
    const [bx, by] = block.split('/').map(Number);

    // Nothing to do if every tile this block would produce is already on disk.
    const missing = [];
    for (let dy = 0; dy < BLOCK; dy++)
      for (let dx = 0; dx < BLOCK; dx++) {
        const key = `${bx + dx}/${by + dy}`;
        if (!need.has(key)) continue;
        if (await exists(join(OUT, `${z}/${bx + dx}/${by + dy}.webp`))) { skipped++; continue; }
        missing.push(key);
      }
    if (missing.length === 0) { done++; continue; }

    const tiles = await page.evaluate(
      ([zz, xx, yy]) => window.renderBlock(zz, xx, yy),
      [z, bx, by],
    );
    for (const key of missing) {
      const [x, y] = key.split('/');
      const path = join(OUT, `${z}/${x}/${y}.webp`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(tiles[key], 'base64'));
      written++;
    }
    done++;
    process.stdout.write(`\r  z${z}: ${done}/${blocks.size} blocks, ${written} tiles written   `);
  }
  console.log(`\r  z${z}: ${blocks.size} blocks, ${need.size} tiles`.padEnd(60));
}

await browser.close();
const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n${written.toLocaleString()} written, ${skipped.toLocaleString()} already present, ${mins} min`);
console.log(`DEM: ${demFetches.toLocaleString()} fetched, ${demHits.toLocaleString()} from cache`);
