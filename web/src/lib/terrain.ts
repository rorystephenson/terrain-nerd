/**
 * The elevation model's constants: the DEM source and the hypsometric palette.
 *
 * Deliberately free of runtime imports. `mapStyle.ts` reads this and
 * `mapStyle.test.ts` reads that, so anything pulling in maplibre-gl here would
 * make the style untestable outside a browser.
 *
 * The basemap has to carry the whole orientation job on its own, because it is
 * not allowed to name anything being quizzed. An elevation tint over shaded
 * relief is what a pilot already reads terrain by, and it gives that away free.
 */
/** Mapzen terrain on AWS Open Data: raw elevation, keyless. */
export const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_MAXZOOM = 13;

/**
 * Metres -> colour, fitted rather than guessed.
 *
 * Each stop was solved by pairing pixels of a reference topo render with real
 * terrarium elevations at the same coordinates, then iterating the ramp until
 * this style reproduced the reference's colour in every 100 m band to within
 * ~2%. That is why the numbers look arbitrary: they are measured, not designed,
 * and the shape they encode — green valley floor, gold at the treeline, brown
 * through the rock, neutral grey at glacier height — is the point.
 *
 * The bottom of the ramp is pale rather than green on purpose. The reference
 * shows valley floors — the Adige through Trento and Rovereto, the Sarca at
 * Arco — as near-white, because down there the ground is farmland and town, not
 * forest. A saturated green at 200 m makes the lowlands look like alpine
 * meadow, which is both wrong and much louder than the terrain above it.
 *
 * MapLibre samples these as texture stops, so keep the list short and ordered.
 */
export const ELEVATION_STOPS: [number, string][] = [
  [0, '#e7ebe1'],
  [200, '#d9e1cb'],
  [400, '#bdd095'],
  [600, '#a4c563'],
  [800, '#a9c43b'],
  [1100, '#b7b12e'],
  [1400, '#977622'],
  [1700, '#825320'],
  [2000, '#845a39'],
  [2300, '#98765c'],
  [2600, '#a18976'],
  [2900, '#998c81'],
  [3200, '#95908d'],
  [3600, '#8f8f8f'],
];
