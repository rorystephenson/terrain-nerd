import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { haversineKm, type BBox, type LonLat } from './geo.ts';
import type { QuizFeature } from './normalize.ts';
import { CACHE_DIR, cachedQuery } from './overpass.ts';
import type { Region } from './regions.ts';

/**
 * Scores how "important" a peak is *for paragliding*, which is not the same as
 * how high it is.
 *
 * Ranking by elevation alone is useless here: the top of that list is sub-summits
 * — "Anticima Sud" (literally "south sub-peak"), "Presanella Bassa" — while the
 * names pilots actually say on the radio (Paganella, Stivo, Brento, Altissimo)
 * sit a thousand metres lower. Three signals do much better:
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

export function scoreOf(s: PeakSignals): number {
  const launch = Math.max(0, Math.min(1, (LAUNCH_RANGE_KM - s.launchKm) / LAUNCH_RANGE_KM));
  return (
    2.0 * Math.log2(1 + s.isolationKm) +
    1.0 * s.sitelinks +
    1.5 * launch +
    0.8 * (s.ele / 1000)
  );
}

const eleOf = (value: string | number | undefined): number => {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sitelink counts, in batches, cached on disk.
 *
 * Wikidata rate-limits hard — plain 429s partway through a run — and a batch
 * that gives up silently scores those peaks as if nobody had ever written about
 * them, which quietly corrupts the ranking. So: cache what we get, only ask for
 * ids we are still missing, and back off generously.
 */
async function fetchSitelinks(ids: string[], cacheKey: string): Promise<Map<string, number>> {
  const file = join(CACHE_DIR, `${cacheKey}.json`);
  const counts = new Map<string, number>();
  try {
    const cached = JSON.parse(await readFile(file, 'utf8')) as Record<string, number>;
    for (const [id, count] of Object.entries(cached)) counts.set(id, count);
  } catch {
    // No cache yet.
  }

  const missing = ids.filter((id) => !counts.has(id));
  if (missing.length === 0) {
    console.log(`  wikidata: ${counts.size} sitelink counts, all cached`);
    return counts;
  }

  let failed = 0;
  for (let i = 0; i < missing.length; i += WIKIDATA_BATCH) {
    const batch = missing.slice(i, i + WIKIDATA_BATCH);
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&ids=' +
      batch.join('|');

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'terrain-nerd/0.1 (data pipeline)' },
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
    await sleep(500);
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(Object.fromEntries(counts)));
  console.log(
    `  wikidata: ${counts.size} sitelink counts` + (failed ? `, ${failed} still missing` : ''),
  );
  return counts;
}

/** Every peak in a padded box around the region, used as the isolation yardstick. */
async function fetchReferencePeaks(bbox: BBox, refresh: boolean, cacheKey: string) {
  const pad = 0.35;
  const box = [bbox[1] - pad, bbox[0] - pad, bbox[3] + pad, bbox[2] + pad]
    .map((n) => n.toFixed(4))
    .join(',');
  const query = `[out:json][timeout:280];\nnwr["natural"="peak"]["ele"](${box});\nout tags center;`;
  const response = await cachedQuery(cacheKey, query, refresh);
  return response.elements
    .map((element) => {
      const point = element.center ?? { lat: element.lat!, lon: element.lon! };
      return {
        at: [point.lon, point.lat] as LonLat,
        ele: eleOf(element.tags?.ele),
      };
    })
    .filter((peak) => peak.ele > 0 && Number.isFinite(peak.at[0]));
}

async function fetchFlyingSites(bbox: BBox, refresh: boolean, cacheKey: string) {
  const pad = 0.2;
  const box = [bbox[1] - pad, bbox[0] - pad, bbox[3] + pad, bbox[2] + pad]
    .map((n) => n.toFixed(4))
    .join(',');
  const query = [
    '[out:json][timeout:180];',
    '(',
    `  nwr["sport"="free_flying"](${box});`,
    `  nwr["leisure"="free_flying"](${box});`,
    ');',
    'out center;',
  ].join('\n');
  const response = await cachedQuery(cacheKey, query, refresh);
  return response.elements
    .map((element) => {
      const point = element.center ?? { lat: element.lat!, lon: element.lon! };
      return [point.lon, point.lat] as LonLat;
    })
    .filter((at) => Number.isFinite(at[0]));
}

export async function scorePeaks(
  features: QuizFeature[],
  bbox: BBox,
  region: Region,
  refresh: boolean,
): Promise<Map<string, number>> {
  const [reference, launches] = await Promise.all([
    fetchReferencePeaks(bbox, refresh, `${region.id}-peak-reference`),
    fetchFlyingSites(bbox, refresh, `${region.id}-flying-sites`),
  ]);
  console.log(`  isolation yardstick: ${reference.length} peaks, ${launches.length} flying sites`);

  const wikidataIds = features
    .map((f) => f.properties.wikidata)
    .filter((id): id is string => Boolean(id) && /^Q\d+$/.test(id!));
  const sitelinks = await fetchSitelinks(wikidataIds, `${region.id}-sitelinks`);

  const scores = new Map<string, number>();
  for (const feature of features) {
    const at = feature.properties.anchor;
    const ele = feature.properties.ele ?? 0;

    let isolationKm = ISOLATION_CAP_KM;
    for (const peak of reference) {
      if (peak.ele <= ele) continue;
      const distance = haversineKm(at, peak.at);
      if (distance < isolationKm) isolationKm = distance;
    }

    let launchKm = Number.POSITIVE_INFINITY;
    for (const launch of launches) {
      const distance = haversineKm(at, launch);
      if (distance < launchKm) launchKm = distance;
    }

    scores.set(
      feature.id,
      scoreOf({
        isolationKm,
        sitelinks: sitelinks.get(feature.properties.wikidata ?? '') ?? 0,
        launchKm,
        ele,
      }),
    );
  }
  return scores;
}

