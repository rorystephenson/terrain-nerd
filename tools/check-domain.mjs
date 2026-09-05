/**
 * Checks that an origin is allowed to be an origin.
 *
 * Two registrations stand between a deployed build and a working one, both of
 * them per-domain, both invisible in development, and both failing in ways that
 * look nothing like "you forgot to add a domain": the bucket's CORS allowlist,
 * and Firebase's list of domains permitted to run a sign-in popup.
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
 *   npm run check:domain                          # the origins we already expect
 *   npm run check:domain -- https://example.com   # one you are about to deploy to
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

/**
 * Firebase half.
 *
 * `signInWithPopup` and `linkWithPopup` refuse to run on a domain that is not in
 * the project's authorized list, so signing in fails on a fresh deploy with a
 * console message and nothing else — the button simply does nothing. The list is
 * readable with the web API key, which is public by design, so this needs no
 * credentials. Adding to it does need the console.
 */
async function firebaseDomains() {
  const config = await readFile(join(REPO, 'web/src/lib/firebase.ts'), 'utf8');
  const key = /apiKey: '([^']+)'/.exec(config)?.[1];
  const project = /projectId: '([^']+)'/.exec(config)?.[1];
  if (!key) return null;
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${key}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return response ? { project, domains: response.authorizedDomains ?? [] } : null;
}

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

// Firebase's authorized domains, for the same origins.
const firebase = await firebaseDomains();
let unauthorized = 0;
if (firebase) {
  for (const origin of origins) {
    const host = new URL(origin).hostname;
    const ok = firebase.domains.includes(host);
    if (!ok) unauthorized++;
    console.log(`${ok ? 'ok  ' : 'NO  '} ${origin.padEnd(28)} sign-in  ${ok ? 'authorized' : 'not an authorized domain'}`);
  }
  if (unauthorized > 0) {
    console.error(
      `\n${unauthorized} cannot run a sign-in popup.` +
        '\nFirebase console > Authentication > Settings > Authorized domains >' +
        `\nAdd domain. Currently: ${firebase.domains.join(', ')}.` +
        '\nWithout it the sign-in button does nothing at all — `signInWithPopup`' +
        '\nrefuses before it opens, and the only sign of it is a console line.',
    );
  }
} else {
  console.log('??   could not read the Firebase authorized domains — check by hand');
}

if (refused > 0 || stale > 0 || unauthorized > 0) process.exitCode = 1;
