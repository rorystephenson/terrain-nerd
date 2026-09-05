export type KindId = 'valley' | 'peak' | 'pass';

export type FeatureProperties = {
  name: string;
  kind: KindId;
  lengthKm: number;
  /** A point on the feature itself, used to hang its label. */
  anchor: [number, number];
  /** 0-1, how much flying happens around it. Set for peaks and passes. */
  flight?: number;
  /** 0-1, how far it stands over what is near it. Set for peaks and passes. */
  prominence?: number;
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
  properties: {
    name: string;
    /** 1..4, city to hamlet. Sizes and weights the label. */
    rank: number;
    /**
     * The zooms this name may be drawn over, decided offline in
     * `pipeline/src/placeZoom.ts`. Absent on pools built before that existed;
     * an absent `maxzoom` means the name never hands over.
     */
    minzoom?: number;
    maxzoom?: number;
  };
};

/** A numeric property the builder puts a range slider on. */
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
  default: [number, number];
};

/** One feature type in the pool, with the controls that narrow it down. */
export type KindInfo = {
  id: KindId;
  label: string;
  /** Spacing on a fresh builder, in km. Absent means this kind is not thinned. */
  defaultSpacingKm?: number;
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
  /** Zoom of the XYZ tiles the pool is chunked into. */
  chunkZoom: number;
  kinds: KindInfo[];
  places: {
    count: number;
    ranks: string[];
    cells: Record<string, number>;
    /** Absent on a pool built before names carried their own zoom range. */
    thinned?: boolean;
    zoomRange?: [number, number];
    /** The label box the thinning measured with, so a mismatch is at least visible. */
    labelBox?: { charWidth: number; padding: number; height: number; gap: number };
  };
  /**
   * The ground the basemap tiles cover, as the tiles they were chosen at.
   * Absent on a pool built before coverage existed, which means "assume all".
   */
  coverage?: { zoom: number; cells: string[] } | null;
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
  /**
   * Kind id -> how far apart that kind's features must stand, in km.
   *
   * 0 is off, and the stop past the top of the scale hides the kind entirely.
   * Optional because saved builder state is read back from localStorage
   * verbatim, with no migration — a quiz saved before this existed has no such
   * field and must reopen exactly as it was left, which is thinning off.
   */
  spacing?: Record<string, number>;
};

/**
 * A feature as a quiz remembers it.
 *
 * An id alone was enough while a quiz never left the browser that built it: the
 * pool it pointed into was the pool that made it. Shared quizzes break that.
 * The pool is rebuilt from OSM, and an id can move — a way gets deleted, a
 * valley's segments cluster differently — at which point a quiz holding bare
 * ids quietly asks a shorter round and nobody can tell that it did.
 *
 * So a quiz carries enough to find a feature again without its id: what it is
 * called, what kind it is, roughly where it stands, and its wikidata entity when
 * OSM has one. See `resolve.ts` for what does the finding.
 */
export type FeatureRef = {
  id: string;
  kind: KindId;
  name: string;
  /** The feature's own anchor, so same-named features can be told apart. */
  at: [number, number];
  /** The most durable key there is, when OSM carries one. */
  wikidata?: string;
};

/** One replayable quiz: a frozen set of features. */
export type QuizSpec = {
  id: string;
  name: string;
  /**
   * Where the quiz came from. `shared` means it was kept from someone else's
   * link — it plays like any other, but it is not yours to publish, and the
   * rules would refuse it anyway.
   */
  source: 'built' | 'starter' | 'shared';
  createdAt: string;
  /** Resolved at save time, so replaying always asks the same set. */
  features: FeatureRef[];
  /** Derived from the chosen features, not from the builder viewport. */
  bbox: [number, number, number, number];
  /** Kept so editing can restore the sliders; never used to play. */
  builder?: BuilderState;
  /**
   * When the quiz was last *edited*, as opposed to created.
   *
   * Only set by the builder, and deliberately not by `healSpec`: a repair that
   * fills in names the pool already knows is not an edit anyone made, and
   * letting it bump the clock would make a quiz look newer on whichever machine
   * happened to play it last. Absent on quizzes saved before this existed, so
   * readers fall back to `createdAt`.
   */
  updatedAt?: string;
  /**
   * `PoolIndex.generatedAt` when this quiz was saved.
   *
   * Says which build of the pool the ids were true of, so a quiz that resolves
   * badly can at least be told apart from one built against today's data.
   */
  poolAt?: string;
};

/** Where the map is currently looking, relative to the area being quizzed. */
export type ViewState = {
  view: [number, number, number, number];
  /** True when the whole area is on screen, so the minimap can hide itself. */
  covers: boolean;
  /**
   * What the map is actually at, rather than what the bbox implies.
   *
   * Place detail follows this directly. Deriving it from the bbox instead made
   * it a function of window shape and of latitude — a portrait window shows a
   * different number of degrees of latitude at the same zoom in Sicily and in
   * the Alps — so panning north could change how much detail you got.
   */
  zoom: number;
  /** Canvas size in CSS pixels, so a fetch pad can be stated in pixels. */
  canvas: { width: number; height: number };
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
