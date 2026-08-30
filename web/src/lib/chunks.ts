/**
 * Loads the pool a cell at a time.
 *
 * The pool is the whole of Italy — around 38k peaks, 66k settlements and 40k
 * water features — so nothing loads it whole. Everything here works from a
 * bbox: work out which cells it touches, fetch the ones not already held, and
 * cache them for the session.
 */
import { boxesOverlap, cellsCovering, geometryIntersectsBox, pointInBox } from './grid.ts';
import type {
  ContextCollection,
  KindId,
  PlaceFeature,
  PoolIndex,
  QuizFeature,
} from './types.ts';

const BASE = 'data';

/** Parsed cells, keyed `<dir>/<cell>`, kept for the life of the page. */
const cells = new Map<string, unknown[]>();
/** In-flight requests, so two overlapping areas never fetch the same cell twice. */
const pending = new Map<string, Promise<unknown[]>>();

export async function loadIndex(): Promise<PoolIndex> {
  const response = await fetch(`${BASE}/index.json`);
  if (!response.ok) {
    throw new Error(
      `Could not load the feature pool (${response.status}). Run: npm run extract:data && npm run build:data`,
    );
  }
  return (await response.json()) as PoolIndex;
}

async function loadCell(dir: string, cell: string): Promise<unknown[]> {
  const key = `${dir}/${cell}`;
  const held = cells.get(key);
  if (held) return held;

  const already = pending.get(key);
  if (already) return already;

  const request = fetch(`${BASE}/${dir}/${cell}.geojson`)
    .then(async (response) => {
      if (!response.ok) return [];
      const file = (await response.json()) as { features: unknown[] };
      return file.features ?? [];
    })
    // A missing or malformed cell should leave a hole in the map, not break the
    // whole area the player asked for.
    .catch(() => [] as unknown[])
    .then((features) => {
      cells.set(key, features);
      pending.delete(key);
      return features;
    });

  pending.set(key, request);
  return request;
}

/**
 * Every feature of the given kinds within `bbox`.
 *
 * Deduped by id, because a feature is written into every cell its bbox touches
 * so that a long valley never disappears when you look at a neighbouring cell.
 *
 * Then clipped to `bbox` by whether the feature actually enters it. Cells are
 * 0.5° — far larger than any area someone would build a quiz for — so returning
 * whole cells would quietly hand the builder features from up to a degree away
 * and make the chosen area meaningless.
 *
 * Intersects, not contains, and not "its midpoint is inside". A long valley
 * running through the area you picked is one of the valleys in that area, even
 * if most of its length and its midpoint lie beyond the edge — excluding it
 * would drop exactly the big through-valleys people navigate by.
 */
export async function loadArea(
  index: PoolIndex,
  bbox: [number, number, number, number],
  kinds: KindId[],
): Promise<QuizFeature[]> {
  const wanted = cellsCovering(bbox, index.cellSize);

  const batches = await Promise.all(
    kinds.flatMap((kind) => {
      const info = index.kinds.find((k) => k.id === kind);
      if (!info) return [];
      // Skip cells the index says are empty rather than 404ing on them.
      return wanted
        .filter((cell) => info.cells[cell])
        .map((cell) => loadCell(kind, cell) as Promise<QuizFeature[]>);
    }),
  );

  const byId = new Map<string, QuizFeature>();
  for (const batch of batches) {
    for (const feature of batch) {
      // bbox first: a cheap reject before the per-segment test.
      if (boxesOverlap(feature.bbox, bbox) && geometryIntersectsBox(feature.geometry, bbox)) {
        byId.set(feature.id, feature);
      }
    }
  }
  return [...byId.values()];
}

/**
 * The features a saved quiz refers to.
 *
 * Ids carry no location, so the quiz's own bbox is what says where to look —
 * and because it covers every chosen feature, the cells it touches must hold
 * them all.
 */
export async function loadByIds(
  index: PoolIndex,
  bbox: [number, number, number, number],
  ids: readonly string[],
): Promise<QuizFeature[]> {
  const kinds = [...new Set(ids.map((id) => id.split('/')[0] as KindId))];
  const found = await loadArea(index, bbox, kinds);
  const byId = new Map(found.map((feature) => [feature.id, feature]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export async function loadPlaces(
  index: PoolIndex,
  bbox: [number, number, number, number],
  maxRank: number,
): Promise<PlaceFeature[]> {
  if (maxRank <= 0) return [];
  const batches = await Promise.all(
    cellsCovering(bbox, index.cellSize)
      .filter((cell) => index.places.cells[cell])
      .map((cell) => loadCell('places', cell) as Promise<PlaceFeature[]>),
  );

  const seen = new Set<string>();
  const out: PlaceFeature[] = [];
  for (const batch of batches) {
    for (const place of batch) {
      if (place.properties.rank > maxRank) continue;
      if (!pointInBox(place.geometry.coordinates, bbox)) continue;
      // Settlements are points, so name plus position is a sound identity.
      const key = `${place.properties.name}@${place.geometry.coordinates.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(place);
    }
  }
  return out;
}

/**
 * Everything the basemap draws that is not computed from elevation: roads,
 * glaciers, lakes and rivers.
 *
 * Two directories, one collection, because they are all drawn from the same
 * source and told apart by their `kind`. A feature is written into every cell
 * its geometry crosses, so one spanning a seam arrives twice — harmless here,
 * since nothing is keyed by identity.
 */
export async function loadContext(
  index: PoolIndex,
  bbox: [number, number, number, number],
): Promise<ContextCollection> {
  const wanted = cellsCovering(bbox, index.cellSize);
  const batches = await Promise.all(
    (['context', 'water'] as const).flatMap((dir) =>
      wanted
        .filter((cell) => index[dir]?.cells[cell])
        .map((cell) => loadCell(dir, cell) as Promise<ContextCollection['features']>),
    ),
  );
  return { type: 'FeatureCollection', features: batches.flat() };
}
