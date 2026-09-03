import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LonLat } from './geo.ts';
import type { KindId } from './featureTypes.ts';
import type { QuizFeature } from './normalize.ts';
import { CACHE_DIR } from './paths.ts';
import { buildIndex } from './spatial.ts';

/**
 * Scores how "important" a peak or pass is *for paragliding*, which is not the
 * same as how high it is.
 *
 * Ranking by elevation alone is useless here: the top of that list is sub-summits
 * — "Anticima Sud" (literally "south sub-peak"), "Presanella Bassa" — while the
 * names pilots actually say on the radio (Paganella, Stivo, Brento, Altissimo)
 * sit a thousand metres lower. That is also why altitude was rejected as a
 * builder filter. Three signals do much better:
 *
 *  - **Isolation** — distance to the nearest higher peak. This is what separates
 *    a mountain you navigate by from a bump on someone else's ridge, and it
 *    demolishes the sub-summit problem on its own.
 *  - **Wikidata sitelinks** — how many language Wikipedias carry an article. A
 *    decent proxy for "a name you hear often".
 *  - **Distance to a free-flying site** — OSM tags takeoffs and landings, so
 *    peaks near where people actually fly get a boost.
 */

const WIKIDATA_BATCH = 50;
const LAUNCH_RANGE_KM = 12;
/** Isolation past this adds nothing more; it already means "dominates". */
const ISOLATION_CAP_KM = 60;

export type PeakSignals = {
  isolationKm: number;
  sitelinks: number;
  launchKm: number;
  ele: number;
};

const launchTerm = (launchKm: number) =>
  Math.max(0, Math.min(1, (LAUNCH_RANGE_KM - launchKm) / LAUNCH_RANGE_KM));

export function scoreOf(s: PeakSignals): number {
  return (
    2.0 * Math.log2(1 + s.isolationKm) +
    1.0 * s.sitelinks +
    1.5 * launchTerm(s.launchKm) +
    0.8 * (s.ele / 1000)
  );
}

/**
 * Passes score without the isolation term.
 *
 * Isolation is meaningless for a saddle — a pass is by definition a low point
 * between two higher things, so "distance to the nearest higher peak" is always
 * tiny and says nothing about whether anyone names it.
 */
export function passScoreOf(s: Omit<PeakSignals, 'isolationKm'>): number {
  return 1.0 * s.sitelinks + 1.5 * launchTerm(s.launchKm) + 0.5 * Math.log2(1 + s.ele / 500);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sitelink counts, in batches, cached on disk.
 *
 * Wikidata rate-limits hard — plain 429s partway through a run — and a batch
 * that gives up silently scores those peaks as if nobody had ever written about
 * them, which quietly corrupts the ranking. So: cache what we get, only ask for
 * ids we are still missing, and back off generously. That also makes the whole
 * step resumable across runs, which matters at Italy scale.
 */
export async function fetchSitelinks(ids: string[], cacheKey: string): Promise<Map<string, number>> {
  const file = join(CACHE_DIR, `${cacheKey}.json`);
  const counts = new Map<string, number>();
  try {
    const cached = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>;
    for (const [id, count] of Object.entries(cached)) counts.set(id, count);
  } catch {
    // No cache yet.
  }

  const missing = [...new Set(ids)].filter((id) => !counts.has(id));
  if (missing.length === 0) {
    console.log(`  wikidata: ${counts.size} sitelink counts, all cached`);
    return counts;
  }
  console.log(`  wikidata: ${counts.size} cached, fetching ${missing.length} more`);

  let failed = 0;
  let done = 0;
  for (let i = 0; i < missing.length; i += WIKIDATA_BATCH) {
    const batch = missing.slice(i, i + WIKIDATA_BATCH);
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&ids=' +
      batch.join('|');

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'terrain-nerd/0.1 (data pipeline)' },
          // Node's fetch has no default timeout, so a connection the server
          // accepts and then abandons hangs for ever — and the retry below
          // never fires, because the attempt never finishes. A build once sat
          // on one of these for twelve hours having used six seconds of CPU.
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as {
          entities?: Record<string, { sitelinks?: Record<string, unknown> }>;
        };
        for (const [id, entity] of Object.entries(body.entities ?? {})) {
          counts.set(id, Object.keys(entity.sitelinks ?? {}).length);
        }
        break;
      } catch (error) {
        if (attempt === 5) {
          failed += batch.length;
          console.warn(`  wikidata: gave up on ${batch.length} ids (${String(error)})`);
        } else {
          await sleep(3000 * attempt);
        }
      }
    }
    done += batch.length;
    // Checkpoint as we go: a country-sized run should never lose everything
    // because it was interrupted near the end.
    if (done % (WIKIDATA_BATCH * 20) === 0) {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify(Object.fromEntries(counts)));
      console.log(`    ${done}/${missing.length}`);
    }
    await sleep(500);
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(Object.fromEntries(counts)));
  console.log(
    `  wikidata: ${counts.size} sitelink counts` + (failed ? `, ${failed} still missing` : ''),
  );
  return counts;
}

/**
 * Turns raw scores into 0-100 percentiles within each kind.
 *
 * The builder puts a slider on this, and a raw score of "8.3" means nothing to
 * a person choosing what to learn. "Top 20%" does. Equal scores share a
 * percentile so that a block of identically-unknown peaks does not get spread
 * across the range by sort order alone.
 */
export function toPercentiles(scores: Map<string, number>): Map<string, number> {
  const sorted = [...scores.entries()].sort((a, b) => a[1] - b[1]);
  const out = new Map<string, number>();
  if (sorted.length === 0) return out;
  if (sorted.length === 1) return new Map([[sorted[0][0], 100]]);

  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j++;
    const percentile = Math.round((100 * ((i + j) / 2)) / (sorted.length - 1));
    for (let k = i; k <= j; k++) out.set(sorted[k][0], percentile);
    i = j + 1;
  }
  return out;
}

/**
 * Scores every peak and pass in the pool, returning 0-100 percentiles by feature id.
 *
 * The isolation yardstick is the pool's own peaks rather than a separate
 * Overpass fetch of every `ele`-tagged summit: the pool is already every named
 * peak in the country, and a named sub-summit's nearest higher neighbour is
 * essentially always the named main summit it hangs off.
 */
export async function scorePool(
  features: QuizFeature[],
  flyingSites: LonLat[],
  cacheKey: string,
): Promise<Map<string, number>> {
  const peaks = features.filter((f) => f.properties.kind === 'peak');
  const passes = features.filter((f) => f.properties.kind === 'pass');
  const scored = [...peaks, ...passes];

  const wikidataIds = scored
    .map((f) => f.properties.wikidata)
    .filter((id): id is string => typeof id === 'string' && /^Q\d+$/.test(id));
  const sitelinks = await fetchSitelinks(wikidataIds, cacheKey);

  const yardstick = peaks
    .map((f) => ({ at: f.properties.anchor, ele: f.properties.ele ?? 0 }))
    .filter((p) => p.ele > 0);
  const peakIndex = buildIndex(yardstick, (p) => p.at);
  const launchIndex = buildIndex(flyingSites, (p) => p);
  console.log(
    `  scoring ${peaks.length} peaks and ${passes.length} passes ` +
      `(${yardstick.length} with elevation, ${flyingSites.length} flying sites)`,
  );

  const raw = new Map<KindId, Map<string, number>>([
    ['peak', new Map()],
    ['pass', new Map()],
  ]);

  for (const feature of scored) {
    const at = feature.properties.anchor;
    const ele = feature.properties.ele ?? 0;
    const links = sitelinks.get(feature.properties.wikidata ?? '') ?? 0;
    const launchKm = launchIndex.nearest(at, () => true, LAUNCH_RANGE_KM * 4);

    if (feature.properties.kind === 'peak') {
      const isolationKm = peakIndex.nearest(at, (p) => p.ele > ele, ISOLATION_CAP_KM);
      raw.get('peak')!.set(feature.id, scoreOf({ isolationKm, sitelinks: links, launchKm, ele }));
    } else {
      raw.get('pass')!.set(feature.id, passScoreOf({ sitelinks: links, launchKm, ele }));
    }
  }

  const out = new Map<string, number>();
  for (const byKind of raw.values()) {
    for (const [id, percentile] of toPercentiles(byKind)) out.set(id, percentile);
  }
  return out;
}
