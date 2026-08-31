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

/** A feature the builder is leaving out. Grey says "not part of this". */
export const NEUTRAL = '#3f4a5a';
/** A valley clicked by mistake — "not that one". */
export const MISS = '#e0921a';
/** The answer being pointed out. */
export const REVEAL = '#d64545';
/** A feature that will be in the quiz being built. */
export const PICKED = '#1f7a8c';

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
 * score (feature-state has no null test, so the boolean carries that).
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
  UNANSWERED,
] as ExpressionSpecification;

/** In the builder, colour says only one thing: is this in the quiz or not. */
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
 * Which geometries each feature layer is allowed to draw.
 *
 * A circle layer renders one circle per *vertex*, so without this the peak layer
 * speckles every valley line with dots at its segment joins. Lines and points
 * share one source, so each layer has to say what it is for.
 */
export const LAYER_GEOMETRY: Record<string, FilterSpecification> = {
  'features-casing': ['!=', ['geometry-type'], 'Point'],
  'features-line': ['!=', ['geometry-type'], 'Point'],
  'features-point': ['==', ['geometry-type'], 'Point'],
};

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
      {
        id: 'features-casing',
        type: 'line',
        source: 'features',
        filter: LAYER_GEOMETRY['features-casing'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-opacity': mode === 'build' ? (buildOpacity as ExpressionSpecification) : 0.65,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 7, 12, 13],
        },
      },
      {
        id: 'features-line',
        type: 'line',
        source: 'features',
        filter: LAYER_GEOMETRY['features-line'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 8],
          'line-color': color,
          'line-opacity': opacity,
        },
      },
      {
        id: 'features-point',
        type: 'circle',
        source: 'features',
        filter: LAYER_GEOMETRY['features-point'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 12, 9],
          'circle-color': color,
          'circle-opacity': opacity,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': mode === 'build' ? (buildOpacity as ExpressionSpecification) : 0.9,
        },
      },
    ],
  };
}

/** Layers the click hit-test queries. */
export const PICK_LAYERS = ['features-line', 'features-point'];

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
