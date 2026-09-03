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

import { readOcean } from './coastline.ts';
import { coverageRects, readCoverage } from './coverage.ts';
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
import {
  assignZoomRanges,
  LABEL_BOX,
  MAX_LABEL_ZOOM,
  MIN_LABEL_ZOOM,
  parsePopulation,
  type PlaceInput,
} from './placeZoom.ts';
import { readLayer, type RawElement, type RawGeometry } from './source.ts';
import { simplify } from './simplify.ts';
import { stitch } from './stitch.ts';
import { buildTiles, type TileFeature } from './tiles.ts';

/**
 * Ship cells are z9 tiles — 54 km square, so a builder viewport usually touches
 * one to four of them. A tile rather than a span in degrees so that cells are
 * square at every latitude and nest inside the coverage grid and the vector
 * tiles; see `mercator.ts`.
 */
const CHUNK_ZOOM = 9;

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
    for (const key of cellsCovering(feature.bbox, CHUNK_ZOOM)) {
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

/** Compact "z10:4 z11:57 z12:903" tally, so a re-run shows the thinning at a glance. */
function histogram(values: number[]): string {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([zoom, count]) => `z${zoom}:${count.toLocaleString()}`)
    .join(' ');
}

async function buildTerrain() {
  const byKind = new Map<KindId, RawElement[]>();
  const places: PlaceInput[] = [];
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
    if (rank > 0 && name) {
      places.push({
        key: element.id,
        name,
        rank,
        population: parsePopulation(element.tags.population),
        at: element.coords[0],
      });
    }
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

  // Which names may be drawn at which zooms, decided once for the whole country
  // so the browser never has to decide it from a viewport. See `placeZoom.ts`.
  const zooms = assignZoomRanges(places);
  const placeFeatures = places.map((place) => ({
    type: 'Feature' as const,
    bbox: [place.at[0], place.at[1], place.at[0], place.at[1]] as BBox,
    geometry: { type: 'Point' as const, coordinates: place.at },
    properties: {
      name: place.name,
      // Still shipped: it is what the renderer sizes and weights a name by.
      rank: place.rank,
      minzoom: zooms.min.get(place.key) ?? MAX_LABEL_ZOOM,
      // Omitted for the majority, which never hand over. Absent means forever.
      ...(zooms.max.has(place.key) ? { maxzoom: zooms.max.get(place.key) } : {}),
    },
  }));
  const placeCells = await writeChunks('places', bucketByCell(placeFeatures));
  console.log(`  Places: ${placeFeatures.length.toLocaleString()} across ${Object.keys(placeCells).length} cells`);
  console.log(`    first drawn at zoom: ${histogram(placeFeatures.map((p) => p.properties.minzoom))}`);
  console.log(`    hand over to finer names: ${zooms.max.size.toLocaleString()}`);

  return {
    kinds,
    places: {
      count: placeFeatures.length,
      ranks: [...PLACE_RANKS],
      cells: placeCells,
      // Lets the app tell thinned data from a pool built before this existed,
      // and makes a label-model mismatch visible rather than silent.
      thinned: true,
      zoomRange: [MIN_LABEL_ZOOM, MAX_LABEL_ZOOM],
      labelBox: LABEL_BOX,
    },
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
 * The line parts of a geometry, unsimplified and unflattened.
 *
 * `element.coords` will not do here: it is every coordinate in order with the
 * part boundaries lost, so a relation of three separate arcs would arrive as
 * one line and stitch into a road running between things that never touch.
 */
function linesOf(geometry: RawGeometry): LonLat[][] {
  if (geometry.type === 'LineString') return [geometry.coordinates as unknown as LonLat[]];
  if (geometry.type === 'MultiLineString') return geometry.coordinates as unknown as LonLat[][];
  return [];
}

/**
 * Stitches raw lines into chains, simplifies each, and emits them.
 *
 * Simplification has to come *after* the join: Douglas-Peucker cannot drop
 * below the two points an OSM fragment is made of, so simplifying first leaves
 * a road layer that barely shrinks however coarse the tolerance. See
 * `stitch.ts` — it is worth 3.6x on secondary roads.
 */
function drawnLines(
  raw: Map<string, LonLat[][]>,
  kind: string,
  toleranceKm: number,
): { items: Drawn[]; kept: number } {
  const items: Drawn[] = [];
  let kept = 0;
  for (const [cls, lines] of raw) {
    for (const chain of stitch(lines)) {
      const line = simplify(chain, toleranceKm);
      if (line.length < 2) continue;
      kept += line.length;
      items.push({
        kind,
        class: cls || undefined,
        bbox: bboxOf(line),
        shape: { type: 'MultiLineString', coordinates: [line] },
      });
    }
  }
  return { items, kept };
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
  /** Raw waterway lines, held unsimplified so they can be stitched first. */
  const raw = new Map<string, LonLat[][]>();
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

    vertices += element.coords.length;

    // A `natural=water` way that is not itself closed is one arc of a
    // multipolygon relation. Closing it on its own would fill a wedge across
    // open water, so it is drawn as a shoreline rather than forced into a shape.
    const shape = toShape(element.geometry, isLake ? SHORE_TOLERANCE_KM : RIVER_TOLERANCE_KM);
    if (shape?.type === 'MultiPolygon') {
      kept += countVertices(shape);
      lakes++;
      items.push({ kind: 'lake', bbox, shape });
      continue;
    }

    const parts = linesOf(element.geometry);
    if (parts.length === 0) continue;
    rivers++;
    const held = raw.get('');
    if (held) held.push(...parts);
    else raw.set('', [...parts]);
  }

  /*
   * The sea, from the prebuilt coastline polygons. Drawn with the lakes and for
   * the same reason: a sea surface is flat, so it sits above the hillshade
   * rather than taking its shading. Without it the Mediterranean renders as the
   * pale bottom of the elevation ramp — the same colour as a valley floor, with
   * submarine relief showing through it.
   */
  const coverage = readCoverage();
  let ocean = 0;
  for (const piece of await readOcean(coverage ? coverageRects(coverage) : [COVERAGE])) {
    const shape = toShape(
      { type: 'MultiPolygon', coordinates: piece.rings as unknown as never },
      SHORE_TOLERANCE_KM,
    );
    if (!shape || shape.type !== 'MultiPolygon') continue;
    vertices += piece.rings.flat(2).length;
    kept += countVertices(shape);
    ocean++;
    items.push({ kind: 'ocean', bbox: piece.bbox, shape });
  }

  const joined = drawnLines(raw, 'river', RIVER_TOLERANCE_KM);
  // Appended one at a time: spreading a few hundred thousand arguments into
  // `push` overflows the stack.
  for (const item of joined.items) items.push(item);
  kept += joined.kept;
  console.log(
    `    waterways: ${rivers.toLocaleString()} ways -> ${joined.items.length.toLocaleString()} stitched lines`,
  );

  for (const item of items) drawn.push(item);
  console.log(
    `  Water: ${lakes.toLocaleString()} lakes + ${rivers.toLocaleString()} waterways ` +
      `+ ${ocean.toLocaleString()} sea ` +
      `(${vertices.toLocaleString()} vertices -> ${kept.toLocaleString()})`,
  );
  return { count: items.length };
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
  /** Raw road lines by class, held unsimplified so they can be stitched first. */
  const raw = new Map<string, LonLat[][]>();
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

    vertices += element.coords.length;

    if (isGlacier) {
      const shape = toShape(element.geometry, SHORE_TOLERANCE_KM);
      // An unclosed glacier arc is half a relation; drawing it as a line would
      // put a stray stroke across the ice, so it is dropped.
      if (!shape || shape.type !== 'MultiPolygon') continue;
      kept += countVertices(shape);
      glaciers++;
      items.push({ kind: 'glacier', bbox, shape });
      continue;
    }

    const cls = element.tags.highway?.replace(/_link$/, '') ?? '';
    const parts = linesOf(element.geometry);
    if (parts.length === 0) {
      // A road mapped as an area — a pedestrian square. Nothing to join it to.
      const shape = toShape(element.geometry, ROAD_TOLERANCE_KM);
      if (!shape) continue;
      kept += countVertices(shape);
      roads++;
      items.push({ kind: 'road', class: cls || undefined, bbox, shape });
      continue;
    }
    roads++;
    const held = raw.get(cls);
    if (held) held.push(...parts);
    else raw.set(cls, [...parts]);
  }

  const joined = drawnLines(raw, 'road', ROAD_TOLERANCE_KM);
  // Appended one at a time: spreading a few hundred thousand arguments into
  // `push` overflows the stack.
  for (const item of joined.items) items.push(item);
  kept += joined.kept;
  console.log(
    `    roads: ${roads.toLocaleString()} ways -> ${joined.items.length.toLocaleString()} stitched lines`,
  );

  // Straight to the tile build: roads and glaciers are drawn and never asked
  // about, so nothing needs them as addressable features any more.
  for (const item of items) drawn.push(item);
  console.log(
    `  Context: ${roads.toLocaleString()} roads + ${glaciers.toLocaleString()} glaciers ` +
      `(${vertices.toLocaleString()} vertices -> ${kept.toLocaleString()})`,
  );
  return { count: items.length };
}

/** Everything the basemap draws, gathered for the tile build. */
const drawn: TileFeature[] = [];

async function main() {
  const { values } = parseArgs({
    options: {
      'skip-water': { type: 'boolean', default: false },
      'skip-context': { type: 'boolean', default: false },
    },
  });

  console.log('Processing extracted pool:');
  const terrain = await buildTerrain();
  // Roads and glaciers change even less often than the terrain does, and tuning
  // how place names are thinned means re-running this repeatedly.
  const context = values['skip-context'] ? { count: 0 } : await buildContext();
  // Water is the slowest layer by far.
  const water = values['skip-water'] ? { count: 0 } : await buildWater();

  /*
   * Tiles come last, from everything the two layers drew. Skipping either layer
   * would tile only half the basemap, so the archive is only rebuilt when both
   * have actually run.
   */
  if (!values['skip-context'] && !values['skip-water']) {
    const bytes = await buildTiles(drawn);
    console.log(`  Tiles: ${(bytes / 1048576).toFixed(1)} MB from ${drawn.length.toLocaleString()} features`);
  } else {
    console.log('  Tiles: skipped (needs both context and water)');
  }

  await writeJson('index.json', {
    generatedAt: new Date().toISOString().slice(0, 10),
    attribution: '© OpenStreetMap contributors (ODbL)',
    area: COVERAGE,
    chunkZoom: CHUNK_ZOOM,
    ...terrain,
    // The basemap furniture is a tileset now rather than addressable chunks, so
    // there is no cell list here for the client to look anything up in.
    basemap: { tiles: 'data/context.pmtiles', drawn: context.count + water.count },
  });
  console.log('\n  wrote index.json');
}

/** Only run the CLI when invoked directly — this module is imported for its constants too. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
