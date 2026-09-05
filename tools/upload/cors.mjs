/**
 * Checks that a browser on a given origin may read the bucket.
 *
 * Both the basemap and the pool are read with `fetch` from a page that is not
 * on the bucket's origin — `tiles.ts` wants an `ArrayBuffer` to hand MapLibre,
 * `chunks.ts` wants to parse JSON — so both depend on the bucket's CORS policy
 * naming the origin the app is served from. Nothing about that shows in
 * development, where a dev server serves both same-origin off disk; it shows in
 * production as a blank map and empty quizzes.
 *
 * The policy itself is an **allowlist of origins**, set in the Cloudflare
 * dashboard. That is deliberately not something this tool writes, for two
 * reasons: the upload token in `.env` is scoped to objects and cannot read or
 * write bucket settings, which is the right scope for a long-lived credential
 * to have — and a tool that rewrote the policy wholesale would be one command
 * away from replacing a considered allowlist with something laxer and dropping
 * the `Range` and `Content-Range` headers the pmtiles reads depend on.
 *
 * So this asks the question that actually matters, and needs no credentials at
 * all: given an origin, does the bucket let it read? Adding a new deploy domain
 * means adding it in the dashboard and confirming it here.
 *
 *   npm run r2:cors                          # the origins we already expect
 *   npm run r2:cors -- https://example.com   # one you are about to deploy to
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { REPO } from './r2.mjs';

const env = Object.fromEntries(
  (await readFile(join(REPO, 'web/.env.production'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

const targets = [
  ['basemap', `${env.VITE_TILE_BASE}/6/33/22.webp`],
  ['pool', `${env.VITE_DATA_BASE}/index.json`],
];

const given = process.argv.slice(2).filter((arg) => arg.startsWith('http'));
const origins = given.length > 0 ? given : ['http://localhost:5173', 'https://balanci.ng'];

/**
 * Asks twice, and the difference is the whole point.
 *
 * The plain URL is what a visitor gets. The cache-busted one bypasses
 * Cloudflare's edge and is what the bucket policy actually says. When they
 * disagree, the policy is right and the edge is holding a copy cached before it
 * was — and that happens more easily than it sounds: R2 only sends
 * `Vary: Origin` on a response where CORS applies, so a request *without* an
 * Origin header — a `curl -I`, a tile URL opened in a browser tab — is cached
 * under a key with no Vary and then served to everybody, headers and all
 * missing, until the TTL runs out. A day, for tiles.
 *
 * Telling those two apart is the difference between "add the origin" and
 * "purge the cache", which are an hour apart if you guess wrong.
 */
const ask = async (url, origin) => {
  const response = await fetch(url, { headers: { Origin: origin } }).catch(() => null);
  return {
    ok: Boolean(response?.ok) && [origin, '*'].includes(response?.headers.get('access-control-allow-origin')),
    status: response ? `HTTP ${response.status}` : 'unreachable',
    cache: response?.headers.get('cf-cache-status') ?? '',
  };
};

let refused = 0;
let stale = 0;
for (const origin of origins) {
  for (const [what, url] of targets) {
    const live = await ask(url, origin);
    // Only worth asking when the plain one failed.
    const direct = live.ok ? live : await ask(`${url}?cors-probe=${Date.now()}`, origin);

    let verdict;
    if (live.ok) verdict = 'ok  ';
    else if (direct.ok) {
      verdict = 'OLD ';
      stale++;
    } else {
      verdict = 'NO  ';
      refused++;
    }

    console.log(
      `${verdict} ${origin.padEnd(28)} ${what.padEnd(8)} ${live.status}` +
        `${live.cache ? ` ${live.cache.toLowerCase()}` : ''}` +
        `${live.ok ? '' : direct.ok ? ' — allowed at the bucket, stale at the edge' : ' — no allow-origin header'}`,
    );
  }
}

if (stale > 0) {
  console.error(
    `\n${stale} served from a copy cached before the policy allowed this origin.` +
      '\nThe bucket is right; the edge is not. Purge it — Cloudflare dashboard >' +
      '\nthe bucket\'s domain > Caching > Configuration > Purge Everything — and' +
      '\nrun this again. Until then a browser gets exactly what is shown above.',
  );
}

if (refused > 0) {
  console.error(
    `\n${refused} refused by the bucket itself.` +
      '\nAdd the origin to the policy: Cloudflare dashboard > R2 > <bucket> >' +
      '\nSettings > CORS Policy. Until it is there, a build served from that' +
      '\norigin gets a blank basemap and empty quizzes, and nothing about it' +
      '\nshows on a dev server.',
  );
}

if (refused > 0 || stale > 0) process.exitCode = 1;
