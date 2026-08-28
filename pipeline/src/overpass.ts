import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = join(HERE, '..', 'cache');

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'terrain-nerd/0.1 (https://github.com/terrain-nerd)';
const MAX_ATTEMPTS = 4;

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
 * The public Overpass endpoint answers "too many requests" and "gateway
 * timeout" with an HTML page served as **HTTP 200**, so the status code alone
 * cannot be trusted. Sniff the payload for JSON instead.
 */
function looksLikeJson(body: string): boolean {
  return body.trimStart().startsWith('{');
}

export async function runQuery(query: string): Promise<OverpassResponse> {
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
        body: query,
      });
      const body = await response.text();
      if (response.ok && looksLikeJson(body)) return JSON.parse(body) as OverpassResponse;
      lastError = `HTTP ${response.status}, ${body.trimStart().slice(0, 120).replace(/\s+/g, ' ')}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < MAX_ATTEMPTS) {
      const backoff = 5000 * 2 ** (attempt - 1);
      console.warn(`  overpass attempt ${attempt} failed (${lastError}); retrying in ${backoff / 1000}s`);
      await sleep(backoff);
    }
  }
  throw new Error(`Overpass failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
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
