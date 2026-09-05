/**
 * Loads the pool a cell at a time.
 *
 * The pool is the whole of Italy — around 38k peaks, 66k settlements and 40k
 * water features — so nothing loads it whole. Everything here works from a
 * bbox: work out which cells it touches, fetch the ones not already held, and
 * cache them for the session.
 */
import { boxesOverlap, cellsCovering, geometryIntersectsBox, pointInBox } from './grid.ts';
import { visibleAtZoom } from './places.ts';
import type {
  FeatureRef,
  KindId,
  PlaceFeature,
  PoolIndex,
  QuizFeature,
} from './types.ts';

/**
 * Where the pool lives, as an **absolute** URL.
 *
 * It was `'data'`, relative, which worked for exactly as long as the app only
 * ever sat at `/`. On a share link at `/q/abc` it resolves to `/q/data/...`,
 * and `loadCell` swallows a failed fetch into an empty list — so a shared quiz
 * would have opened silently empty rather than failing. A relative base is a
 * bug that waits for a router.
 *
 * `VITE_DATA_BASE` is the same arrangement `VITE_TILE_BASE` already uses in
 * `mapStyle.ts`, so the ~39 MB pool can move to R2 beside the tiles — where
 * egress is free — without touching this file again. Optional-chained because
 * `node --test` is not Vite.
 */
const BASE = import.meta.env?.VITE_DATA_BASE ?? '/data';

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
  const index = (await response.json()) as PoolIndex;
  if (!index.places.thinned) {
    console.warn(
      'Place names in this pool carry no zoom range, so they are drawn by rank alone ' +
        'and will overlap when zoomed in. Re-run: npm run build:data -- --skip-water --skip-context',
    );
  }
  return index;
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
  const wanted = cellsCovering(bbox, index.chunkZoom);

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

/** What a quiz asked for, and what the pool actually had. */
export type Resolution = { features: QuizFeature[]; missing: FeatureRef[] };

/**
 * The features a saved quiz refers to.
 *
 * Refs carry no location precise enough to fetch by, so the quiz's own bbox is
 * what says where to look — and because it covers every chosen feature, the
 * cells it touches must hold them all.
 *
 * Reports what it could not find rather than returning a shorter list. This
 * used to be `ids.flatMap((id) => byId.get(id) ?? [])`, which turned a broken
 * reference into a quiz with fewer questions and nothing said about it — a
 * score that still read as a percentage and quietly meant something else.
 *
 * Nothing here tries to *repair* a broken reference. Ids do not move without
 * the pipeline stopping to say so — see `pipeline/src/ids.ts` — so a reference
 * that fails here means the feature is genuinely gone, and the honest thing is
 * to name it.
 */
export async function loadRefs(
  index: PoolIndex,
  bbox: [number, number, number, number],
  refs: readonly FeatureRef[],
): Promise<Resolution> {
  const kinds = [...new Set(refs.map((ref) => ref.kind))];
  const found = await loadArea(index, bbox, kinds);
  const byId = new Map(found.map((feature) => [feature.id, feature]));

  const features: QuizFeature[] = [];
  const missing: FeatureRef[] = [];
  for (const ref of refs) {
    const hit = byId.get(ref.id);
    if (hit) features.push(hit);
    else missing.push(ref);
  }
  return { features, missing };
}

/**
 * The settlements worth drawing over this ground at this zoom.
 *
 * The zoom cut is a property of each name, decided offline — see `places.ts` —
 * so which names come back depends on the scale and the ground, never on where
 * the viewport happens to sit within that ground.
 */
export async function loadPlaces(
  index: PoolIndex,
  bbox: [number, number, number, number],
  zoom: number,
): Promise<PlaceFeature[]> {
  const batches = await Promise.all(
    cellsCovering(bbox, index.chunkZoom)
      .filter((cell) => index.places.cells[cell])
      .map((cell) => loadCell('places', cell) as Promise<PlaceFeature[]>),
  );

  const seen = new Set<string>();
  const out: PlaceFeature[] = [];
  for (const batch of batches) {
    for (const place of batch) {
      if (!visibleAtZoom(place, zoom)) continue;
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

