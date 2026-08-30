export type KindId = 'valley' | 'peak' | 'pass';

export type FeatureProperties = {
  name: string;
  kind: KindId;
  lengthKm: number;
  /** A point on the feature itself, used to hang its label. */
  anchor: [number, number];
  /** 0-100 percentile within the kind. Set for peaks and passes. */
  popularity?: number;
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

export type PlaceFeature = {
  type: 'Feature';
  bbox: [number, number, number, number];
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { name: string; rank: number };
};

/** Basemap furniture: never a quiz answer, never named on the map. */
export type ContextCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: GeoJSON.Geometry;
    properties: { kind: 'road' | 'glacier' | 'lake' | 'river'; class?: string };
  }[];
};

/** A numeric property the builder puts a range slider on. */
export type FilterSpec = {
  key: 'lengthKm' | 'popularity';
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  default: [number, number];
};

/** One feature type in the pool, with the controls that narrow it down. */
export type KindInfo = {
  id: KindId;
  label: string;
  geometry: 'line' | 'point';
  filters: FilterSpec[];
  count: number;
  /** Cell key -> feature count. Absent keys hold nothing, so are never requested. */
  cells: Record<string, number>;
};

/** What the app loads first: the shape of the pool and where its chunks are. */
export type PoolIndex = {
  generatedAt: string;
  attribution: string;
  area: [number, number, number, number];
  cellSize: number;
  kinds: KindInfo[];
  places: { count: number; ranks: string[]; cells: Record<string, number> };
  context: { count: number; cells: Record<string, number> };
  water: { count: number; cells: Record<string, number> };
};

/** Whether a feature is in the quiz, and whether the filter or the user decided. */
export type Inclusion = 'auto-in' | 'auto-out' | 'locked-in' | 'locked-out';

export type BuilderState = {
  /** Which kinds are shown and available for selection. */
  kinds: Record<string, boolean>;
  /** kind id -> filter key -> [min, max]. */
  ranges: Record<string, Record<string, [number, number]>>;
  /** Features the user pinned, either way. Survives every filter change. */
  overrides: Record<string, 'in' | 'out'>;
};

/** One replayable quiz: a frozen set of features. */
export type QuizSpec = {
  id: string;
  name: string;
  source: 'built' | 'starter';
  createdAt: string;
  /** Resolved at save time, so replaying always asks the same set. */
  featureIds: string[];
  /** Derived from the chosen features, not from the builder viewport. */
  bbox: [number, number, number, number];
  /** Kept so editing can restore the sliders; never used to play. */
  builder?: BuilderState;
};

/** Where the map is currently looking, relative to the area being quizzed. */
export type ViewState = {
  view: [number, number, number, number];
  /** True when the whole area is on screen, so the minimap can hide itself. */
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
