/**
 * What makes a mountain or a pass worth being asked about.
 *
 * Two numbers, both 0-1, both with a meaningful zero, and deliberately kept
 * apart rather than blended: the right weighting between them is a thing to find
 * by using the builder, not to guess here.
 *
 * - **flight** — how much people fly near or over it, from `skyways.ts`.
 * - **prominence** — how tall it is, tempered by what stands near it.
 *
 * This replaced a single `popularity` percentile built from topographic
 * isolation, Wikidata sitelinks and distance to an OSM free-flying site. Three
 * things were wrong with it. It had no paragliding signal — a tagged launch site
 * says where you *can* take off, not where anyone goes. Altitude was a tiebreak
 * at `0.8 * ele/1000`, so there was no way to ask for the big one round here.
 * And being a percentile it could never be filtered to nothing: the top bucket
 * is non-empty by construction, so dragging the slider to the end still left
 * 373 peaks selected.
 */
import type { Coverage } from './coverage.ts';
import type { LonLat } from './geo.ts';
import type { QuizFeature } from './normalize.ts';
import { buildIndex } from './spatial.ts';
import { fetchSkyways, readSkyways, sampleFlight } from './skyways.ts';

/** Where the height term tops out. Above this a mountain is simply a big one. */
const HEIGHT_FULL_M = 4000;

/**
 * Isolation at which a peak counts as fully dominant.
 *
 * Log-compressed, so the interesting range is the first few kilometres: the
 * difference between "nothing higher for 500 m" and "nothing higher for 5 km" is
 * most of what separates a sub-summit from a mountain, and 40 km against 60 km
 * separates nothing at all.
 */
const ISOLATION_FULL_KM = 40;
/** Past this we stop looking; anything further is already fully dominant. */
const ISOLATION_CAP_KM = 60;

/** How far to look for the mountain over a pass, and how much of it counts. */
const FLANK_RANGE_KM = 5;
const FLANK_FULL_M = 1200;

/** How far to look for a stand-in elevation when a feature has no `ele` tag. */
const ELE_FILL_KM = 10;

/**
 * The busy end of the flight distribution, used to scale it.
 *
 * A weighted mean over a 4.5 km disc is a small number even over the busiest
 * ground — most of any disc is empty sky — so scaling against 255 would push
 * everything into the bottom tenth of the slider. The 99th percentile of what
 * we actually measured is the honest reference. Ground with no flights over it
 * still scores a true zero, which is the half of the problem a percentile could
 * never solve.
 */
const BUSY_PERCENTILE = 0.99;

/**
 * Below this prominence, flying overhead stops counting as flying *here*.
 *
 * Skyways is a two-dimensional record: a track crossing a valley at 2,500 m
 * paints the valley floor exactly as a track along a ridge paints the ridge. So
 * the raw sample over Dosso Saiano — 343 m, under the Garda-to-Trento corridor —
 * comes out as high as the sample over Monte Stivo, and a score that says so is
 * describing the airspace rather than the mountain.
 *
 * Scaling by prominence up to this point fixes that without touching anything
 * above it: a feature that is a mountain at all keeps its full score, and ground
 * under traffic is demoted in proportion to how little of a feature it is. Over
 * the Adamello and Brenta it drops the flown set from 76 to 55 without losing
 * one of the twelve peaks a person actually picked; at Annecy it costs Le Thoron
 * at 597 m and Mont Rampignon at 894 m, which is the intended kind of loss.
 */
const FLIGHT_MIN_PROMINENCE = 0.3;

export type Scores = { flight: number; prominence: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Both terms must be there. A giant with something higher beside it is a shoulder. */
const blend = (a: number, b: number) => Math.sqrt(a * b);

export const heightTerm = (ele: number): number => clamp01(ele / HEIGHT_FULL_M);

export const dominanceTerm = (isolationKm: number): number =>
  clamp01(Math.log2(1 + Math.max(0, isolationKm)) / Math.log2(1 + ISOLATION_FULL_KM));

export const flankTerm = (metresAbove: number): number => clamp01(metresAbove / FLANK_FULL_M);

/** A peak stands out by being tall *and* by having nothing taller nearby. */
export const peakProminence = (ele: number, isolationKm: number): number =>
  blend(heightTerm(ele), dominanceTerm(isolationKm));

/**
 * A pass is a low point, so isolation says nothing — by definition something
 * higher is right beside it. What makes a col rather than a bump in a road is
 * how much mountain stands over it.
 */
export const passProminence = (ele: number, metresAbove: number): number =>
  blend(heightTerm(ele), flankTerm(metresAbove));

/** The value at a fraction through the sorted data. */
function quantile(values: Float64Array, fraction: number): number {
  const sorted = Float64Array.from(values).sort();
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

/** A compact "0.0:12% 0.1:8% ..." tally, so a re-run shows the shape at a glance. */
function deciles(values: number[]): string {
  const bins = new Array(10).fill(0);
  for (const value of values) bins[Math.min(9, Math.floor(value * 10))]++;
  return bins
    .map((n, i) => `${(i / 10).toFixed(1)}:${Math.round((100 * n) / Math.max(values.length, 1))}%`)
    .join(' ');
}

/**
 * Scores every peak and pass in the pool.
 *
 * The one network step in an otherwise offline build, and only on ground whose
 * skyways tiles are not already cached.
 */
export async function scorePool(
  features: readonly QuizFeature[],
  coverage: Coverage | null,
): Promise<Map<string, Scores>> {
  const scored = features.filter(
    (f) => f.properties.kind === 'peak' || f.properties.kind === 'pass',
  );
  const out = new Map<string, Scores>();
  if (scored.length === 0) return out;

  /*
   * Isolation is measured against named peaks that carry an `ele`, which is all
   * the yardstick there is without a DEM. It means a mountain is only as
   * dominant as OSM's tagging around it is complete — a real limit, and the
   * height term is what keeps a lone tagged bump on a plateau in its place.
   */
  const yardstick = features
    .filter((f) => f.properties.kind === 'peak')
    .map((f) => ({ at: f.properties.anchor, ele: f.properties.ele ?? 0 }))
    .filter((p) => p.ele > 0);
  const peakIndex = buildIndex(yardstick, (p) => p.at);

  /*
   * A missing `ele` takes the local median rather than zero.
   *
   * 4% of peaks and 7% of passes have no elevation tag. Scoring those as sea
   * level would put every one of them below any non-zero floor — a tagging gap
   * quietly becoming a claim about the ground.
   */
  const elevationOf = (at: LonLat, tagged?: number): number => {
    if (tagged && tagged > 0) return tagged;
    const near = peakIndex.within(at, ELE_FILL_KM, () => true);
    if (near.length === 0) return 0;
    const eles = near.map((p) => p.ele).sort((a, b) => a - b);
    return eles[eles.length >> 1];
  };

  if (coverage) {
    await fetchSkyways(coverage);
  } else {
    console.log('    skyways: no coverage, flight scores will be zero');
  }
  const raster = coverage
    ? await readSkyways(coverage)
    : { worldSize: 1, cells: new Map<string, Uint8Array>() };

  // Prominence first: the flight score is scaled by it, so it has to exist
  // before the sampled ink can be turned into a score.
  const prominences = scored.map((feature) => {
    const at = feature.properties.anchor;
    const ele = elevationOf(at, feature.properties.ele);
    if (feature.properties.kind === 'peak') {
      return peakProminence(ele, peakIndex.nearest(at, (p) => p.ele > ele, ISOLATION_CAP_KM));
    }
    // Spread into Math.max would be a stack overflow waiting for a dense enough
    // neighbourhood; the pool has already been bitten by that once.
    let highest = 0;
    for (const peak of peakIndex.within(at, FLANK_RANGE_KM, () => true)) {
      if (peak.ele > highest) highest = peak.ele;
    }
    return passProminence(ele, highest - ele);
  });

  const raw = sampleFlight(raster, scored.map((f) => f.properties.anchor));
  // Gated before the reference is taken, so "the busy end" means the busy end of
  // real features rather than of whatever the corridors happen to cross.
  for (let i = 0; i < raw.length; i++) {
    raw[i] *= clamp01(prominences[i] / FLIGHT_MIN_PROMINENCE);
  }
  const busy = quantile(raw, BUSY_PERCENTILE);

  const flights: number[] = [];
  for (let i = 0; i < scored.length; i++) {
    const flight = busy > 0 ? clamp01(raw[i] / busy) : 0;
    flights.push(flight);
    out.set(scored[i].id, { flight: round3(flight), prominence: round3(prominences[i]) });
  }

  console.log(`    flight     ${deciles(flights)}`);
  console.log(`    prominence ${deciles(prominences)}`);
  return out;
}
