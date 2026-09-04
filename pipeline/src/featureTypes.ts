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
  /**
   * Kept as a rule but taken off the panel.
   *
   * Flight and prominence are settled numbers now, not things to tune per quiz
   * — they still decide what qualifies, but the only control worth having in
   * front of you is how much of what qualifies to ask about.
   */
  hidden?: boolean;
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
  /**
   * How far apart to stand this kind's features, in km, on a fresh builder.
   *
   * Absent means the kind is never thinned — which is valleys, having no scores
   * to rank a cluster by and a length filter that already narrows them.
   */
  defaultSpacingKm?: number;
  filters: FilterSpec[];
};

export type KindId = 'valley' | 'peak' | 'pass';

/**
 * Peaks and passes qualify on two scores rather than one, and the two **union**
 * — each admits what it admits, rather than narrowing what the other left. See
 * `matchesFilter` in `web/src/lib/builder.ts` for why that is the only
 * combination that can express a real selection, and `scores.ts` for what each
 * score measures.
 *
 * **Both are hidden.** They were sliders for as long as it took to find where
 * they belong, and 0.27 flight or 0.39 prominence is where using them landed:
 * loose enough to admit anything anyone would name, on the understanding that
 * the spacing is what decides how many of those get asked. Two settled numbers
 * behind one control beats three controls, two of which you set once.
 *
 * Length is the meaningful filter for valleys, stays visible, and stays single —
 * valleys are not thinned, having no scores to rank a cluster by.
 *
 * Spacing defaults are set from the counts they produce over Val Rendena, where
 * 3 km leaves 28 of 117 admitted peaks. Passes want a wider radius for the same
 * job, not a narrower one: there are fewer of them and they already stand
 * further apart, so the same 3 km leaves 17 of 35 — half, against a quarter. At
 * 5 km they come down to 10, which is about the share of a quiz passes should
 * be.
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
    defaultSpacingKm: 3,
    filters: [
      { key: 'flight', label: 'Flight proximity', unit: '', min: 0, max: 1, step: 0.01, hidden: true, default: [0.27, 1] },
      { key: 'prominence', label: 'Prominence', unit: '', min: 0, max: 1, step: 0.01, hidden: true, default: [0.39, 1] },
    ],
  },
  pass: {
    id: 'pass',
    label: 'Passes',
    geometry: 'point',
    mergeGapKm: 0,
    scored: true,
    defaultSpacingKm: 5,
    filters: [
      { key: 'flight', label: 'Flight proximity', unit: '', min: 0, max: 1, step: 0.01, hidden: true, default: [0.27, 1] },
      { key: 'prominence', label: 'Prominence', unit: '', min: 0, max: 1, step: 0.01, hidden: true, default: [0.39, 1] },
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
