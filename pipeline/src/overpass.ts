import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest, Agent } from 'node:https';
import { join } from 'node:path';

import { CACHE_DIR } from './paths.ts';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const STATUS = 'https://overpass-api.de/api/status';
const USER_AGENT = 'terrain-nerd/0.1 (https://github.com/terrain-nerd)';
const MAX_ATTEMPTS = 6;

/**
 * Why a query failed, which decides what the caller should do about it.
 *
 * The distinction matters: a `too-big` cell should be split into quarters, but
 * splitting a `rate-limited` one is actively harmful — it quadruples the
 * request rate that caused the throttling in the first place, and cascades.
 */
export type FailureKind = 'rate-limited' | 'too-big' | 'other';

export class OverpassError extends Error {
  kind: FailureKind;
  constructor(message: string, kind: FailureKind) {
    super(message);
    this.name = 'OverpassError';
    this.kind = kind;
  }
}

function classify(status: number, body: string): FailureKind {
  const text = body.toLowerCase();
  if (status === 429 || text.includes('too many requests') || text.includes('rate_limited')) {
    return 'rate-limited';
  }
  // Only Overpass's own "this query was too much" wording counts as too-big. A
  // bare 504 is usually just an overloaded gateway, and splitting the cell in
  // response would double the load for no reason.
  if (text.includes('query timed out') || text.includes('out of memory')) return 'too-big';
  return 'other';
}

/**
 * How long until the server will give us a slot.
 *
 * Overpass publishes this, so when we are throttled we can wait exactly as long
 * as it asks rather than guessing with exponential backoff.
 */
async function slotWaitMs(): Promise<number> {
  try {
    const response = await fetch(STATUS, { headers: { 'User-Agent': USER_AGENT } });
    const body = await response.text();
    const waits = [...body.matchAll(/in (-?\d+) seconds/g)].map((m) => Number(m[1]));
    const soonest = waits.filter((n) => n > 0).sort((a, b) => a - b)[0];
    return soonest ? (soonest + 2) * 1000 : 0;
  } catch {
    return 0;
  }
}

export type OverpassPoint = { lat: number; lon: number };

export type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: OverpassPoint;
  geometry?: OverpassPoint[];
  members?: { type: string; ref: number; role: string; geometry?: OverpassPoint[] }[];
};

export type OverpassResponse = { elements: OverpassElement[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connections are pooled and long-lived deliberately.
 *
 * `fetch()` was not usable here: undici gives up connecting after 10s, and a
 * loaded Overpass routinely takes longer than that just to accept a socket, so
 * every request died as "fetch failed" before the server had said anything.
 * Keep-alive also stops us re-opening a connection per cell across a run of
 * hundreds.
 */
const agent = new Agent({ keepAlive: true, maxSockets: 4, timeout: 660_000 });

/** Overpass queues requests, so waiting is normal and must not look like failure. */
const CONNECT_TIMEOUT_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 600_000;

function post(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': USER_AGENT,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error('connect timeout')));
    req.on('socket', (socket) => {
      socket.setTimeout(RESPONSE_TIMEOUT_MS, () => req.destroy(new Error('response timeout')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * The public Overpass endpoint answers "too many requests" and "gateway
 * timeout" with an HTML page served as **HTTP 200**, so the status code alone
 * cannot be trusted. Sniff the payload for JSON instead.
 */
function looksLikeJson(body: string): boolean {
  return body.trimStart().startsWith('{');
}

export async function runQuery(query: string): Promise<OverpassResponse> {
  let lastError = '';
  let kind: FailureKind = 'other';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await post(ENDPOINT, query);
      if (response.status === 200 && looksLikeJson(response.body)) {
        return JSON.parse(response.body) as OverpassResponse;
      }
      kind = classify(response.status, response.body);
      lastError = `HTTP ${response.status}, ${response.body.trimStart().slice(0, 90).replace(/\s+/g, ' ')}`;
    } catch (error) {
      // A dropped connection is worth retrying, but it says nothing about size.
      kind = 'other';
      lastError = error instanceof Error ? error.message : String(error);
    }

    // A cell too big to answer will be just as big next time, so stop early and
    // let the caller split it instead of burning the remaining attempts.
    if (kind === 'too-big') break;

    if (attempt < MAX_ATTEMPTS) {
      const announced = kind === 'rate-limited' ? await slotWaitMs() : 0;
      const backoff = Math.max(announced, 5000 * 2 ** Math.min(attempt - 1, 4));
      console.warn(
        `  overpass attempt ${attempt} failed (${kind}: ${lastError}); waiting ${Math.round(backoff / 1000)}s`,
      );
      await sleep(backoff);
    }
  }
  throw new OverpassError(`Overpass failed after ${MAX_ATTEMPTS} attempts: ${lastError}`, kind);
}

/** Runs `query`, caching the raw response so re-runs are offline and instant. */
export async function cachedQuery(
  cacheKey: string,
  query: string,
  refresh: boolean,
): Promise<OverpassResponse> {
  const file = join(CACHE_DIR, `${cacheKey}.json`);
  if (!refresh) {
    try {
      const cached = await readFile(file, 'utf8');
      console.log(`  cache hit: ${cacheKey}`);
      return JSON.parse(cached) as OverpassResponse;
    } catch {
      // Not cached yet — fall through and fetch.
    }
  }
  console.log(`  querying overpass: ${cacheKey}`);
  const result = await runQuery(query);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(result));
  return result;
}

/** Builds a query selecting `selectors` inside the given Overpass area. */
export function buildAreaQuery(areaId: number, selectors: string[], out: 'geom' | 'center'): string {
  const body = selectors.map((selector) => `  ${selector}(area.searchArea);`).join('\n');
  return [
    '[out:json][timeout:180];',
    `area(${areaId})->.searchArea;`,
    '(',
    body,
    ');',
    `out ${out};`,
  ].join('\n');
}
