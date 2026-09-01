/**
 * Decides, once and for the whole country, the zooms over which each settlement
 * name may be drawn.
 *
 * The renderer used to choose per frame: a greedy screen-space collision pass
 * over whatever the viewport had loaded. That cannot be stable. The pass is
 * global and order-dependent, so a candidate arriving at the edge of the fetched
 * box could evict a name drawn in the middle of the screen, and every zoom
 * change moved all the pixel distances at once and reshuffled whole clusters.
 *
 * So the choice moves here, where there is no viewport to depend on. Each place
 * comes out with a `[minzoom, maxzoom)` interval, and the renderer's whole job
 * becomes `minzoom <= zoom < maxzoom` — a pure function of one feature and one
 * number, with no ordering, no eviction and nothing to cascade. This is what
 * vector tile pipelines do (tippecanoe's label grid, OpenMapTiles' `rank`).
 *
 * Pure: no I/O, no Node built-ins. `web/src/lib/placeZoom.test.ts` imports it
 * across the workspace boundary to check it measures the same ink the renderer
 * draws.
 */
import { haversineKm, type LonLat } from './geo.ts';
import { buildIndex } from './spatial.ts';

export type PlaceInput = {
  /** OSM id. The final tiebreak, so it must be globally unique and stable. */
  key: string;
  name: string;
  /** 1..4, city to hamlet. */
  rank: number;
  /** 0 when untagged. */
  population: number;
  at: LonLat;
};

/** MapLibre's transform is built on 512px tiles; `map.project` follows from it. */
export const TILE_SIZE = 512;
export const MIN_LABEL_ZOOM = 0;
/** Must match `MAX_ZOOM` in web/src/lib/MapView.svelte: nothing is validated past it. */
export const MAX_LABEL_ZOOM = 14;

/**
 * The ink a name puts on the screen. Must match `web/src/lib/labels.ts`, or this
 * pass is measuring different rectangles from the ones that get drawn.
 *
 * Pinned by web/src/lib/placeZoom.test.ts, which deep-equals both halves.
 */
export const LABEL_BOX = { charWidth: 7.2, padding: 14, height: 20, gap: 4 } as const;

/**
 * Per-rank size, from the font sizes in `styles.css`: 0.95rem for a city down to
 * 0.7rem for a hamlet, against the 0.74rem base the flat `charWidth` was fitted
 * to. One width for all four ranks under-measured city names by a quarter.
 */
export const RANK_SCALE = [1.28, 1.14, 1.0, 0.95] as const;

export const scaleForRank = (rank: number): number => RANK_SCALE[rank - 1] ?? 1;

export type Rect = { x1: number; y1: number; x2: number; y2: number };

export const worldSizeAt = (zoom: number): number => TILE_SIZE * 2 ** zoom;

const MERCATOR_LIMIT = 85.051129;
const clamp = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);

export const worldX = (lon: number, worldSize: number): number =>
  ((lon + 180) / 360) * worldSize;

export const worldY = (lat: number, worldSize: number): number => {
  const phi = (clamp(lat, -MERCATOR_LIMIT, MERCATOR_LIMIT) * Math.PI) / 180;
  return (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * worldSize;
};

/**
 * The box a name occupies, plus the clearance it demands of its neighbours.
 *
 * Both boxes in a comparison carry the gap, so the clearance actually asked for
 * between two names is twice it — which is what the renderer's collision pass
 * used to do, and what this replaces.
 *
 * Both coordinates are linear in `worldSize`, and `worldSize` doubles per zoom
 * while the box does not. That is the whole argument for why this is stable:
 * two boxes that clear each other at one zoom clear each other, on both axes,
 * at every zoom above it. So a set validated at an integer zoom stays valid
 * through the fractional zooms above it, and nothing has to be recomputed.
 */
export function boxAt(place: PlaceInput, worldSize: number): Rect {
  const { charWidth, padding, height, gap } = LABEL_BOX;
  const scale = scaleForRank(place.rank);
  const halfWidth = (place.name.length * charWidth * scale + padding) / 2 + gap;
  const x = worldX(place.at[0], worldSize);
  const y = worldY(place.at[1], worldSize);
  // Markers anchor bottom-centre: the name hangs above its point.
  return { x1: x - halfWidth, y1: y - height * scale - gap, x2: x + halfWidth, y2: y + gap };
}

const distanceKm = (a: LonLat, b: LonLat): number => haversineKm(a, b);

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

/**
 * How mappers actually write `population`: `"3.404"` with an Italian thousands
 * dot, `"15 932"` with a thin space, `"17 abitanti"`. Stripping non-digits reads
 * all three correctly, and reads prose as nothing.
 */
export function parsePopulation(raw: string | undefined): number {
  if (!raw) return 0;
  const digits = raw.replace(/\D/g, '');
  const value = digits ? Number(digits) : 0;
  return Number.isFinite(value) && value > 0 && value < 50e6 ? value : 0;
}

/**
 * Strongest first: tier, then size, then a stable key.
 *
 * The tier is hard — a town always outranks a village — because `place=*` is set
 * by mappers who are themselves encoding local significance, and blending it
 * into a score would let an 8,000-person village outrank a 900-person town.
 * Population then separates within the tier, and covers all the cities, 99% of
 * towns and 62% of villages, which is exactly where it decides the most.
 *
 * The key is what makes the whole pass reproducible: without a total order the
 * answer would depend on the order the extract happened to be read in.
 *
 * Wikidata sitelinks (`importance.ts` already fetches and caches them) would work
 * here verbatim, and are the escape hatch if hamlet selection ever reads badly.
 * They are not used because an Italian frazione has 0 or 1 of them — no
 * discriminating power exactly where the ties are — for 20 minutes of requests.
 */
export const compareImportance = (a: PlaceInput, b: PlaceInput): number =>
  a.rank - b.rank ||
  b.population - a.population ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** A population for the untagged, so every place has a territory. */
const RANK_FLOOR = [40000, 6000, 800, 80];
/** People per km² across an Italian settlement's built-up core. */
const CORE_DENSITY = 2500;

/**
 * The radius of the ground a name speaks for, in km.
 *
 * Used only by the retirement rule. A name should give way once you are looking
 * at less ground than the thing it names, and a settlement's own extent is the
 * only honest measure of that.
 */
export function territoryKm(place: PlaceInput): number {
  const people = Math.max(place.population, RANK_FLOOR[place.rank - 1] ?? 80);
  return clamp(Math.sqrt(people / (Math.PI * CORE_DENSITY)), 0.25, 8);
}

/** Finer names inside a place's territory before it hands over to them. */
const TAKEOVER = 3;

/**
 * How close the nearest of those has to be, in pixels, at the zoom the handover
 * happens.
 *
 * Without this the three names only have to be somewhere inside the territory,
 * which at the handover zoom is half a thousand pixels across — wider than a
 * phone. Trento could lose its name to frazioni that were all off the side of
 * the screen, leaving nothing at all drawn. This makes the handover local: the
 * name that replaces it is where the old one was, on any window.
 */
const HANDOVER_PX = 350;

/**
 * How wide a settlement must be drawn, in pixels, before its own name is one
 * word sitting on one arbitrary street of it.
 *
 * The takeover count alone retires names far too early: three frazioni are drawn
 * around Trento by z11, when the screen still shows twenty kilometres and
 * "Trento" is still the most useful word on it. This is the other half of the
 * test — the map has to actually be inside the place — and roughly a screen's
 * width is where being inside it starts.
 */
const TERRITORY_SPAN_PX = 900;

/** The equator in metres, for turning a radius on the ground into pixels. */
const EARTH_CIRCUMFERENCE_M = 40075016.686;

const metresPerPixel = (lat: number, worldSize: number): number =>
  (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / worldSize;

/**
 * The first zoom at which the map is looking at less ground than this name
 * covers, so the name could reasonably hand over.
 *
 * A function of the place alone, which is what keeps retirement as viewport-free
 * as everything else here: no canvas size enters it, only the scale.
 */
export function scaleRetireZoom(place: PlaceInput): number {
  const radiusM = territoryKm(place) * 1000;
  for (let zoom = MIN_LABEL_ZOOM; zoom <= MAX_LABEL_ZOOM; zoom++) {
    if (2 * (radiusM / metresPerPixel(place.at[1], worldSizeAt(zoom))) >= TERRITORY_SPAN_PX) {
      return zoom;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** Uniform bucket grid over world pixels, for "does this box hit anything". */
function pixelGrid(cell: number) {
  const buckets = new Map<string, Rect[]>();
  const walk = (rect: Rect, visit: (key: string) => void) => {
    for (let ix = Math.floor(rect.x1 / cell); ix <= Math.floor(rect.x2 / cell); ix++) {
      for (let iy = Math.floor(rect.y1 / cell); iy <= Math.floor(rect.y2 / cell); iy++) {
        visit(`${ix}:${iy}`);
      }
    }
  };
  return {
    insert(rect: Rect) {
      walk(rect, (key) => {
        const bucket = buckets.get(key);
        if (bucket) bucket.push(rect);
        else buckets.set(key, [rect]);
      });
    },
    hits(rect: Rect): boolean {
      let clash = false;
      walk(rect, (key) => {
        if (clash) return;
        for (const other of buckets.get(key) ?? []) {
          if (overlaps(rect, other)) {
            clash = true;
            return;
          }
        }
      });
      return clash;
    },
  };
}

/** Sized so no label ever spans more than two cells across. */
function cellFor(places: readonly PlaceInput[]): number {
  let widest = 64;
  for (const place of places) {
    const width =
      place.name.length * LABEL_BOX.charWidth * scaleForRank(place.rank) +
      LABEL_BOX.padding +
      2 * LABEL_BOX.gap;
    if (width > widest) widest = width;
  }
  return 2 ** Math.ceil(Math.log2(widest));
}

export type ZoomRanges = {
  /** The zoom each name first appears at. Every input gets one. */
  min: Map<string, number>;
  /** The zoom a name hands over at, for the minority that ever do. */
  max: Map<string, number>;
};

/**
 * Assign every place the zooms it may be named at.
 *
 * One pass, zooms ascending, and at each zoom two steps:
 *
 * 1. **Retire.** A name hands over when both halves of "you have gone past it"
 *    are true: the map is drawing its ground wider than a screen
 *    (`TERRITORY_SPAN_PX`), so you are inside Trento rather than looking at it,
 *    *and* `TAKEOVER` finer names inside that ground are already drawn with the
 *    nearest of them within `HANDOVER_PX`, so what it hands over to is both
 *    there and where the old name was. Once, and never back on the way in. The
 *    count reads only acceptances from zooms strictly below this one, so there
 *    is no circularity between what retires and what the retirement makes room
 *    for. Either half alone gets it wrong: the scale test on its own would
 *    unname empty country, and the count on its own retires Trento at z12, with
 *    twenty kilometres still on screen.
 * 2. **Admit**, strongest first, into whatever space the live set leaves —
 *    including the space a retirement just freed.
 *
 * A name with fewer than `TAKEOVER` finer names inside it never retires, so an
 * isolated comune keeps its name at every zoom and no hamlet retires at all
 * (nothing is finer than a hamlet). That is the property that stops the rule
 * ever emptying a stretch of ground.
 */
export function assignZoomRanges(places: readonly PlaceInput[]): ZoomRanges {
  const order = [...places].sort(compareImportance);
  const min = new Map<string, number>();
  const max = new Map<string, number>();
  if (order.length === 0) return { min, max };

  // One radius query each, up front: the finer names standing inside this one's
  // ground. Which of them are drawn yet is then a lookup per zoom.
  const index = buildIndex(order, (place) => place.at);
  const finerNear = new Map<string, PlaceInput[]>();
  for (const place of order) {
    finerNear.set(
      place.key,
      index.within(place.at, territoryKm(place), (other) => other.rank > place.rank),
    );
  }

  const cell = cellFor(order);
  const retireFrom = new Map(order.map((place) => [place.key, scaleRetireZoom(place)]));
  let live: PlaceInput[] = [];
  let pending: PlaceInput[] = order;

  for (let zoom = MIN_LABEL_ZOOM; zoom <= MAX_LABEL_ZOOM; zoom++) {
    const worldSize = worldSizeAt(zoom);

    live = live.filter((place) => {
      if (zoom <= (min.get(place.key) ?? 0)) return true;
      if (zoom < (retireFrom.get(place.key) ?? Number.POSITIVE_INFINITY)) return true;
      const reach = (HANDOVER_PX * metresPerPixel(place.at[1], worldSize)) / 1000;
      let taken = 0;
      let nearest = Number.POSITIVE_INFINITY;
      for (const other of finerNear.get(place.key) ?? []) {
        const shown = min.get(other.key);
        if (shown === undefined || shown >= zoom) continue;
        taken++;
        nearest = Math.min(nearest, distanceKm(place.at, other.at));
      }
      if (taken < TAKEOVER || nearest > reach) return true;
      max.set(place.key, zoom);
      return false;
    });

    const grid = pixelGrid(cell);
    for (const place of live) grid.insert(boxAt(place, worldSize));

    const still: PlaceInput[] = [];
    for (const place of pending) {
      const box = boxAt(place, worldSize);
      if (grid.hits(box)) {
        still.push(place);
        continue;
      }
      grid.insert(box);
      live.push(place);
      min.set(place.key, zoom);
    }
    pending = still;
  }

  // Still crowded out at the deepest zoom the map goes to. Named there anyway:
  // a settlement the map refuses to name at all is worse than a rare overlap.
  for (const place of pending) min.set(place.key, MAX_LABEL_ZOOM);
  return { min, max };
}
