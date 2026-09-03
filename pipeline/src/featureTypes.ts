/**
 * What we pull out of the raw pool, and what the builder can filter it by.
 *
 * The pipeline no longer decides what is worth learning — it ships everything
 * named and the player filters at build time. So this registry declares *kinds*
 * and their filter controls, not tiers of importance.
 */

/** A numeric property the builder can put a range slider on. */
export type FilterSpec = {
  key: 'lengthKm' | 'flight' | 'prominence';
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Where the slider sits on a fresh builder. */
  default: [number, number];
};

export type FeatureKind = {
  id: KindId;
  label: string;
  geometry: 'line' | 'point';
  /** Segments sharing a name within this many km are treated as one feature. */
  mergeGapKm: number;
  /** Set when this kind needs computed scores rather than a raw tag. */
  scored: boolean;
  filters: FilterSpec[];
};

export type KindId = 'valley' | 'peak' | 'pass';

/**
 * Peaks and passes filter on two scores rather than one, and they are kept apart
 * on purpose: the right weighting between "people fly here" and "it stands over
 * everything" is a thing to find by moving the sliders, not to decide here. See
 * `scores.ts` for what each one measures.
 *
 * Length is the meaningful filter for valleys, and stays a single one.
 *
 * Defaults are measured against Val Rendena, the same yardstick as before: of
 * its 316 named peaks and 37 passes they admit 25 and 9, which is a playable
 * quiz rather than an afternoon. Loosening either by 0.05 roughly triples it.
 *
 * The two scores really do pull apart there, which is the point of keeping them
 * separate: Doss del Sabion, the Pinzolo takeoff, comes top on flight at 0.65
 * and only 0.42 on prominence, while Cima Brenta — the highest thing for miles
 * and nobody's flight path — is 0.78 and 0.15 the other way.
 */
export const kinds = {
  valley: {
    id: 'valley',
    label: 'Valleys',
    geometry: 'line',
    mergeGapKm: 5,
    scored: false,
    filters: [
      { key: 'lengthKm', label: 'Length', unit: 'km', min: 0, max: 40, step: 0.5, default: [5, 40] },
    ],
  },
  peak: {
    id: 'peak',
    label: 'Mountains',
    geometry: 'point',
    mergeGapKm: 0,
    scored: true,
    filters: [
      { key: 'flight', label: 'Flight proximity', unit: '', min: 0, max: 1, step: 0.01, default: [0.3, 1] },
      { key: 'prominence', label: 'Prominence', unit: '', min: 0, max: 1, step: 0.01, default: [0.35, 1] },
    ],
  },
  pass: {
    id: 'pass',
    label: 'Passes',
    geometry: 'point',
    mergeGapKm: 0,
    scored: true,
    filters: [
      { key: 'flight', label: 'Flight proximity', unit: '', min: 0, max: 1, step: 0.01, default: [0.3, 1] },
      { key: 'prominence', label: 'Prominence', unit: '', min: 0, max: 1, step: 0.01, default: [0.35, 1] },
    ],
  },
} satisfies Record<KindId, FeatureKind>;

export const kindList = Object.values(kinds) as FeatureKind[];

/** Settlement classes, most significant first. The builder shows `rank <= level`. */
export const PLACE_RANKS = ['city', 'town', 'village', 'hamlet'] as const;
export type PlaceRank = (typeof PLACE_RANKS)[number];

/**
 * Which kind, if any, a raw OSM element belongs to.
 *
 * One raw cell file holds every layer at once, so this is the only thing that
 * decides what an element becomes. Order matters: a saddle tagged as both a
 * pass and a peak is a pass.
 */
export function classify(tags: Record<string, string> | undefined): KindId | null {
  if (!tags) return null;
  if (tags.natural === 'valley' || tags.place === 'valley') return 'valley';
  if (tags.mountain_pass === 'yes') return 'pass';
  if (tags.natural === 'peak') return 'peak';
  return null;
}

export const placeRankOf = (tags: Record<string, string> | undefined): number => {
  const at = PLACE_RANKS.indexOf(tags?.place as PlaceRank);
  return at === -1 ? 0 : at + 1;
};

export const isFlyingSite = (tags: Record<string, string> | undefined): boolean =>
  tags?.sport === 'free_flying';

export const getKind = (id: string): FeatureKind => {
  const kind = (kinds as Record<string, FeatureKind>)[id];
  if (!kind) throw new Error(`Unknown kind "${id}". Known: ${Object.keys(kinds).join(', ')}`);
  return kind;
};
