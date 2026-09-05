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

let bad = 0;
for (const origin of origins) {
  for (const [what, url] of targets) {
    const response = await fetch(url, { headers: { Origin: origin } }).catch(() => null);
    const allow = response?.headers.get('access-control-allow-origin');
    const ok = response?.ok && (allow === origin || allow === '*');
    if (!ok) bad++;
    console.log(
      `${ok ? 'ok  ' : 'NO  '} ${origin.padEnd(28)} ${what.padEnd(8)} ` +
        `${response ? `HTTP ${response.status}` : 'unreachable'}` +
        `${allow ? ` allow-origin: ${allow}` : ' no allow-origin header'}`,
    );
  }
}

if (bad > 0) {
  console.error(
    `\n${bad} of ${origins.length * targets.length} refused.` +
      '\nAdd the origin to the bucket policy: Cloudflare dashboard > R2 >' +
      '\n<bucket> > Settings > CORS Policy. Until it is there, a build served' +
      '\nfrom that origin gets a blank basemap and empty quizzes, and nothing' +
      '\nabout it shows on a dev server.',
  );
  process.exitCode = 1;
}
