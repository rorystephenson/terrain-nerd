/**
 * Quizzes across the wire: `QuizSpec` in and out of a Firestore document.
 *
 * `storage.ts` says of a quiz file that it "is the one thing here that comes
 * from outside the app, so it is checked rather than trusted". A Firestore
 * document is now a second such thing, and a more hostile one — a published
 * quiz was written by someone else, and security rules cannot loop, so they can
 * check that `features` is a list of at most 400 things but never that any
 * element of it is well formed. Whatever the rules let through, this is what
 * stands between it and the round.
 *
 * So `docToSpec` refuses rather than half-reads, and drops individual malformed
 * references rather than failing the whole quiz over one of them: a quiz that
 * asks 59 of its 60 questions is worth more than no quiz at all, and the count
 * is visible either way.
 *
 * Deliberately free of every Firebase type. It takes and returns plain values,
 * which is what makes it testable under `node --test` alongside everything else
 * in `lib`.
 */
import { questionsIn } from './builder.ts';
import { cellsCovering } from './grid.ts';
import type { BuilderState, FeatureRef, KindId, QuizSpec } from './types.ts';

/** Firestore rejects a document over 1 MiB; this keeps us far under it. */
export const MAX_FEATURES = 400;
export const MAX_NAME = 80;

const KINDS = new Set<string>(['valley', 'peak', 'pass']);

/** What a draft looks like at `users/{uid}/quizzes/{quizId}`. */
export type QuizDoc = {
  schema: 1;
  ownerId: string;
  name: string;
  source: QuizSpec['source'];
  createdAt: string;
  updatedAt: string;
  features: FeatureRef[];
  bbox: [number, number, number, number];
  poolAt?: string;
  builder?: BuilderState;
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isBox = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(isNum);

const isPoint = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every(isNum);

/**
 * One reference, or nothing.
 *
 * `id` and `kind` are the whole of what a reference must have — everything else
 * is the fallback material, and a reference missing it is a reference that can
 * only be resolved by id, which is exactly the state every quiz saved before
 * `FeatureRef` existed is already in. So a partial ref is kept, not dropped.
 */
export function readRef(value: unknown): FeatureRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;

  return {
    id: raw.id,
    kind: raw.kind as KindId,
    ...(typeof raw.name === 'string' && raw.name.length > 0 ? { name: raw.name } : {}),
    ...(isPoint(raw.at) ? { at: raw.at } : {}),
    ...(typeof raw.wikidata === 'string' ? { wikidata: raw.wikidata } : {}),
  };
}

/**
 * The builder panel's state, or nothing.
 *
 * Never trusted enough to be read field by field, and never important enough to
 * fail a quiz over: it only restores slider positions when the owner reopens
 * their own quiz, and a quiz whose sliders come back at their defaults is a
 * nuisance where a quiz that refuses to load is a loss. So this is shape-checked
 * and otherwise passed through.
 */
function readBuilder(value: unknown): BuilderState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const obj = (v: unknown) => (typeof v === 'object' && v !== null ? v : undefined);
  if (!obj(raw.kinds) || !obj(raw.ranges) || !obj(raw.overrides)) return undefined;
  return raw as unknown as BuilderState;
}

/**
 * A document as a quiz, or `null` if it is not one.
 *
 * The id comes from the document's own path rather than from its contents, so a
 * quiz cannot claim to be a different quiz than the one it was read from.
 */
export function docToSpec(id: string, value: unknown): QuizSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw.name !== 'string' || raw.name.length === 0) return null;
  if (!isBox(raw.bbox)) return null;
  if (!Array.isArray(raw.features)) return null;

  const features = raw.features
    .slice(0, MAX_FEATURES)
    .map(readRef)
    .filter((ref): ref is FeatureRef => ref !== null);
  if (features.length === 0) return null;

  return {
    id,
    name: raw.name.slice(0, MAX_NAME),
    source:
      raw.source === 'starter' || raw.source === 'shared'
        ? (raw.source as QuizSpec['source'])
        : 'built',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    features,
    bbox: raw.bbox,
    ...(typeof raw.poolAt === 'string' ? { poolAt: raw.poolAt } : {}),
    ...(readBuilder(raw.builder) ? { builder: readBuilder(raw.builder) } : {}),
  };
}

/**
 * A quiz as a document.
 *
 * Every optional field is *omitted* rather than set to `undefined`, because
 * Firestore rejects an undefined value outright rather than treating it as an
 * absent one — so a quiz with no `poolAt` would fail the write instead of
 * writing without it.
 */
export function specToDoc(spec: QuizSpec, ownerId: string, now: string): QuizDoc {
  return {
    schema: 1,
    ownerId,
    name: spec.name.slice(0, MAX_NAME),
    source: spec.source,
    createdAt: spec.createdAt,
    updatedAt: now,
    features: spec.features.slice(0, MAX_FEATURES).map((ref) => ({
      id: ref.id,
      kind: ref.kind,
      ...(ref.name !== undefined ? { name: ref.name } : {}),
      ...(ref.at !== undefined ? { at: ref.at } : {}),
      ...(ref.wikidata !== undefined ? { wikidata: ref.wikidata } : {}),
    })),
    bbox: spec.bbox,
    ...(spec.poolAt !== undefined ? { poolAt: spec.poolAt } : {}),
    ...(spec.builder !== undefined ? { builder: spec.builder } : {}),
  };
}

/**
 * Does this value contain an `undefined` anywhere inside it?
 *
 * Used by the tests rather than at runtime. An `undefined` nested three levels
 * into a builder state is the kind of thing that writes fine in development,
 * where the field happened to be set, and throws in front of someone else.
 */
export function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(hasUndefined);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(hasUndefined);
  }
  return false;
}


/**
 * The zoom the discovery grid is cut at.
 *
 * Reuses `cellsCovering` from `grid.ts` — the same web-mercator arithmetic the
 * pool is already chunked with, and already pinned against the pipeline's copy
 * by `grid.test.ts`. So "quizzes near this ground" needs no geohash library and
 * no second coordinate system: a quiz stores the cells its bbox touches, and a
 * viewport asks for the cells it touches.
 *
 * z7 is roughly 200 km at Alpine latitudes. A quiz touches one or two; a
 * viewport rarely more than a handful, which matters because Firestore's
 * `array-contains-any` takes at most thirty values. z9, the pool's own chunk
 * zoom, would be far too fine for that — a wide viewport would blow the limit.
 */
export const CELL_ZOOM = 7;

/** A quiz's own count of cells is capped: a pathological bbox must not blow the doc up. */
const MAX_CELLS = 24;

/** What the world sees at `published/{quizId}`. */
export type PublishedDoc = {
  schema: 1;
  ownerId: string;
  /** Denormalised, so playing a shared quiz needs no second read for a byline. */
  ownerName: string;
  name: string;
  version: number;
  publishedAt: string;
  features: FeatureRef[];
  bbox: [number, number, number, number];
  kinds: KindId[];
  counts: { valley: number; peak: number; pass: number; questions: number };
  cells: string[];
  cellZoom: number;
  players: number;
  hidden: boolean;
  poolAt?: string;
};

/** A published quiz, as the app holds it: the spec plus who and when. */
export type Published = {
  spec: QuizSpec;
  ownerId: string;
  ownerName: string;
  version: number;
  publishedAt: string;
  questions: number;
  players: number;
};

/**
 * A draft, frozen.
 *
 * `builder` is deliberately left behind. It is editing state, it is the largest
 * field in the document, and publishing it would invite an expectation of
 * remixing that has not been designed. What ships is what a round needs and
 * what a list needs to describe it.
 */
export function specToPublished(
  spec: QuizSpec,
  owner: { id: string; name: string },
  version: number,
  now: string,
): PublishedDoc {
  const features = spec.features.slice(0, MAX_FEATURES).map((ref) => ({
    id: ref.id,
    kind: ref.kind,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.at !== undefined ? { at: ref.at } : {}),
    ...(ref.wikidata !== undefined ? { wikidata: ref.wikidata } : {}),
  }));

  const counts = { valley: 0, peak: 0, pass: 0 };
  for (const ref of features) counts[ref.kind] += 1;

  return {
    schema: 1,
    ownerId: owner.id,
    ownerName: owner.name.slice(0, 40),
    name: spec.name.slice(0, MAX_NAME),
    version,
    publishedAt: now,
    features,
    bbox: spec.bbox,
    kinds: [...new Set(features.map((ref) => ref.kind))],
    counts: {
      ...counts,
      // Not `features.length`: two features sharing a name are one question,
      // and the score is a percentage of questions.
      questions: questionsIn(features.map((ref) => ref.name ?? ref.id)),
    },
    cells: cellsCovering(spec.bbox, CELL_ZOOM).slice(0, MAX_CELLS),
    cellZoom: CELL_ZOOM,
    players: 0,
    hidden: false,
    ...(spec.poolAt !== undefined ? { poolAt: spec.poolAt } : {}),
  };
}

/**
 * A published document as something playable, or `null`.
 *
 * The most suspicious boundary in the app: this document was written by someone
 * else, and the rules cannot loop, so nothing server-side has looked at a single
 * element of `features`.
 */
export function docToPublished(id: string, value: unknown): Published | null {
  const spec = docToSpec(id, value);
  if (!spec) return null;
  const raw = value as Record<string, unknown>;

  const counts = raw.counts as { questions?: unknown } | undefined;
  const questions =
    typeof counts?.questions === 'number' && Number.isFinite(counts.questions)
      ? counts.questions
      : questionsIn(spec.features.map((ref) => ref.name ?? ref.id));

  return {
    spec,
    ownerId: typeof raw.ownerId === 'string' ? raw.ownerId : '',
    ownerName: typeof raw.ownerName === 'string' ? raw.ownerName.slice(0, 40) : '',
    version: typeof raw.version === 'number' && raw.version > 0 ? Math.floor(raw.version) : 1,
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : '',
    questions,
    players: typeof raw.players === 'number' && raw.players >= 0 ? Math.floor(raw.players) : 0,
  };
}
