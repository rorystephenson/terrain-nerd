import {
  bboxGapKm,
  bboxOf,
  bboxUnion,
  lineLengthKm,
  midpointOfLine,
  pointInBoundary,
  type BBox,
  type Boundary,
  type LonLat,
} from './geo.ts';
import type { FeatureType } from './featureTypes.ts';
import type { OverpassElement } from './overpass.ts';

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
    lengthKm: number;
    /** Where to hang a label for this feature: a point on the feature itself. */
    anchor: LonLat;
    wikidata?: string;
    ele?: number;
  };
};

export type BuildStats = {
  fetched: number;
  named: number;
  merged: number;
  inRegion: number;
  aboveFloor: number;
};

/** A single OSM element reduced to the parts the pipeline cares about. */
type RawFeature = {
  osmId: string;
  name: string;
  tags: Record<string, string>;
  parts: LonLat[][];
  bbox: BBox;
};

const toLonLat = (p: { lat: number; lon: number }): LonLat => [p.lon, p.lat];

/** Names differing only in case or spacing are the same valley to a human. */
export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

function extractGeometry(element: OverpassElement): LonLat[] | null {
  if (element.geometry?.length) return element.geometry.map(toLonLat);
  if (element.center) return [toLonLat(element.center)];
  if (element.lat !== undefined && element.lon !== undefined) return [[element.lon, element.lat]];
  return null;
}

function toRawFeatures(elements: OverpassElement[]): RawFeature[] {
  const raw: RawFeature[] = [];
  for (const element of elements) {
    const name = element.tags?.name?.trim();
    if (!name) continue;
    const coords = extractGeometry(element);
    if (!coords?.length) continue;
    raw.push({
      osmId: `${element.type}/${element.id}`,
      name,
      tags: element.tags ?? {},
      parts: [coords],
      bbox: bboxOf(coords),
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

function clusterToFeature(cluster: RawFeature[], type: FeatureType): QuizFeature {
  const parts = cluster.flatMap((member) => member.parts);
  const tags = Object.assign({}, ...cluster.map((member) => member.tags)) as Record<string, string>;
  const lengthKm =
    type.geometry === 'line' ? parts.reduce((sum, part) => sum + lineLengthKm(part), 0) : 0;

  const geometry: QuizFeature['geometry'] =
    type.geometry === 'point'
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
      lengthKm: Math.round(lengthKm * 100) / 100,
      anchor: [0, 0], // filled in by `anchorOf` once the geometry is assembled
      ...(tags.wikidata ? { wikidata: tags.wikidata } : {}),
      ...(Number.isFinite(ele) ? { ele } : {}),
    },
  };
}

/** The representative point used to decide whether a feature is in the region. */
function anchorOf(feature: QuizFeature): LonLat {
  const { geometry } = feature;
  if (geometry.type === 'Point') return geometry.coordinates;
  if (geometry.type === 'LineString') return midpointOfLine(geometry.coordinates);
  const longest = geometry.coordinates.reduce((a, b) =>
    lineLengthKm(a) >= lineLengthKm(b) ? a : b,
  );
  return midpointOfLine(longest);
}

export function normalize(
  elements: OverpassElement[],
  type: FeatureType,
  boundary: Boundary,
): { features: QuizFeature[]; stats: BuildStats } {
  const raw = toRawFeatures(elements);

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
      type.mergeGapKm > 0 ? clusterByProximity(group, type.mergeGapKm) : group.map((f) => [f]);
    merged.push(...clusters.map((cluster) => clusterToFeature(cluster, type)));
  }

  for (const feature of merged) feature.properties.anchor = anchorOf(feature);
  const inRegion = merged.filter((feature) => pointInBoundary(feature.properties.anchor, boundary));
  const aboveFloor = inRegion.filter((f) => f.properties.lengthKm >= type.minLengthKm);
  return {
    features: aboveFloor,
    stats: {
      fetched: elements.length,
      named: raw.length,
      merged: merged.length,
      inRegion: inRegion.length,
      aboveFloor: aboveFloor.length,
    },
  };
}

export function rankTags(feature: QuizFeature): Record<string, string> {
  const tags: Record<string, string> = {};
  if (feature.properties.wikidata) tags.wikidata = feature.properties.wikidata;
  if (feature.properties.ele !== undefined) tags.ele = String(feature.properties.ele);
  return tags;
}
