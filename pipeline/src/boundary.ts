import { assembleRings, type Boundary, type LonLat } from './geo.ts';
import { cachedQuery } from './overpass.ts';
import type { Region } from './regions.ts';

/**
 * Fetches a region's administrative outline as assembled polygon rings.
 *
 * Needed because Overpass `area(...)` queries return every feature that merely
 * *intersects* the area — Valle Camonica is 74km of Lombardy that clips the
 * Trentino border. Testing each feature's own anchor point against these rings
 * is what keeps neighbours out.
 */
export async function fetchBoundary(region: Region, refresh: boolean): Promise<Boundary> {
  const query = `[out:json][timeout:180];\nrel(${region.osmRelationId});\nout geom;`;
  const response = await cachedQuery(`${region.id}-boundary`, query, refresh);

  const outerWays: LonLat[][] = [];
  const innerWays: LonLat[][] = [];
  for (const element of response.elements) {
    for (const member of element.members ?? []) {
      if (member.type !== 'way' || !member.geometry?.length) continue;
      const coords = member.geometry.map((p): LonLat => [p.lon, p.lat]);
      if (member.role === 'inner') innerWays.push(coords);
      else outerWays.push(coords);
    }
  }

  const boundary = { outer: assembleRings(outerWays), inner: assembleRings(innerWays) };
  if (boundary.outer.length === 0) {
    throw new Error(`Could not assemble a boundary for ${region.label} (relation ${region.osmRelationId})`);
  }
  return boundary;
}
