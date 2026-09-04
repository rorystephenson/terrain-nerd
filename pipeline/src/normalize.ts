import {
  bboxGapKm,
  bboxOf,
  bboxUnion,
  lineLengthKm,
  midpointOfLine,
  type BBox,
  type LonLat,
} from './geo.ts';
import type { FeatureKind, KindId } from './featureTypes.ts';
import type { RawElement } from './source.ts';

export type QuizFeature = {
  type: 'Feature';
  id: string;
  bbox: BBox;
  geometry:
    | { type: 'LineString'; coordinates: LonLat[] }
    | { type: 'MultiLineString'; coordinates: LonLat[][] }
    | { type: 'Point'; coordinates: LonLat };
  properties: {
    name: string;
    kind: KindId;
    lengthKm: number;
    /** Where to hang a label for this feature: a point on the feature itself. */
    anchor: LonLat;
    /** 0-1, how much flying happens around it. Set for scored kinds only. */
    flight?: number;
    /** 0-1, how far it stands over what is near it. Set for scored kinds only. */
    prominence?: number;
    wikidata?: string;
    ele?: number;
  };
};

export type BuildStats = { named: number; merged: number };

/** A single OSM element reduced to the parts the pipeline cares about. */
type RawFeature = {
  osmId: string;
  name: string;
  tags: Record<string, string>;
  parts: LonLat[][];
  bbox: BBox;
};

/** Names differing only in case or spacing are the same valley to a human. */
export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function toRawFeatures(elements: RawElement[], kind: KindId): RawFeature[] {
  const raw: RawFeature[] = [];
  for (const element of elements) {
    const name = element.tags.name?.trim();
    if (!name || element.coords.length === 0) continue;
    raw.push({
      // Namespaced by kind: a built quiz mixes kinds in one id list, and
      // osmium's `w338446899` alone is not unique across the pool.
      osmId: `${kind}/${element.id}`,
      name,
      tags: element.tags,
      parts: [element.coords],
      bbox: bboxOf(element.coords),
    });
  }
  return raw;
}

/**
 * Group same-named segments into clusters that are actually near each other.
 *
 * OSM splits one valley across several ways, so segments sharing a name usually
 * belong together — but not always. Trentino has four separate `Valsorda`
 * valleys scattered across the province; merging on name alone would fuse them
 * into one nonsensical feature, so proximity decides.
 */
function clusterByProximity(group: RawFeature[], gapKm: number): RawFeature[][] {
  const clusters: RawFeature[][] = [];
  for (const feature of group) {
    const matches = clusters.filter((cluster) =>
      cluster.some((member) => bboxGapKm(member.bbox, feature.bbox) <= gapKm),
    );
    if (matches.length === 0) {
      clusters.push([feature]);
      continue;
    }
    // This feature bridges several clusters — collapse them into one.
    const [first, ...rest] = matches;
    first.push(feature);
    for (const other of rest) {
      first.push(...other);
      clusters.splice(clusters.indexOf(other), 1);
    }
  }
  return clusters;
}

/**
 * One merged feature from a cluster of same-named segments.
 *
 * **Sorted by osm id first, and everything downstream depends on that.** A
 * cluster arrives in whatever order the extracts streamed, and five separate
 * things were reading that order as if it meant something: the feature's id and
 * its display name were taken from `cluster[0]`, the tag merge let the last
 * member win, the parts were concatenated as they came, and `anchorOf` breaks a
 * tie between equal-length parts by position.
 *
 * So the same OSM data could produce a different id, a different spelling of the
 * name, and a different `wikidata` tag from one run to the next. That was
 * invisible while quizzes lived in the browser that built them. It stops being
 * invisible the moment a quiz is shared: a rebuilt pool silently drops features
 * out of other people's quizzes, and the fallback that would repair them matches
 * on exactly the name and wikidata tag that also moved.
 *
 * Note the *partition* was never the problem — `clusterByProximity` returns the
 * connected components of a symmetric relation, which is order-independent
 * already. It was only ever which member got to speak for the cluster.
 *
 * The lowest osm id speaks for it, and speaks for all of it: its id, its
 * spelling of the name, and its tags. Other members only fill in tags it did
 * not carry.
 */
function clusterToFeature(unordered: RawFeature[], kind: FeatureKind): QuizFeature {
  const cluster = [...unordered].sort((a, b) => (a.osmId < b.osmId ? -1 : a.osmId > b.osmId ? 1 : 0));
  const parts = cluster.flatMap((member) => member.parts);
  // Reversed, because `Object.assign` lets the *last* source win: this way the
  // representative's own tags take precedence and the rest only fill gaps it
  // left. Assigning in cluster order instead would take the id and the name
  // from the lowest member but `wikidata` and `ele` from the highest, which is
  // one feature describing itself with two different segments' facts.
  const tags = Object.assign(
    {},
    ...[...cluster].reverse().map((member) => member.tags),
  ) as Record<string, string>;
  const lengthKm =
    kind.geometry === 'line' ? parts.reduce((sum, part) => sum + lineLengthKm(part), 0) : 0;

  const geometry: QuizFeature['geometry'] =
    kind.geometry === 'point'
      ? { type: 'Point', coordinates: parts[0][0] }
      : parts.length === 1
        ? { type: 'LineString', coordinates: parts[0] }
        : { type: 'MultiLineString', coordinates: parts };

  const ele = tags.ele ? Number.parseFloat(tags.ele.replace(',', '.')) : undefined;

  return {
    type: 'Feature',
    id: cluster[0].osmId,
    bbox: bboxUnion(cluster.map((member) => member.bbox)),
    geometry,
    properties: {
      name: cluster[0].name,
      kind: kind.id,
      lengthKm: Math.round(lengthKm * 100) / 100,
      anchor: [0, 0], // filled in by `anchorOf` once the geometry is assembled
      ...(tags.wikidata ? { wikidata: tags.wikidata } : {}),
      ...(Number.isFinite(ele) ? { ele } : {}),
    },
  };
}

/** The representative point used to place a feature on the grid and hang its label. */
function anchorOf(feature: QuizFeature): LonLat {
  const { geometry } = feature;
  if (geometry.type === 'Point') return geometry.coordinates;
  if (geometry.type === 'LineString') return midpointOfLine(geometry.coordinates);
  const longest = geometry.coordinates.reduce((a, b) =>
    lineLengthKm(a) >= lineLengthKm(b) ? a : b,
  );
  return midpointOfLine(longest);
}

/**
 * Turns raw elements of one kind into quiz features.
 *
 * Deliberately applies no significance filter of any sort: the builder is what
 * decides what is worth learning now, and a floor here would make the user's
 * own example — hand-picking a 2 km valley they know — impossible.
 */
export function normalize(
  elements: RawElement[],
  kind: FeatureKind,
): { features: QuizFeature[]; stats: BuildStats } {
  const raw = toRawFeatures(elements, kind.id);

  const byName = new Map<string, RawFeature[]>();
  for (const feature of raw) {
    const key = normalizeName(feature.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(feature);
    else byName.set(key, [feature]);
  }

  const merged: QuizFeature[] = [];
  for (const group of byName.values()) {
    const clusters =
      kind.mergeGapKm > 0 ? clusterByProximity(group, kind.mergeGapKm) : group.map((f) => [f]);
    merged.push(...clusters.map((cluster) => clusterToFeature(cluster, kind)));
  }

  for (const feature of merged) feature.properties.anchor = anchorOf(feature);
  return { features: merged, stats: { named: raw.length, merged: merged.length } };
}
