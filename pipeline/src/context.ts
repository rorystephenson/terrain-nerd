import { assembleRings, bboxOf, pointInBoundary, type Boundary, type LonLat } from './geo.ts';
import { areaIdFor, type Region } from './regions.ts';
import { cachedQuery } from './overpass.ts';

/**
 * Builds the unlabeled orientation layer: lakes and rivers, geometry only.
 *
 * Names are deliberately stripped. Pure hillshade is hard to read, but any
 * labelled basemap would hand the player the answers, so the map gets shapes
 * without words.
 */

type ContextFeature = {
  type: 'Feature';
  geometry:
    | { type: 'Polygon'; coordinates: LonLat[][] }
    | { type: 'LineString'; coordinates: LonLat[] };
  properties: { kind: 'lake' | 'river' };
};

/** Skips ponds that would render as invisible specks at quiz zoom levels. */
const MIN_LAKE_SPAN_KM = 0.3;

function spanKm(coords: LonLat[]): number {
  const [minLon, minLat, maxLon, maxLat] = bboxOf(coords);
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  return Math.hypot((maxLon - minLon) * 111.32 * Math.cos(midLat), (maxLat - minLat) * 110.57);
}

export async function buildContext(region: Region, boundary: Boundary, refresh: boolean) {
  const areaId = areaIdFor(region);
  const query = [
    '[out:json][timeout:180];',
    `area(${areaId})->.searchArea;`,
    '(',
    '  way["natural"="water"](area.searchArea);',
    '  relation["natural"="water"](area.searchArea);',
    '  way["waterway"="river"](area.searchArea);',
    ');',
    'out geom;',
  ].join('\n');

  const response = await cachedQuery(`${region.id}-context`, query, refresh);
  const features: ContextFeature[] = [];

  for (const element of response.elements) {
    const isRiver = element.tags?.waterway === 'river';

    if (isRiver && element.geometry?.length) {
      const coords = element.geometry.map((p): LonLat => [p.lon, p.lat]);
      if (coords.some((c) => pointInBoundary(c, boundary))) {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'river' } });
      }
      continue;
    }

    // Lakes arrive as closed ways, or as relations whose member ways must be chained.
    const rings: LonLat[][] =
      element.type === 'relation'
        ? assembleRings(
            (element.members ?? [])
              .filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry?.length)
              .map((m) => m.geometry!.map((p): LonLat => [p.lon, p.lat])),
          )
        : element.geometry?.length
          ? [element.geometry.map((p): LonLat => [p.lon, p.lat])]
          : [];

    for (const ring of rings) {
      if (ring.length < 4 || spanKm(ring) < MIN_LAKE_SPAN_KM) continue;
      const closed: LonLat[] =
        ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
          ? ring
          : [...ring, ring[0]];
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [closed] }, properties: { kind: 'lake' } });
    }
  }

  return { type: 'FeatureCollection' as const, features };
}
