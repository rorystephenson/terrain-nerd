/**
 * Puts the rendered tiles in Cloudflare R2.
 *
 * Individual objects rather than one archive, because coverage only ever grows:
 * adding a region uploads its new tiles and nothing else, where a single archive
 * would have to be rebuilt and re-sent whole every time.
 *
 * What gets sent is decided by content, not by presence. R2 returns each
 * object's MD5 as its ETag, so a tile is uploaded when it is new or when the
 * bytes differ and skipped otherwise — an interrupted run costs nothing to
 * repeat, growing the coverage sends its own tiles plus the wider ones that had
 * to be redrawn, and a re-render sends exactly what the re-render changed.
 * Presence alone was not enough: a redrawn tile keeps its path, so skipping
 * what was already there left the old picture live.
 *
 * `--force` sends everything regardless, which should never be needed.
 * `--dry-run` reports what would go and sends nothing.
 *
 * Credentials come from `.env`, which is gitignored.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

const REPO = resolve(import.meta.dirname, '../..');
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

const env = Object.fromEntries(
  (await readFile(join(REPO, '.env'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  if (!env[key]) throw new Error(`Missing ${key} in .env`);
}

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
const Bucket = env.R2_BUCKET;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

/** Every `.webp` under the tile directory, as `z/x/y.webp` keys. */
async function localTiles(dir = TILES, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await localTiles(path, `${prefix}${entry.name}/`)));
    else if (entry.name.endsWith('.webp')) out.push({ key: `${prefix}${entry.name}`, path });
  }
  return out;
}

/**
 * Every object in the bucket, by key, with the MD5 R2 holds for it.
 *
 * A multipart upload's ETag is not an MD5 — it carries a `-parts` suffix — so
 * one of those is reported as unknown and re-sent. Tiles are a hundred
 * kilobytes and go up in a single PUT, so this does not come up in practice.
 */
async function alreadyThere() {
  const held = new Map();
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    for (const object of page.Contents ?? []) {
      const etag = (object.ETag ?? '').replaceAll('"', '');
      held.set(object.Key, etag.includes('-') ? null : etag);
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return held;
}

const md5 = (body) => createHash('md5').update(body).digest('hex');

try {
  await stat(TILES);
} catch {
  throw new Error(`No tiles at ${TILES} — run \`node tools/render/render.mjs\` first.`);
}

const tiles = await localTiles();
console.log(`${tiles.length.toLocaleString()} tiles on disk`);

const held = force ? new Map() : await alreadyThere();
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

let done = 0;
let bytes = 0;
const started = Date.now();
const CONCURRENCY = 16;

let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < todo.length) {
      const tile = todo[next++];
      const { body } = tile;
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: tile.key,
          Body: body,
          ContentType: 'image/webp',
          CacheControl: CACHE_CONTROL,
        }),
      );
      bytes += body.length;
      // Let it go: on a full re-render this array holds the whole pyramid.
      tile.body = null;
      if (++done % 100 === 0) {
        process.stdout.write(`\r  ${done}/${todo.length}  ${(bytes / 1048576).toFixed(0)} MB   `);
      }
    }
  }),
);

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(
  `\r${done.toLocaleString()} uploaded, ${(bytes / 1048576).toFixed(0)} MB, ${mins} min`.padEnd(60),
);
