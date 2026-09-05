/**
 * Puts the feature pool in Cloudflare R2, beside the tiles.
 *
 * The pool is ~40 MB across ~650 cells. It used to ship inside the built site,
 * which meant every deploy carried 40 MB of pipeline output that changes only
 * when the pipeline runs. In the bucket it sits next to the basemap it belongs
 * with, egress is free, and a deploy is the ~1 MB of app shell again.
 *
 * Two things make this different from `render/upload.mjs`, and both matter:
 *
 * **`index.json` goes last.** It is the manifest — the app reads it to learn
 * which cells hold anything and never asks for a cell it does not list. Sent
 * first, it would advertise cells that were not up yet, and `loadCell` turns a
 * failed fetch into an empty list rather than an error, so the symptom would be
 * quizzes that are quietly missing features rather than anything that looks
 * broken. Cells first, index afterwards: at every instant the index is true.
 *
 * **Orphans are removed.** Tiles only ever accumulate, but a rebuilt pool can
 * drop a cell — coverage shrinks, or a kind stops having anything in a square.
 * Those are unreachable rather than harmful, since the index no longer lists
 * them, but they are litter in a bucket that is paid for by the byte. They go
 * after the index is live, never before, for the same reason.
 *
 *   node tools/upload/data.mjs              # send what changed, prune orphans
 *   node tools/upload/data.mjs --dry-run    # say what would happen
 *   node tools/upload/data.mjs --force      # send everything
 *   node tools/upload/data.mjs --keep       # leave orphans alone
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO, alreadyThere, client, deleteAll, md5, putAll, readEnv, walk } from './r2.mjs';

const DATA = join(REPO, 'pipeline/cache/data');

/** Everything under this key prefix belongs to the pool, and nothing else does. */
const PREFIX = 'data/';

/**
 * A day for cells, five minutes for the index.
 *
 * Neither is immutable: a rebuild rewrites both in place under the same paths.
 * The index gets the short one because it is what tells a browser that new
 * cells exist — cached for a day, ground added this morning would be invisible
 * until tomorrow. It is 16 KB, so revalidating it often costs nothing.
 */
const CELL_CACHE = 'public, max-age=86400';
const INDEX_CACHE = 'public, max-age=300';

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
const keep = process.argv.includes('--keep');

const env = await readEnv();
const s3 = client(env);
const Bucket = env.R2_BUCKET;

try {
  await stat(DATA);
} catch {
  throw new Error(`No pool at ${DATA} — run \`npm run build:data\` first.`);
}

// The index is read before anything is sent, because a pool without a readable
// one is not a pool and there is nothing safe to do with it — least of all
// work out which of the objects already up there are now orphans.
let index;
try {
  index = JSON.parse(await readFile(join(DATA, 'index.json'), 'utf8'));
  if (!Array.isArray(index.kinds) || index.kinds.length === 0) throw new Error('no kinds');
} catch (error) {
  throw new Error(`${join(DATA, 'index.json')} is missing or unreadable (${error.message}). ` +
    'Refusing to upload: the index is what says which cells exist.');
}

const cells = (await walk(DATA, '.geojson')).map((f) => ({ ...f, key: PREFIX + f.key }));
console.log(`${cells.length.toLocaleString()} cells on disk, pool built ${index.generatedAt}`);

const held = force ? new Map() : await alreadyThere(s3, Bucket, PREFIX);
if (!force) console.log(`${held.size.toLocaleString()} objects already under ${PREFIX}`);

const todo = [];
let unchanged = 0;
let replaced = 0;
for (const cell of cells) {
  const body = await readFile(cell.path);
  if (!force) {
    const there = held.get(cell.key);
    if (there !== undefined && there === md5(body)) {
      unchanged++;
      continue;
    }
    if (there !== undefined) replaced++;
  }
  todo.push({ ...cell, body });
}

const indexBody = await readFile(join(DATA, 'index.json'));
const indexKey = PREFIX + 'index.json';
const indexChanged = force || held.get(indexKey) !== md5(indexBody);

/*
 * Orphans: up there, under our prefix, and no longer on disk. The index is
 * never one of them.
 */
const local = new Set([...cells.map((c) => c.key), indexKey]);
const orphans = [...held.keys()].filter((key) => !local.has(key));

if (todo.length === 0 && !indexChanged && orphans.length === 0) {
  console.log(`nothing to do — all ${unchanged.toLocaleString()} cells match`);
  process.exit(0);
}

console.log(
  `${dryRun ? 'would send' : 'sending'} ${todo.length.toLocaleString()} cells ` +
    `(${(todo.length - replaced).toLocaleString()} new, ${replaced.toLocaleString()} changed), ` +
    `${unchanged.toLocaleString()} unchanged` +
    `${indexChanged ? ', then the index' : ', index unchanged'}` +
    `${orphans.length > 0 ? `, ${keep ? 'leaving' : 'then removing'} ${orphans.length} orphaned` : ''}`,
);

/*
 * A guard, not a policy. Pruning is scoped to our own prefix and driven by what
 * is on disk, so the way it goes wrong is a pool that is half-built rather than
 * a key computed wrongly — and a half-built pool would take most of the bucket
 * with it. Anything over a quarter stops and asks.
 */
const share = held.size > 0 ? orphans.length / held.size : 0;
const tooMany = !keep && orphans.length > 0 && share > 0.25;
if (tooMany) {
  console.log(
    `\nrefusing to remove ${orphans.length} of ${held.size} objects (${(share * 100).toFixed(0)}%).` +
      '\nThat is a large enough share to look like a half-built pool rather than a' +
      '\nshrunken one. Check `pipeline/cache/data`, then re-run with --keep to upload' +
      '\nwithout pruning, or delete them from the dashboard if they really are gone.',
  );
}

if (dryRun) {
  for (const cell of todo.slice(0, 10)) console.log(`  + ${cell.key}`);
  if (todo.length > 10) console.log(`  …and ${(todo.length - 10).toLocaleString()} more`);
  for (const key of orphans.slice(0, 10)) console.log(`  - ${key}`);
  process.exit(0);
}

const started = Date.now();
const { done, bytes } = await putAll(s3, Bucket, todo, {
  contentType: 'application/json',
  cacheControl: CELL_CACHE,
});

// Only now: every cell it names is up.
if (indexChanged) {
  await putAll(s3, Bucket, [{ key: indexKey, body: indexBody }], {
    contentType: 'application/json',
    cacheControl: INDEX_CACHE,
  });
}

// And only now: nothing live points at them any more.
if (orphans.length > 0 && !keep && !tooMany) {
  await deleteAll(s3, Bucket, orphans);
}

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(
  `\r${done.toLocaleString()} cells uploaded, ${(bytes / 1048576).toFixed(0)} MB, ${secs}s` +
    `${indexChanged ? ' (index last)' : ''}` +
    `${orphans.length > 0 && !keep && !tooMany ? `, ${orphans.length} removed` : ''}`.padEnd(20),
);
