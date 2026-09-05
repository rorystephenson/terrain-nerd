/**
 * The bits of talking to R2 that the tiles and the pool both need.
 *
 * Extracted when the pool moved into the bucket beside the tiles: the same
 * credentials, the same client, and the same rule for deciding what to send.
 * That rule is the part worth sharing — *content*, not presence. R2 returns
 * each object's MD5 as its ETag, so an object goes up when it is new or when
 * the bytes differ, and is skipped otherwise. Presence alone is not enough,
 * because both tiles and pool cells are rewritten in place under a path they
 * keep, and skipping what was already there leaves the old bytes live.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { S3Client, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

export const REPO = resolve(import.meta.dirname, '../..');

/** Credentials, out of the gitignored `.env` at the repo root. */
export async function readEnv() {
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
  return env;
}

export function client(env) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Every object in the bucket under `prefix`, by key, with the MD5 R2 holds.
 *
 * A multipart upload's ETag is not an MD5 — it carries a `-parts` suffix — so
 * one of those is reported as unknown and re-sent. Nothing here is big enough
 * to go up in parts, so it does not come up in practice.
 */
export async function alreadyThere(s3, Bucket, Prefix = undefined) {
  const held = new Map();
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const object of page.Contents ?? []) {
      const etag = (object.ETag ?? '').replaceAll('"', '');
      held.set(object.Key, etag.includes('-') ? null : etag);
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return held;
}

export const md5 = (body) => createHash('md5').update(body).digest('hex');

/** Every file under `dir` matching `ext`, as `prefix`-relative keys. */
export async function walk(dir, ext, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, ext, `${prefix}${entry.name}/`)));
    else if (entry.name.endsWith(ext)) out.push({ key: `${prefix}${entry.name}`, path });
  }
  return out;
}

/** Sends `todo` in parallel, reporting progress on one line. */
export async function putAll(s3, Bucket, todo, { contentType, cacheControl, concurrency = 16 }) {
  let done = 0;
  let bytes = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < todo.length) {
        const item = todo[next++];
        const { body } = item;
        await s3.send(
          new PutObjectCommand({
            Bucket,
            Key: item.key,
            Body: body,
            ContentType: typeof contentType === 'function' ? contentType(item) : contentType,
            CacheControl: typeof cacheControl === 'function' ? cacheControl(item) : cacheControl,
          }),
        );
        bytes += body.length;
        // Let it go: on a full re-send this array holds everything at once.
        item.body = null;
        if (++done % 25 === 0) {
          process.stdout.write(`\r  ${done}/${todo.length}  ${(bytes / 1048576).toFixed(0)} MB   `);
        }
      }
    }),
  );
  return { done, bytes };
}

export async function deleteAll(s3, Bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
}
