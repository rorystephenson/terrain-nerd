/**
 * Turns the extracted pool into what the browser loads.
 *
 * Reads only `cache/osm/` — never the network — so changing how features are
 * processed costs nothing to re-run. The one exception is Wikidata sitelinks,
 * which are themselves cached and resumable.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { COVERAGE } from './extract.ts';
import {
  classify,
  isFlyingSite,
  kindList,
  placeRankOf,
  PLACE_RANKS,
  type KindId,
} from './featureTypes.ts';
import { bboxOf, lineLengthKm, type BBox, type LonLat } from './geo.ts';
import { cellsCovering } from './grid.ts';
import { scorePool } from './importance.ts';
import { normalize, type QuizFeature } from './normalize.ts';
import { OUT_DIR } from './paths.ts';
import { readLayer, type RawElement, type RawGeometry } from './source.ts';
import { simplify } from './simplify.ts';

/**
 * Ship cells are ~55 km square, so a builder viewport usually touches one to
 * four of them.
 */
const SHIP_CELL = 0.5;

/** Rivers are drawn as thin lines; half a pixel of fidelity is not worth the bytes. */
const RIVER_TOLERANCE_KM = 0.05;
/** Shorelines are read as shapes, so they get five times the fidelity of a river. */
const SHORE_TOLERANCE_KM = 0.01;
const MIN_LAKE_SPAN_KM = 0.3;

/** Roads are drawn thin; 30 m of fidelity is past what the line can show. */
const ROAD_TOLERANCE_KM = 0.03;
/** Below this a glacier is a snow patch, not a landmark worth the bytes. */
const MIN_GLACIER_SPAN_KM = 0.25;

/**
 * Rounds every number to 5 decimal places (~1m) on the way out. OSM carries 7,
 * which triples the size of river geometry for precision no quiz map can render.
 */
const roundNumbers = (_key: string, value: unknown) =>
  typeof value === 'number' ? Math.round(value * 1e5) / 1e5 : value;

async function writeJson(file: string, data: unknown) {
  const path = join(OUT_DIR, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, roundNumbers)}\n`);
}

/**
 * Buckets features into ship cells.
 *
 * A feature goes into *every* cell its bbox touches, not just the one holding
 * its anchor. Otherwise a long valley would vanish the moment you looked at the
 * neighbouring cell without loading the one its midpoint happens to sit in.
 * The app dedupes by id on the way back in.
 */
function bucketByCell<T extends { bbox: BBox }>(features: T[]): Map<string, T[]> {
  const cells = new Map<string, T[]>();
  for (const feature of features) {
    for (const key of cellsCovering(feature.bbox, SHIP_CELL)) {
      const bucket = cells.get(key);
      if (bucket) bucket.push(feature);
      else cells.set(key, [feature]);
    }
  }
  return cells;
}

/**
 * Buckets context features by the cells their geometry actually crosses.
 *
 * `bucketByCell` works off the bounding box, which is right for a compact quiz
 * feature but disastrous for roads: a long diagonal road has an enormous bbox
 * and would be copied into every cell of that rectangle, most of which it never
 * enters. Walking segment by segment keeps a road only in the cells it really
 * passes through.
 */
function bucketByGeometry<T extends { shape: Shape }>(features: T[]): Map<string, T[]> {
  const cells = new Map<string, T[]>();
  for (const feature of features) {
    const rings: LonLat[][] =
      feature.shape.type === 'MultiPolygon'
        ? feature.shape.coordinates.flat()
        : feature.shape.coordinates;
    const keys = new Set<string>();
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [a, b] = [ring[i - 1], ring[i]];
        const segment: BBox = [
          Math.min(a[0], b[0]), Math.min(a[1], b[1]),
          Math.max(a[0], b[0]), Math.max(a[1], b[1]),
        ];
        for (const key of cellsCovering(segment, SHIP_CELL)) keys.add(key);
      }
    }
    for (const key of keys) {
      const bucket = cells.get(key);
      if (bucket) bucket.push(feature);
      else cells.set(key, [feature]);
    }
  }
  return cells;
}

async function writeChunks(
  dir: string,
  cells: Map<string, { bbox: BBox }[]>,
): Promise<Record<string, number>> {
  await rm(join(OUT_DIR, dir), { recursive: true, force: true });
  const counts: Record<string, number> = {};
  for (const [key, features] of cells) {
    await writeJson(join(dir, `${key}.geojson`), { type: 'FeatureCollection', features });
    counts[key] = features.length;
  }
  return counts;
}

async function buildTerrain() {
  const byKind = new Map<KindId, RawElement[]>();
  const places: { name: string; rank: number; at: LonLat }[] = [];
  const flying: LonLat[] = [];
  let seen = 0;

  for await (const element of readLayer('terrain')) {
    seen++;
    if (isFlyingSite(element.tags)) {
      flying.push(element.coords[0]);
      continue;
    }
    const kind = classify(element.tags);
    if (kind) {
      const bucket = byKind.get(kind);
      if (bucket) bucket.push(element);
      else byKind.set(kind, [element]);
      continue;
    }
    const rank = placeRankOf(element.tags);
    const name = element.tags.name?.trim();
    if (rank > 0 && name) places.push({ name, rank, at: element.coords[0] });
  }
  console.log(`  read ${seen.toLocaleString()} elements`);

  const features: QuizFeature[] = [];
  for (const kind of kindList) {
    const { features: made, stats } = normalize(byKind.get(kind.id) ?? [], kind);
    console.log(`  ${kind.label}: ${stats.named.toLocaleString()} named -> ${made.length.toLocaleString()} merged`);
    features.push(...made);
  }

  const popularity = await scorePool(features, flying, 'italy-sitelinks');
  for (const feature of features) {
    const score = popularity.get(feature.id);
    if (score !== undefined) feature.properties.popularity = score;
  }

  // One chunk set per kind, so a builder with peaks switched off never fetches them.
  const kinds = [];
  for (const kind of kindList) {
    const mine = features.filter((f) => f.properties.kind === kind.id);
    const cells = await writeChunks(kind.id, bucketByCell(mine));
    kinds.push({
      id: kind.id,
      label: kind.label,
      geometry: kind.geometry,
      filters: kind.filters,
      count: mine.length,
      cells,
    });
    console.log(`  ${kind.label}: ${mine.length.toLocaleString()} across ${Object.keys(cells).length} cells`);
  }

  const placeFeatures = places.map((place) => ({
    type: 'Feature' as const,
    bbox: [place.at[0], place.at[1], place.at[0], place.at[1]] as BBox,
    geometry: { type: 'Point' as const, coordinates: place.at },
    properties: { name: place.name, rank: place.rank },
  }));
  const placeCells = await writeChunks('places', bucketByCell(placeFeatures));
  console.log(`  Places: ${placeFeatures.length.toLocaleString()} across ${Object.keys(placeCells).length} cells`);

  return {
    kinds,
    places: { count: placeFeatures.length, ranks: [...PLACE_RANKS], cells: placeCells },
  };
}

type WaterFeature = {
  type: 'Feature';
  bbox: BBox;
  geometry:
    | { type: 'Polygon'; coordinates: LonLat[][] }
    | { type: 'LineString'; coordinates: LonLat[] };
  properties: { kind: 'lake' | 'river' };
};

const closeRing = (points: LonLat[]): LonLat[] => {
  const first = points[0];
  const last = points[points.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? points : [...points, first];
};

type Shape =
  | { type: 'MultiLineString'; coordinates: LonLat[][] }
  | { type: 'MultiPolygon'; coordinates: LonLat[][][] };

/**
 * Simplifies an exported geometry without destroying its structure.
 *
 * Rings are simplified individually and re-closed. A ring that collapses below
 * a triangle is dropped rather than kept as a sliver, and a polygon that loses
 * its outer ring is dropped whole — a hole with no shape around it renders as
 * a wedge across whatever is underneath.
 *
 * Everything comes back as Multi*, so features of the same kind can be
 * concatenated into one geometry per cell.
 */
function toShape(geometry: RawGeometry, toleranceKm: number): Shape | null {
  const ring = (points: LonLat[]): LonLat[] | null => {
    const line = simplify(points, toleranceKm);
    if (line.length < 3) return null;
    const closed = closeRing(line);
    return closed.length >= 4 ? closed : null;
  };
  const polygon = (rings: LonLat[][]): LonLat[][] | null => {
    const [outer, ...inner] = rings.map(ring);
    if (!outer) return null;
    return [outer, ...inner.filter((r): r is LonLat[] => r !== null)];
  };

  const c = geometry.coordinates as never;
  switch (geometry.type) {
    case 'Polygon': {
      const only = polygon(c as unknown as LonLat[][]);
      return only ? { type: 'MultiPolygon', coordinates: [only] } : null;
    }
    case 'MultiPolygon': {
      const parts = (c as unknown as LonLat[][][]).map(polygon).filter((p): p is LonLat[][] => p !== null);
      return parts.length ? { type: 'MultiPolygon', coordinates: parts } : null;
    }
    case 'LineString': {
      const line = simplify(c as unknown as LonLat[], toleranceKm);
      return line.length >= 2 ? { type: 'MultiLineString', coordinates: [line] } : null;
    }
    case 'MultiLineString': {
      const parts = (c as unknown as LonLat[][])
        .map((l) => simplify(l, toleranceKm))
        .filter((l) => l.length >= 2);
      return parts.length ? { type: 'MultiLineString', coordinates: parts } : null;
    }
    default:
      return null;
  }
}

const countVertices = (shape: Shape): number =>
  shape.type === 'MultiLineString'
    ? shape.coordinates.reduce((n, l) => n + l.length, 0)
    : shape.coordinates.flat().reduce((n, r) => n + r.length, 0);

type Drawn = { kind: string; class?: string; bbox: BBox; shape: Shape };

/**
 * Writes drawn features as one geometry per kind per cell.
 *
 * OSM splits major roads into half a million short ways, and at a couple of
 * vertices each the GeoJSON wrapper around a way costs several times more than
 * its coordinates. Concatenating them collapses the shipped size fourfold.
 */
async function writeDrawn(dir: string, items: Drawn[]): Promise<Record<string, number>> {
  await rm(join(OUT_DIR, dir), { recursive: true, force: true });
  const counts: Record<string, number> = {};

  for (const [cell, bucket] of bucketByGeometry(items)) {
    const groups = new Map<string, Drawn[]>();
    for (const item of bucket) {
      // Keyed on the geometry type too: a group is written as one Multi*, so
      // mixing lines and polygons would emit one of them with the other's
      // nesting, which renders as garbage strung across the map.
      const key = `${item.kind}|${item.class ?? ''}|${item.shape.type}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
    const features = [...groups.values()].map((group) => ({
      type: 'Feature' as const,
      geometry:
        group[0].shape.type === 'MultiPolygon'
          ? {
              type: 'MultiPolygon' as const,
              coordinates: group.flatMap((i) => (i.shape as { coordinates: LonLat[][][] }).coordinates),
            }
          : {
              type: 'MultiLineString' as const,
              coordinates: group.flatMap((i) => (i.shape as { coordinates: LonLat[][] }).coordinates),
            },
      properties: { kind: group[0].kind, ...(group[0].class ? { class: group[0].class } : {}) },
    }));
    await writeJson(join(dir, `${cell}.geojson`), { type: 'FeatureCollection', features });
    counts[cell] = bucket.length;
  }
  return counts;
}

/**
 * Lakes and rivers, unlabeled, purely for orientation.
 *
 * Lakes are shapes and rivers are lines, so they get different tolerances: a
 * shoreline read as a silhouette shows every corner cut, while a river drawn
 * one pixel wide does not.
 */
async function buildWater() {
  const items: Drawn[] = [];
  let vertices = 0;
  let kept = 0;
  let lakes = 0;
  let rivers = 0;

  for await (const element of readLayer('water')) {
    if (element.coords.length < 2) continue;
    // Same trap as glaciers: the member ways of a water relation arrive
    // untagged, and would otherwise be drawn as rivers along every shoreline.
    if (element.tags.natural !== 'water' && !element.tags.waterway) continue;
    const bbox = bboxOf(element.coords);
    const isLake = element.closed || element.tags.natural === 'water';

    if (isLake) {
      const spanKm = lineLengthKm([
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ]);
      if (spanKm < MIN_LAKE_SPAN_KM) continue;
    }

    // A `natural=water` way that is not itself closed is one arc of a
    // multipolygon relation. Closing it on its own would fill a wedge across
    // open water, so it is drawn as a shoreline rather than forced into a shape.
    const shape = toShape(element.geometry, isLake ? SHORE_TOLERANCE_KM : RIVER_TOLERANCE_KM);
    if (!shape) continue;

    vertices += element.coords.length;
    kept += countVertices(shape);
    const filled = shape.type === 'MultiPolygon';
    if (filled) lakes++;
    else rivers++;

    items.push({ kind: filled ? 'lake' : 'river', bbox, shape });
  }

  const cells = await writeDrawn('water', items);
  console.log(
    `  Water: ${lakes.toLocaleString()} lakes + ${rivers.toLocaleString()} waterways ` +
      `across ${Object.keys(cells).length} cells ` +
      `(${vertices.toLocaleString()} vertices -> ${kept.toLocaleString()})`,
  );
  return { count: items.length, cells };
}

/**
 * Roads and glaciers: the rest of what the basemap draws.
 *
 * Shaded relief alone leaves you with nothing man-made to orient by, and in the
 * Alps a glacier is as recognisable a landmark as any peak. Neither is ever a
 * quiz answer, so neither is named.
 */
async function buildContext() {
  const items: Drawn[] = [];
  let vertices = 0;
  let kept = 0;
  let roads = 0;
  let glaciers = 0;

  for await (const element of readLayer('context')) {
    if (element.coords.length < 2) continue;
    const isGlacier = element.tags.natural === 'glacier';
    // Filtering for glacier *relations* makes osmium emit their member ways
    // too, untagged. Classifying by elimination turned those into roads, which
    // drew white lines along every glacier outline and across the ice.
    if (!isGlacier && !element.tags.highway) continue;
    const bbox = bboxOf(element.coords);

    if (isGlacier) {
      const spanKm = lineLengthKm([
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ]);
      if (spanKm < MIN_GLACIER_SPAN_KM) continue;
    }

    const shape = toShape(element.geometry, isGlacier ? SHORE_TOLERANCE_KM : ROAD_TOLERANCE_KM);
    if (!shape) continue;
    // An unclosed glacier arc is half a relation; drawing it as a line would
    // put a stray stroke across the ice, so it is dropped.
    if (isGlacier && shape.type !== 'MultiPolygon') continue;

    vertices += element.coords.length;
    kept += countVertices(shape);
    if (isGlacier) glaciers++;
    else roads++;

    items.push({
      kind: isGlacier ? 'glacier' : 'road',
      class: isGlacier ? undefined : element.tags.highway?.replace(/_link$/, ''),
      bbox,
      shape,
    });
  }

  const cells = await writeDrawn('context', items);
  console.log(
    `  Context: ${roads.toLocaleString()} roads + ${glaciers.toLocaleString()} glaciers ` +
      `across ${Object.keys(cells).length} cells ` +
      `(${vertices.toLocaleString()} vertices -> ${kept.toLocaleString()})`,
  );
  return { count: items.length, cells };
}

/**
 * The water chunks already written on a previous run.
 *
 * Rebuilding them means re-reading 178 MB of river geometry for output that
 * almost never changes, so the counts are read back off disk instead. That
 * keeps `index.json` honest about what is actually there.
 */
function readExistingWater(): { count: number; cells: Record<string, number> } {
  try {
    const dir = join(OUT_DIR, 'water');
    const cells: Record<string, number> = {};
    let count = 0;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.geojson')) continue;
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        features: unknown[];
      };
      cells[file.replace(/\.geojson$/, '')] = parsed.features.length;
      count += parsed.features.length;
    }
    return { count, cells };
  } catch {
    return { count: 0, cells: {} };
  }
}

async function main() {
  const { values } = parseArgs({
    options: { 'skip-water': { type: 'boolean', default: false } },
  });

  console.log('Processing extracted pool:');
  const terrain = await buildTerrain();
  const context = await buildContext();
  // Water is the slowest layer by far; `--skip-water` reuses what is on disk.
  const water = values['skip-water'] ? readExistingWater() : await buildWater();

  await writeJson('index.json', {
    generatedAt: new Date().toISOString().slice(0, 10),
    attribution: '© OpenStreetMap contributors (ODbL)',
    area: COVERAGE,
    cellSize: SHIP_CELL,
    ...terrain,
    context,
    water,
  });
  console.log('\n  wrote index.json');
}

/** Only run the CLI when invoked directly — this module is imported for its constants too. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
