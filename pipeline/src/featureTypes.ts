/**
 * Feature-type registry: what to ask Overpass for, and how the results are
 * split into quizzable tiers.
 *
 * Only `valley` is built today. `pass` and `peak` are declared to keep the
 * pipeline honest about generalising — both are `ele`-tagged nodes in OSM,
 * so they need `out center` and point geometry rather than lines.
 */

export type RankInput = {
  tags: Record<string, string>;
  /** Total length of the merged feature, km. Zero for point features. */
  lengthKm: number;
  /** Domain importance, where the type computes one. See `importance.ts`. */
  importance: number;
};

/** One difficulty band. Each becomes its own set of zone quizzes. */
export type Tier = {
  id: string;
  label: string;
  description: string;
  keep: (f: RankInput) => boolean;
  /** Keep only the top N by `rank`. Omit to keep everything `keep` allows. */
  limit?: number;
};

export type FeatureType = {
  id: string;
  /** Plural label used in output filenames and the UI. */
  label: string;
  selectors: string[];
  /** Overpass output mode: full geometry for lines, centre point for nodes. */
  out: 'geom' | 'center';
  geometry: 'line' | 'point';
  /** Segments sharing a name within this many km are treated as one feature. */
  mergeGapKm: number;
  /** Global floor — nothing below this is kept for any tier. */
  minLengthKm: number;
  /** Higher sorts first. */
  rank: (f: RankInput) => number;
  /** Set when this type needs computed importance rather than raw tags. */
  scoresImportance?: boolean;
  tiers: Tier[];
};

const elevationOf = (tags: Record<string, string>) => {
  const raw = tags.ele?.trim().replace(',', '.');
  const value = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(value) ? value : 0;
};

export const featureTypes = {
  valley: {
    id: 'valley',
    label: 'valleys',
    selectors: ['nwr["natural"="valley"]', 'nwr["place"="valley"]'],
    out: 'geom',
    geometry: 'line',
    mergeGapKm: 5,
    // Nothing below the major tier's own floor is used any more, so there is no
    // reason to carry ~300 side gullies through the rest of the pipeline.
    minLengthKm: 2,
    // A wikidata entry is the strongest signal that a valley is one people name.
    rank: (f) => (f.tags.wikidata ? 1000 : 0) + f.lengthKm,
    tiers: [
      {
        id: 'major',
        label: 'Valleys',
        description: 'The ones pilots name in a flight report.',
        keep: (f) => f.lengthKm >= 2 && (Boolean(f.tags.wikidata) || f.lengthKm > 8),
      },
    ],
  },
  pass: {
    id: 'pass',
    label: 'passes',
    selectors: ['nwr["mountain_pass"="yes"]["name"]'],
    out: 'center',
    geometry: 'point',
    mergeGapKm: 0,
    minLengthKm: 0,
    rank: (f) => elevationOf(f.tags),
    tiers: [
      {
        id: 'major',
        label: 'Major passes',
        description: 'High crossings between valley systems.',
        keep: (f) => elevationOf(f.tags) > 1500,
      },
      { id: 'minor', label: 'All passes', description: 'Every named pass.', keep: () => true },
    ],
  },
  peak: {
    id: 'peak',
    label: 'peaks',
    selectors: ['nwr["natural"="peak"]["name"]'],
    out: 'center',
    geometry: 'point',
    mergeGapKm: 0,
    minLengthKm: 0,
    scoresImportance: true,
    rank: (f) => f.importance,
    tiers: [
      {
        id: 'important',
        label: 'Peaks',
        description: 'Landmarks you navigate by: dominant, well known, and near where people fly.',
        keep: (f) => elevationOf(f.tags) > 0,
        limit: 120,
      },
    ],
  },
} satisfies Record<string, FeatureType>;

export type FeatureTypeId = keyof typeof featureTypes;

export function getFeatureType(id: string): FeatureType {
  const type = (featureTypes as Record<string, FeatureType>)[id];
  if (!type) {
    throw new Error(`Unknown feature type "${id}". Known: ${Object.keys(featureTypes).join(', ')}`);
  }
  return type;
}
