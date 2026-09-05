/**
 * Puts the rendered basemap tiles in Cloudflare R2.
 *
 * Individual objects rather than one archive, because coverage only ever grows:
 * adding a region uploads its new tiles and nothing else, where a single archive
 * would have to be rebuilt and re-sent whole every time.
 *
 * What gets sent is decided by content, not by presence — see `r2.mjs`, which
 * the pool uploader shares. Presence alone was not enough: a redrawn tile keeps
 * its path, so skipping what was already there left the old picture live.
 *
 * `--force` sends everything regardless, which should never be needed.
 * `--dry-run` reports what would go and sends nothing.
 *
 * Credentials come from `.env`, which is gitignored.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO, alreadyThere, client, md5, putAll, readEnv, walk } from './r2.mjs';

const TILES = join(REPO, 'pipeline/cache/tiles');

/**
 * A day rather than a year.
 *
 * The tiles at a given path are not immutable — a style change or a re-render
 * replaces every one of them in place. Marked immutable they would sit in edge
 * and browser caches until something purged them, and the map people saw would
 * be whichever version they happened to load first.
 */
const CACHE_CONTROL = 'public, max-age=86400';

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

const env = await readEnv();
const s3 = client(env);
const Bucket = env.R2_BUCKET;

try {
  await stat(TILES);
} catch {
  throw new Error(`No tiles at ${TILES} — run \`npm run render:tiles\` first.`);
}

const tiles = await walk(TILES, '.webp');
console.log(`${tiles.length.toLocaleString()} tiles on disk`);

/*
 * Listed without a prefix, then filtered: tiles sit at the bucket root as
 * `{z}/{x}/{y}.webp`, and the pool lives under `data/`. Whatever is not ours
 * is not ours to reason about.
 */
const held = force ? new Map() : await alreadyThere(s3, Bucket);
for (const key of [...held.keys()]) if (key.startsWith('data/')) held.delete(key);
if (!force) console.log(`${held.size.toLocaleString()} already in ${Bucket}`);

/*
 * Hashing reads the whole pyramid, which is a second or two of local disk for
 * 127 MB and the only way to tell a redrawn tile from an unchanged one. The
 * bodies are kept for the ones being sent, so nothing is read twice.
 */
const todo = [];
let unchanged = 0;
let replaced = 0;
for (const tile of tiles) {
  const body = await readFile(tile.path);
  if (!force) {
    const there = held.get(tile.key);
    if (there !== undefined && there === md5(body)) {
      unchanged++;
      continue;
    }
    if (there !== undefined) replaced++;
  }
  todo.push({ ...tile, body });
}

if (todo.length === 0) {
  console.log(`nothing to upload — all ${unchanged.toLocaleString()} tiles match`);
  process.exit(0);
}
console.log(
  `${dryRun ? 'would upload' : 'uploading'} ${todo.length.toLocaleString()} ` +
    `(${(todo.length - replaced).toLocaleString()} new, ${replaced.toLocaleString()} changed), ` +
    `${unchanged.toLocaleString()} unchanged${dryRun ? '' : '…'}`,
);

if (dryRun) {
  for (const tile of todo.slice(0, 20)) console.log(`  ${tile.key}`);
  if (todo.length > 20) console.log(`  …and ${(todo.length - 20).toLocaleString()} more`);
  process.exit(0);
}

const started = Date.now();
const { done, bytes } = await putAll(s3, Bucket, todo, {
  contentType: 'image/webp',
  cacheControl: CACHE_CONTROL,
});

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(
  `\r${done.toLocaleString()} uploaded, ${(bytes / 1048576).toFixed(0)} MB, ${mins} min`.padEnd(60),
);
