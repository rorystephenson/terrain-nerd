import type {
  ExpressionSpecification,
  FilterSpecification,
  StyleSpecification,
} from 'maplibre-gl';

/** A feature nobody has answered yet. */
export const NEUTRAL = '#3f4a5a';
/** A valley clicked by mistake — "not that one". */
export const MISS = '#e0921a';
/** The answer being pointed out. */
export const REVEAL = '#d64545';

/**
 * How an answered feature is coloured, from found-first-try to had-to-be-shown.
 *
 * A miss is not a failure, it is a near miss, and the colour should say so:
 * green shades through yellow to red as the tries are spent, which turns the
 * finished map into a legible picture of what you actually know.
 */
export const GRADE_STOPS: [number, string][] = [
  [0, '#1f9d55'],
  [0.34, '#a8bc1f'],
  [0.67, '#e08a1a'],
  [1, REVEAL],
];

/** The same ramp as the map expression, for HTML labels. */
export function gradeColor(grade: number): string {
  const g = Math.max(0, Math.min(1, grade));
  let [lowAt, lowHex] = GRADE_STOPS[0];
  for (const [at, hex] of GRADE_STOPS) {
    if (at <= g) [lowAt, lowHex] = [at, hex];
  }
  const upper = GRADE_STOPS.find(([at]) => at > g);
  if (!upper) return lowHex;
  const t = (g - lowAt) / (upper[0] - lowAt);
  const mix = (a: string, b: string, i: number) =>
    Math.round(
      Number.parseInt(a.slice(i, i + 2), 16) * (1 - t) +
        Number.parseInt(b.slice(i, i + 2), 16) * t,
    )
      .toString(16)
      .padStart(2, '0');
  return `#${mix(lowHex, upper[1], 1)}${mix(lowHex, upper[1], 3)}${mix(lowHex, upper[1], 5)}`;
}

/**
 * Feature colour, resolved from feature-state.
 *
 * `flash` and `miss` are transient feedback and win over everything; `answered`
 * gates the grade ramp so an untouched feature is never mistaken for a perfect
 * score (feature-state has no null test, so the boolean carries that).
 */
const colorExpression: ExpressionSpecification = [
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
  NEUTRAL,
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
 * Deliberately contains no symbol layers: standard topo tiles print valley and
 * peak names straight into the raster, which would hand the player every
 * answer. Shaded relief plus unlabeled water gives enough to navigate by
 * without giving the game away — and needs no API key.
 */
export function buildStyle(
  water: GeoJSON.FeatureCollection,
  features: GeoJSON.FeatureCollection,
): StyleSpecification {
  return {
    version: 8,
    sources: {
      terrain: {
        type: 'raster-dem',
        // Mapzen terrain on AWS Open Data: raw elevation, keyless.
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 13,
        attribution: 'Terrain: Mapzen / AWS Open Data',
      },
      water: { type: 'geojson', data: water },
      features: { type: 'geojson', data: features, promoteId: 'idx' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#eceee8' } },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain',
        paint: {
          'hillshade-shadow-color': '#4a5a52',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#6f8073',
          'hillshade-exaggeration': 0.55,
        },
      },
      {
        id: 'rivers',
        type: 'line',
        source: 'water',
        filter: ['==', ['get', 'kind'], 'river'],
        paint: { 'line-color': '#7fa8c9', 'line-width': 1, 'line-opacity': 0.55 },
      },
      {
        id: 'lakes',
        type: 'fill',
        source: 'water',
        filter: ['==', ['get', 'kind'], 'lake'],
        paint: { 'fill-color': '#8fb8d8', 'fill-opacity': 0.75 },
      },
      {
        id: 'features-casing',
        type: 'line',
        source: 'features',
        filter: LAYER_GEOMETRY['features-casing'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-opacity': 0.65,
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
          'line-color': colorExpression,
        },
      },
      {
        id: 'features-point',
        type: 'circle',
        source: 'features',
        filter: LAYER_GEOMETRY['features-point'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 12, 9],
          'circle-color': colorExpression,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': 0.9,
        },
      },
    ],
  };
}

/** Layers the click hit-test queries. */
export const PICK_LAYERS = ['features-line', 'features-point'];
