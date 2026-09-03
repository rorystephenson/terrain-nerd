/**
 * Drives the render page over every tile the coverage needs.
 *
 * Two things make this bearable to run. Tiles are drawn 16 at a time — a 2048px
 * canvas is exactly a 4x4 block at its own zoom — so the pyramid costs a couple
 * of hundred screenshots rather than a couple of thousand. And the Terrarium DEM
 * is cached to disk on the way through, so a re-render after a style change
 * costs no network at all.
 *
 * Resumable: a tile already on disk is never redrawn, and growing the coverage
 * redraws only what growing it actually changed. `--force` redraws everything,
 * which is what a style change needs.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { coverageHash, readCoverage, staleTiles } from '../../pipeline/src/coverage.ts';

const REPO = resolve(import.meta.dirname, '../..');
const OUT = join(REPO, 'pipeline/cache/tiles');
const DEM_CACHE = join(REPO, 'pipeline/cache/dem');
/** What the tiles on disk were drawn for. Lives with them, so it dies with them. */
const MANIFEST = join(OUT, 'manifest.json');
/** The vector tiles the basemap draws its roads, water and glaciers from. */
const VECTOR = join(REPO, 'pipeline/cache/context.pmtiles');
const CONFIG = join(import.meta.dirname, 'vite.config.ts');

const MIN_ZOOM = 4;
const MAX_ZOOM = Number(process.env.TILE_MAX_ZOOM ?? 11);

const force = process.argv.includes('--force');

const exists = (path) => stat(path).then(() => true, () => false);
const mtime = (path) => stat(path).then((s) => s.mtimeMs, () => 0);

const cellXY = (cell) => {
  const m = /^x(-?\d+)y(-?\d+)$/.exec(cell);
  if (!m) throw new Error(`Not a cell key: ${cell}`);
  return [Number(m[1]), Number(m[2])];
};

/** Every tile the coverage needs, by zoom, as `x/y` keys. */
function wanted(coverage) {
  const byZoom = new Map();
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) byZoom.set(z, new Set());
  for (const cell of coverage.cells) {
    const [cx, cy] = cellXY(cell);
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

/**
 * What the tiles on disk claim to have been drawn for.
 *
 * With no manifest the pyramid predates one, and its tiles were drawn from
 * whatever `coverage.json` held at the time — which is what it holds now, so
 * adopting the current coverage is right for that one migration run. If the two
 * really had diverged, `--force` is the answer and the manifest is then true.
 */
async function drawnFor(current) {
  try {
    const held = JSON.parse(await readFile(MANIFEST, 'utf8'));
    if (Array.isArray(held.cells) && typeof held.zoom === 'number') return held;
  } catch {
    /* no manifest, or one we cannot read: fall through */
  }
  return { zoom: current.zoom, cells: current.cells, drawnAt: null };
}

const coverage = readCoverage();
if (!coverage) throw new Error('No pipeline/coverage.json — pick coverage first with `npm run coverage`.');

const byZoom = wanted(coverage);
const total = [...byZoom.values()].reduce((n, s) => n + s.size, 0);
console.log(`coverage ${coverage.cells.length} cells -> ${total.toLocaleString()} tiles, z${MIN_ZOOM}-z${MAX_ZOOM}`);

const previous = await drawnFor(coverage);
let dropped = 0;
if (!force) {
  for (const tile of staleTiles(previous, coverage, MIN_ZOOM, MAX_ZOOM)) {
    const path = join(OUT, `${tile}.webp`);
    if (!(await exists(path))) continue;
    await rm(path);
    dropped++;
  }
  if (dropped) {
    const grew = coverage.cells.length - previous.cells.length;
    console.log(`coverage changed by ${grew >= 0 ? '+' : ''}${grew} cells -> ${dropped} tiles dropped as stale`);
  }
  /*
   * The vector tiles are the other input, and nothing about a tile's path says
   * which build drew it. A warning rather than a mass delete: rebuilding
   * context.pmtiles is routine and usually changes nothing anyone can see,
   * where throwing away the pyramid every time build:data ran would make a
   * style change and a no-op cost the same.
   */
  if (previous.drawnAt && (await mtime(VECTOR)) > Date.parse(previous.drawnAt)) {
    console.log('note: context.pmtiles is newer than these tiles — `--force` redraws them all');
  }
}

/*
 * The page is served from here rather than from a second terminal. It is not
 * a thing anyone opens on its own — it exists to be screenshotted — and a
 * render that half-runs because the server was not up is a confusing way to
 * find that out.
 */
const server = await createServer({ configFile: CONFIG });
await server.listen();
const PAGE = server.resolvedUrls.local[0];
console.log(`render page at ${PAGE}`);

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
// The renderer paints the coverage boundary into the tiles, so it needs to know it.
await page.evaluate(([z, cells]) => window.setCoverage(z, cells), [coverage.zoom, coverage.cells]);

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
        if (!force && (await exists(join(OUT, `${z}/${bx + dx}/${by + dy}.webp`)))) { skipped++; continue; }
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
await server.close();

/*
 * Last, and only on a clean run. Written earlier, an interrupt would leave a
 * manifest claiming ground that was never drawn — and the next run, seeing no
 * change, would skip exactly the tiles that are missing.
 */
await writeFile(
  MANIFEST,
  `${JSON.stringify(
    {
      zoom: coverage.zoom,
      hash: coverageHash(coverage),
      maxZoom: MAX_ZOOM,
      drawnAt: new Date().toISOString(),
      cells: [...coverage.cells].sort(),
    },
    null,
    1,
  )}\n`,
);

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(
  `\n${written.toLocaleString()} written (${dropped.toLocaleString()} of them redraws), ` +
    `${skipped.toLocaleString()} already present, ${mins} min`,
);
console.log(`DEM: ${demFetches.toLocaleString()} fetched, ${demHits.toLocaleString()} from cache`);
