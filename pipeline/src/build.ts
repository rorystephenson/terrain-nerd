import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { fetchBoundary } from './boundary.ts';
import { buildContext } from './context.ts';
import { getFeatureType, type FeatureType } from './featureTypes.ts';
import { bboxUnion } from './geo.ts';
import { scorePeaks } from './importance.ts';
import { normalize, rankTags, type QuizFeature } from './normalize.ts';
import { areaIdFor, getRegion, type Region } from './regions.ts';
import { buildAreaQuery, cachedQuery } from './overpass.ts';
import { buildZones, fetchSubregions, type Subregion, type Zone } from './zones.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'web', 'public', 'data');

/**
 * Zone sizing. A zone is a fixed set you replay until you know it, so it has to
 * be small enough to finish in one sitting and big enough to be a real test.
 */
const ZONE_LIMITS = { min: 12, max: 28 };

/**
 * Rounds every number to 5 decimal places (~1m) on the way out. OSM carries
 * 7, which triples the size of the river geometry for precision no quiz map
 * can render.
 */
const roundNumbers = (_key: string, value: unknown) =>
  typeof value === 'number' ? Math.round(value * 1e5) / 1e5 : value;

async function writeJson(file: string, data: unknown) {
  await mkdir(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, file);
  await writeFile(path, `${JSON.stringify(data, roundNumbers)}\n`);
  return path;
}

async function buildGroup(
  region: Region,
  featureType: FeatureType,
  subregions: Subregion[],
  boundaryBbox: [number, number, number, number],
  refresh: boolean,
) {
  console.log(`\n${featureType.label}:`);
  const query = buildAreaQuery(areaIdFor(region), featureType.selectors, featureType.out);
  const response = await cachedQuery(`${region.id}-${featureType.id}`, query, refresh);
  const { features, stats } = normalize(response.elements, featureType, await boundaryOf(region, refresh));

  const importance = featureType.scoresImportance
    ? await scorePeaks(features, boundaryBbox, region, refresh)
    : new Map<string, number>();

  const inputOf = (f: QuizFeature) => ({
    tags: rankTags(f),
    lengthKm: f.properties.lengthKm,
    importance: importance.get(f.id) ?? 0,
  });

  const kept = new Set<string>();
  const tiers = featureType.tiers.map((tier) => {
    const chosen = features
      .filter((f) => tier.keep(inputOf(f)))
      .sort((a, b) => featureType.rank(inputOf(b)) - featureType.rank(inputOf(a)))
      .slice(0, tier.limit ?? Number.POSITIVE_INFINITY);
    for (const f of chosen) kept.add(f.id);

    const zones = buildZones(
      chosen.map((f) => f.id),
      new Map(features.map((f) => [f.id, f.properties.anchor])),
      new Map(features.map((f) => [f.id, f.bbox])),
      new Map(features.map((f) => [f.id, f.properties.name])),
      subregions,
      tier.id,
      region.label,
      ZONE_LIMITS,
    );
    return { id: tier.id, label: tier.label, description: tier.description, count: chosen.length, zones };
  });

  // Only ship features some tier actually uses.
  const shipped = features.filter((f) => kept.has(f.id));
  const dataFile = `${featureType.label}-${region.id}.geojson`;
  await writeJson(dataFile, { type: 'FeatureCollection' as const, features: shipped });

  console.log(`  fetched ${stats.fetched}, named ${stats.named}, in region ${stats.inRegion}, kept ${shipped.length}`);
  for (const tier of tiers) {
    console.log(`  ${tier.label}: ${tier.count} features in ${tier.zones.length} zones`);
    for (const zone of tier.zones) {
      const dupes = zone.featureIds.length - zone.questionCount;
      console.log(
        `      ${String(zone.questionCount).padStart(3)}  ${zone.label}` +
          (dupes > 0 ? `  (+${dupes} sharing a name)` : ''),
      );
    }
    warnOnOutliers(tier.zones);
  }

  return {
    id: featureType.id,
    label: featureType.label,
    geometry: featureType.geometry,
    data: dataFile,
    tiers,
  };
}

let boundaryCache: Awaited<ReturnType<typeof fetchBoundary>> | null = null;
async function boundaryOf(region: Region, refresh: boolean) {
  boundaryCache ??= await fetchBoundary(region, refresh);
  return boundaryCache;
}

async function main() {
  const { values } = parseArgs({
    options: {
      region: { type: 'string', default: 'trentino' },
      type: { type: 'string', default: 'valley,peak' },
      refresh: { type: 'boolean', default: false },
    },
  });

  const region = getRegion(values.region!);
  const refresh = values.refresh!;
  const featureTypes = values.type!.split(',').map((id) => getFeatureType(id.trim()));

  console.log(`Building ${region.label}: ${featureTypes.map((t) => t.label).join(', ')}`);

  const boundary = await boundaryOf(region, refresh);
  const boundaryBbox = bboxUnion(
    boundary.outer.map((ring) => [
      Math.min(...ring.map((p) => p[0])),
      Math.min(...ring.map((p) => p[1])),
      Math.max(...ring.map((p) => p[0])),
      Math.max(...ring.map((p) => p[1])),
    ]),
  );
  console.log(`  boundary: ${boundary.outer.length} outer ring(s), ${boundary.inner.length} inner`);

  const subregions = await fetchSubregions(region, refresh);
  console.log(`  sub-regions: ${subregions.length} at admin_level=${region.subregionAdminLevel}`);

  const groups = [];
  for (const featureType of featureTypes) {
    groups.push(await buildGroup(region, featureType, subregions, boundaryBbox, refresh));
  }

  await writeJson(`quizzes-${region.id}.json`, {
    region: region.id,
    regionLabel: region.label,
    generatedAt: new Date().toISOString().slice(0, 10),
    attribution: '© OpenStreetMap contributors (ODbL)',
    groups,
  });

  const context = await buildContext(region, boundary, refresh);
  await writeJson(`context-${region.id}.geojson`, context);
  console.log(`\n  context: ${context.features.length} water features`);
}

/** Zones that drifted outside the sizing target are worth knowing about. */
function warnOnOutliers(zones: Zone[]) {
  const odd = zones.filter(
    (z) => z.questionCount < ZONE_LIMITS.min || z.questionCount > ZONE_LIMITS.max,
  );
  if (odd.length > 0) {
    console.log(
      `      note: ${odd.length} zone(s) outside ${ZONE_LIMITS.min}-${ZONE_LIMITS.max}: ` +
        odd.map((z) => `${z.label} (${z.questionCount})`).join(', '),
    );
  }
}

await main();
