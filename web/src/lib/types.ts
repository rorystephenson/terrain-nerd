export type FeatureProperties = {
  name: string;
  lengthKm: number;
  /** A point on the feature itself, used to hang its label. */
  anchor: [number, number];
  wikidata?: string;
  ele?: number;
};

export type QuizFeature = {
  type: 'Feature';
  id: string;
  bbox: [number, number, number, number];
  geometry: GeoJSON.Geometry;
  properties: FeatureProperties;
};

export type FeatureFile = {
  type: 'FeatureCollection';
  features: QuizFeature[];
};

export type ContextCollection = {
  type: 'FeatureCollection';
  features: { type: 'Feature'; geometry: GeoJSON.Geometry; properties: { kind: 'lake' | 'river' } }[];
};

/** One replayable quiz: a fixed set of features in a named area. */
export type Zone = {
  id: string;
  label: string;
  bbox: [number, number, number, number];
  /** How many questions the round asks — features sharing a name are asked once. */
  questionCount: number;
  featureIds: string[];
};

export type Tier = {
  id: string;
  label: string;
  description: string;
  count: number;
  zones: Zone[];
};

/** One kind of thing to learn — valleys, peaks — with its own data file. */
export type Group = {
  id: string;
  label: string;
  geometry: 'line' | 'point';
  /** Filename of the GeoJSON holding this group's features. */
  data: string;
  tiers: Tier[];
};

export type QuizManifest = {
  region: string;
  regionLabel: string;
  generatedAt: string;
  attribution: string;
  groups: Group[];
};

/** Where the map is currently looking, relative to the zone being quizzed. */
export type ViewState = {
  view: [number, number, number, number];
  /** True when the whole zone is on screen, so the minimap can hide itself. */
  covers: boolean;
};

/**
 * A name label drawn over a feature.
 *
 * `wrong` and `reveal` are transient feedback; `answered` persists for the rest
 * of the round, tinted by how many tries it took.
 */
export type MapLabel = {
  featureId: string;
  text: string;
  tone: 'wrong' | 'reveal' | 'answered';
  /** Explicit background, used to tint answered labels by grade. */
  color?: string;
};
