/**
 * Puts the rendered tiles in Cloudflare R2.
 *
 * Individual objects rather than one archive, because coverage only ever grows:
 * adding a region uploads its new tiles and nothing else, where a single archive
 * would have to be rebuilt and re-sent whole every time.
 *
 * Idempotent by listing what is already there and skipping it, so an interrupted
 * run costs nothing to repeat and a coverage change costs only its own tiles.
 * `--force` re-uploads everything, which is what a re-render needs.
 *
 * Credentials come from `.env`, which is gitignored.
 */
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

async function alreadyThere() {
  const held = new Set();
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    for (const object of page.Contents ?? []) held.add(object.Key);
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return held;
}

try {
  await stat(TILES);
} catch {
  throw new Error(`No tiles at ${TILES} — run \`node tools/render/render.mjs\` first.`);
}

const tiles = await localTiles();
console.log(`${tiles.length.toLocaleString()} tiles on disk`);

const held = force ? new Set() : await alreadyThere();
if (!force) console.log(`${held.size.toLocaleString()} already in ${Bucket}`);

const todo = tiles.filter((t) => !held.has(t.key));
if (todo.length === 0) {
  console.log('nothing to upload');
  process.exit(0);
}
console.log(`uploading ${todo.length.toLocaleString()}…`);

let done = 0;
let bytes = 0;
const started = Date.now();
const CONCURRENCY = 16;

let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < todo.length) {
      const tile = todo[next++];
      const body = await readFile(tile.path);
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
