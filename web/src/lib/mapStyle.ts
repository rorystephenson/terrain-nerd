import type {
  ExpressionSpecification,
  FilterSpecification,
  StyleSpecification,
} from 'maplibre-gl';

import { DEM_MAXZOOM, ELEVATION_STOPS, TERRARIUM } from './terrain.ts';

/**
 * A feature nobody has answered yet.
 *
 * Violet because nothing else on the map is: the tint runs pale green through
 * gold and brown to grey rock, water is a desaturated blue, and every colour
 * that means something — the grade ramp, the miss, the reveal — is green,
 * amber or red. Measured against all of them, this sits at worst dE 102 from
 * anything on the basemap and dE 111 from anything the app uses to say
 * something, while holding 7:1 on its white casing and 5.9:1 on the palest
 * valley floor. The slate it replaces was only dE 30 from high rock, which is
 * why an unanswered valley faded into the top of the ramp.
 *
 * Blue was the other candidate and lost on meaning rather than numbers: these
 * features are valleys, drawn along the line a river takes, so a blue one reads
 * as water.
 */
export const UNANSWERED = '#6d28d9';

/**
 * The unanswered feature under the pointer.
 *
 * The same violet — hue held at 263 — lifted in lightness rather than washed
 * towards white: mixing with white takes the saturation out with it, and a
 * greyed-off violet reads as a feature going quiet, the opposite of what a
 * hover is saying. Saturation goes the other way, 0.70 to 0.90, so the lift
 * gains colour instead of losing it.
 *
 * Held against its resting colour it is a 2.1:1 step in luminance. That is well
 * past the point of being noticed, which is what a hover is for — it is picking
 * one line out of a screen full of them — and it still sits at 3.4:1 on its
 * white casing, over the 3:1 a shape rather than a letterform has to hold.
 * Lighter than this only buys distinctness by giving up the casing.
 *
 * Only ever seen on a feature nobody has answered: `pickAt` refuses to return
 * anything already spent, so there is no hover to light on an answered valley,
 * and the expression checks the grade first in any case.
 */
export const UNANSWERED_HOVER = '#a36ef7';

/** A feature the builder is leaving out. Grey says "not part of this". */
export const NEUTRAL = '#3f4a5a';
/** A valley clicked by mistake — "not that one". */
export const MISS = '#e0921a';
/** The answer being pointed out. */
export const REVEAL = '#d64545';
/**
 * A feature that will be in the quiz being built.
 *
 * The same violet a feature waits in while playing, and for the same reason:
 * it is the one colour on this map that means "a feature of the quiz", so the
 * teal it replaces was asking the builder to learn a second vocabulary for the
 * features it was about to hand to the player.
 */
export const PICKED = UNANSWERED;

/**
 * How an answered feature is coloured, one entry per outcome: found on the
 * first guess, on the second, on the third, and had to be shown.
 *
 * A miss is not a failure, it is a near miss, and the colour should say so:
 * green shades through yellow-green and orange to red as the tries are spent,
 * which turns the finished map into a legible picture of what you actually
 * know. Each is dark enough to read against pale valley floor and bare rock
 * alike, since the same ramp inks the answered names.
 */
const GRADE_COLORS = ['#1f9d55', '#a5a61b', '#c26a12', REVEAL];

/**
 * The ramp as interpolation stops, spread evenly across 0..1.
 *
 * Spread rather than hand-placed so they line up with the grades the quiz
 * actually produces — `misses / MAX_TRIES` — however many tries it allows. A
 * test pins that alignment, because a ramp whose stops fell between the grades
 * would only ever show blends of the colours chosen here.
 */
export const GRADE_STOPS: [number, string][] = GRADE_COLORS.map((hex, i) => [
  i / (GRADE_COLORS.length - 1),
  hex,
]);

/** Linear blend of two `#rrggbb` colours. */
function mixHex(a: string, b: string, t: number): string {
  const channel = (i: number) =>
    Math.round(
      Number.parseInt(a.slice(i, i + 2), 16) * (1 - t) +
        Number.parseInt(b.slice(i, i + 2), 16) * t,
    )
      .toString(16)
      .padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** The same ramp as the map expression, for HTML labels. */
export function gradeColor(grade: number): string {
  const g = Math.max(0, Math.min(1, grade));
  let [lowAt, lowHex] = GRADE_STOPS[0];
  for (const [at, hex] of GRADE_STOPS) {
    if (at <= g) [lowAt, lowHex] = [at, hex];
  }
  const upper = GRADE_STOPS.find(([at]) => at > g);
  if (!upper) return lowHex;
  return mixHex(lowHex, upper[1], (g - lowAt) / (upper[0] - lowAt));
}

/** The ink place names are set in. */
const LABEL_INK = '#2b3138';
/** How far the ramp is carried towards it. Every stop then clears 4:1 on white. */
const LABEL_DARKEN = 0.4;

/**
 * The same grade, for a name written straight onto the map.
 *
 * The ramp itself is picked to sit *behind* white text, so used as text on a
 * white halo its lighter end — the olive of a near miss — barely registers.
 * Carrying every stop the same distance towards the ink keeps the green-to-red
 * reading intact while making all four legible against the terrain.
 */
export function gradeLabelColor(grade: number): string {
  return mixHex(gradeColor(grade), LABEL_INK, LABEL_DARKEN);
}

export type MapMode = 'play' | 'build';

/**
 * Feature colour while playing, resolved from feature-state.
 *
 * `flash` and `miss` are transient feedback and win over everything; `answered`
 * gates the grade ramp so an untouched feature is never mistaken for a perfect
 * score (feature-state has no null test, so the boolean carries that). `hover`
 * comes last of all: it is worth saying about a feature still to be found and
 * nothing at all about one whose colour is already an answer.
 */
const playColor: ExpressionSpecification = [
  'case',
  ['boolean', ['feature-state', 'flash'], false],
  REVEAL,
  ['boolean', ['feature-state', 'miss'], false],
  MISS,
  ['boolean', ['feature-state', 'answered'], false],
  [
    'interpolate',
    ['linear'],
    ['to-number', ['feature-state', 'grade'], 0],
    ...GRADE_STOPS.flat(),
  ],
  ['boolean', ['feature-state', 'hover'], false],
  UNANSWERED_HOVER,
  UNANSWERED,
] as ExpressionSpecification;

/**
 * In the builder, colour says only one thing: is this in the quiz or not.
 *
 * No hover case, unlike playing. There the hover is the whole interaction —
 * one line has to be picked out of a screen full of identical ones — whereas
 * here the pointer already brings up the feature's name on a plate, which says
 * which one it is far more plainly than a change of lightness could.
 */
const buildColor: ExpressionSpecification = [
  'case',
  ['boolean', ['feature-state', 'included'], false],
  PICKED,
  NEUTRAL,
] as ExpressionSpecification;

/**
 * Excluded features stay visible but recede, so you can still see what you are
 * choosing *against* — and can click one to pull it back in.
 */
const buildOpacity: ExpressionSpecification = [
  'case',
  ['boolean', ['feature-state', 'included'], false],
  1,
  0.28,
] as ExpressionSpecification;

/**
 * How many casing/fill layer pairs the line features are dealt across.
 *
 * MapLibre orders by *layer*, not by feature, so a single casing layer sits
 * beneath the whole of the fill layer rather than beneath its own feature: one
 * valley's white halo is buried by the next valley's colour and the two run
 * together as one shape. Hanging a hollow edge above the fills instead only
 * moves the seam — then *both* features' edges draw over both fills, and a
 * crossing reads as a lattice rather than as one valley passing over another.
 *
 * The only ordering MapLibre will honour between a feature's casing and another
 * feature's fill is layer order, so the pair is repeated: casing 0, fill 0,
 * casing 1, fill 1, and so on. A feature in a later pair is drawn over the whole
 * of an earlier one, halo included, which is what "on top" has to mean.
 *
 * Six pairs, dealt on `idx`, is the exchange rate. Two features only flatten
 * against each other if they land in the same pair, and because `idx` follows
 * file order — which is grid-cell order, so roughly spatial — neighbours are
 * dealt into different pairs rather than clumped. Twelve line layers over a
 * source holding one round's features is a rounding error next to the two
 * hillshade passes.
 */
const STACK = 6;

/** Lines and points share one source, so each layer has to say what it is for. */
const LINE_ONLY: FilterSpecification = ['!=', ['geometry-type'], 'Point'];

/** The slice of the stack a layer draws: every sixth feature by index. */
const dealt = (pair: number): FilterSpecification =>
  ['all', LINE_ONLY, ['==', ['%', ['coalesce', ['get', 'idx'], 0], STACK], pair]] as FilterSpecification;

/** Casing layer ids, bottom pair first. */
export const CASING_LAYERS = Array.from({ length: STACK }, (_, i) => `features-casing-${i}`);
/** Fill layer ids, bottom pair first. These are what a click is tested against. */
export const LINE_LAYERS = Array.from({ length: STACK }, (_, i) => `features-line-${i}`);

/**
 * Which features each feature layer is allowed to draw.
 *
 * A circle layer renders one circle per *vertex*, so without this the peak layer
 * speckles every valley line with dots at its segment joins.
 */
export const LAYER_GEOMETRY: Record<string, FilterSpecification> = {
  ...Object.fromEntries(CASING_LAYERS.map((id, i) => [id, dealt(i)])),
  ...Object.fromEntries(LINE_LAYERS.map((id, i) => [id, dealt(i)])),
  'features-point': ['==', ['geometry-type'], 'Point'],
};

/**
 * How wide a feature is drawn, in screen pixels, at a given zoom.
 *
 * The interpolation is exponential rather than linear because the thing that
 * has to stay constant is not the width on screen but the *ground* the ink
 * covers. A pixel is 425m of Trentino at z8 and 27m at z12, so a linear ramp
 * from 4px to 8px means a valley whose stroke spans 1.7km when zoomed out and
 * 0.2km when zoomed in — a tenfold spread, which is why two features that are
 * plainly separate up close merge into one blob from far away. An exponential
 * base bends the ramp the other way: growth is weighted towards the last zoom
 * level or two, so the low end shrinks towards the ground rather than away.
 *
 * 1.6 rather than 2 because the honest answer — hold the ground constant — is
 * not the legible one. Base 2 puts a valley at 2.2px when zoomed out, which
 * declutters beautifully and reads as a scratch. This sits between that and the
 * old linear ramp: at z10 a valley is 4.6px against the 6px it used to be.
 *
 * The floor is set by legibility, not by hit-testing. Picking uses a 4px and
 * then a 14px query box around the click (see `pickAt`), so the tolerance, not
 * the stroke, is what keeps a thin line clickable.
 */
const width = (near: number, far: number): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.6], ['zoom'], 8, near, 12, far] as ExpressionSpecification;

/**
 * Draw order *within* one pair of the stack: shorter features on top.
 *
 * The stack decides which feature wins between pairs; this decides it for the
 * two that happen to share one. MapLibre otherwise draws in source order, so a
 * long valley buries a short one purely because of where it landed in the file.
 * Length is the meaningful tie-break — the feature with less room to be seen
 * gets it.
 */
const SHORTEST_ON_TOP: ExpressionSpecification = [
  '-',
  0,
  ['coalesce', ['get', 'lengthKm'], 0],
] as ExpressionSpecification;

/**
 * The whole basemap, built inline.
 *
 * Standard topo tiles print valley and peak names straight into the raster,
 * which would hand the player every answer, so this is assembled from raw
 * elevation instead: a hypsometric tint and shaded relief, both computed in the
 * browser from keyless DEM tiles.
 *
 * Nothing here draws text: the style has no symbol layers at all, so it needs
 * no glyph endpoint and therefore no API key, and no name can reach the map
 * except through the app's own HTML markers.
 */
export function buildStyle(
  context: GeoJSON.FeatureCollection,
  features: GeoJSON.FeatureCollection,
  mode: MapMode = 'play',
): StyleSpecification {
  const color = mode === 'build' ? buildColor : playColor;
  const opacity = mode === 'build' ? buildOpacity : 1;

  return {
    version: 8,
    sources: {
      terrain: {
        type: 'raster-dem',
        tiles: [TERRARIUM],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: DEM_MAXZOOM,
        attribution: 'Terrain: Mapzen / AWS Open Data',
      },
      context: { type: 'geojson', data: context },
      features: { type: 'geojson', data: features, promoteId: 'idx' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e8eae4' } },
      {
        id: 'relief',
        type: 'color-relief',
        source: 'terrain',
        paint: {
          'color-relief-opacity': 1,
          'color-relief-color': [
            'interpolate',
            ['linear'],
            ['elevation'],
            ...ELEVATION_STOPS.flat(),
          ] as ExpressionSpecification,
        },
      },
      {
        // Under the hillshade on purpose: ice takes the same shading as the
        // rock around it, so a glacier reads as a surface with shape rather
        // than a flat white sticker laid over the mountain.
        id: 'glacier',
        type: 'fill',
        source: 'context',
        filter: ['==', ['get', 'kind'], 'glacier'],
        paint: { 'fill-color': '#e4edf3', 'fill-opacity': 0.95 },
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain',
        paint: {
          // Contrast comes from the shadows; the highlight stays modest so lit
          // faces keep their colour instead of blowing out to white.
          'hillshade-method': 'igor',
          'hillshade-exaggeration': 1,
          'hillshade-shadow-color': 'rgba(14,10,6,1)',
          'hillshade-highlight-color': 'rgba(255,255,255,0.32)',
          'hillshade-accent-color': 'rgba(0,0,0,0)',
        },
      },
      {
        /*
         * A second, shadow-only pass, purely to deepen the dark end.
         *
         * Both of the obvious dials are already at their stops: MapLibre caps
         * `hillshade-exaggeration` at 1, and the shadow alpha is at 1 with a
         * near-black colour. Stacking a second hillshade is the only way left
         * to get darker, and it is the *right* way — it deepens shadow without
         * touching the highlight, so the shading gets contrastier rather than
         * the whole map getting muddier. Measured against the reference render,
         * this brings the 5th-percentile luminance from 48 to 36 against its 35.
         */
        id: 'hillshade-deepen',
        type: 'hillshade',
        source: 'terrain',
        paint: {
          'hillshade-method': 'igor',
          'hillshade-exaggeration': 1,
          'hillshade-shadow-color': 'rgba(10,7,4,0.48)',
          'hillshade-highlight-color': 'rgba(0,0,0,0)',
          'hillshade-accent-color': 'rgba(0,0,0,0)',
        },
      },
      {
        /*
         * The sea, under the lakes and rivers because a coastal river should
         * run to its mouth over open water rather than stop at the shore.
         *
         * It is drawn at all because there used to be none: with no coastline
         * in the data, `color-relief` clamped the Mediterranean to the bottom
         * of the elevation ramp and painted it the same near-white as a valley
         * floor, with the sea bed's relief showing through as hillshade.
         */
        id: 'ocean',
        type: 'fill',
        source: 'context',
        filter: ['==', ['get', 'kind'], 'ocean'],
        paint: { 'fill-color': '#9ec6df', 'fill-opacity': 1 },
      },
      {
        id: 'rivers',
        type: 'line',
        source: 'context',
        filter: ['==', ['get', 'kind'], 'river'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#93c0da',
          'line-opacity': 0.75,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 2.4],
        },
      },
      {
        // Above the rivers, because OSM maps a river's course straight through
        // the lake it flows into. Drawn the other way round, a blue line runs
        // down the middle of Garda.
        id: 'lakes',
        type: 'fill',
        source: 'context',
        filter: ['==', ['get', 'kind'], 'lake'],
        paint: { 'fill-color': '#a9cee4', 'fill-opacity': 0.9 },
      },
      {
        id: 'roads-casing',
        type: 'line',
        source: 'context',
        filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': 'rgba(60,55,50,0.45)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.6, 14, 5.5],
        },
      },
      {
        id: 'roads',
        type: 'line',
        source: 'context',
        filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, 3.6],
        },
      },
      // Casing, fill, casing, fill … so a feature is drawn over the whole of the
      // one below it rather than over only its colour. See STACK.
      ...Array.from({ length: STACK }, (_, pair) => [
        {
          id: CASING_LAYERS[pair],
          type: 'line' as const,
          source: 'features',
          filter: LAYER_GEOMETRY[CASING_LAYERS[pair]],
          layout: {
            'line-cap': 'round' as const,
            'line-join': 'round' as const,
            'line-sort-key': SHORTEST_ON_TOP,
          },
          paint: {
            'line-color': '#ffffff',
            // Opaque, because a casing you can see through is a casing the
            // feature underneath still shows in — which is the overlap this
            // whole arrangement exists to remove.
            'line-opacity': mode === 'build' ? (buildOpacity as ExpressionSpecification) : 1,
            'line-width': width(6.4, 13.2),
          },
        },
        {
          id: LINE_LAYERS[pair],
          type: 'line' as const,
          source: 'features',
          filter: LAYER_GEOMETRY[LINE_LAYERS[pair]],
          layout: {
            'line-cap': 'round' as const,
            'line-join': 'round' as const,
            'line-sort-key': SHORTEST_ON_TOP,
          },
          paint: {
            'line-width': width(3.2, 8),
            'line-color': color,
            'line-opacity': opacity,
          },
        },
      ]).flat(),
      {
        id: 'features-point',
        type: 'circle',
        source: 'features',
        filter: LAYER_GEOMETRY['features-point'],
        paint: {
          'circle-radius': width(4.2, 9),
          'circle-color': color,
          'circle-opacity': opacity,
          // Already per-feature: a circle layer draws each dot's stroke with its
          // own fill, so peaks never bury one another's edge the way lines did.
          'circle-stroke-width': width(1.6, 2.2),
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': mode === 'build' ? (buildOpacity as ExpressionSpecification) : 0.9,
        },
      },
    ],
  };
}

/**
 * Layers the click hit-test queries: every fill in the stack, and the peaks.
 *
 * The casings are deliberately absent. A casing is wider than the feature it
 * carries, so querying it would make a click land on a feature the player can
 * see they missed.
 *
 * Order here does not matter — MapLibre walks the style top layer down when it
 * assembles the results — but the consequence does: hits come back topmost
 * first, so `firstPickable` returns whichever feature is drawn over the other.
 * The click and the eye pick the same valley.
 */
export const PICK_LAYERS = [...LINE_LAYERS, 'features-point'];

/** The shape of a hit, as much of it as picking cares about. */
export type PickHit = { properties?: { osmId?: unknown } | null };

/**
 * The first hit still worth picking.
 *
 * Features that are done with — answered, or the wrong one currently being
 * highlighted — are skipped rather than returned, so a click that lands on one
 * reads as a click on the terrain behind it. Nobody means to pick a feature
 * whose name is already written on the map, and the commonest way it happens is
 * the second half of a double tap: it can only ever cost a try.
 */
export function firstPickable(hits: readonly PickHit[], spent: ReadonlySet<string>): string | null {
  for (const hit of hits) {
    const osmId = hit.properties?.osmId;
    if (typeof osmId === 'string' && !spent.has(osmId)) return osmId;
  }
  return null;
}
