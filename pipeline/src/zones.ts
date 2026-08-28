import { assembleRings, bboxUnion, haversineKm, pointInRing, type BBox, type LonLat } from './geo.ts';
import { cachedQuery } from './overpass.ts';
import type { Region } from './regions.ts';

/**
 * Quiz zones.
 *
 * The point of a zone is that it is a *fixed* set you can replay until you know
 * it — so zones are derived once, deterministically, and every feature belongs
 * to exactly one per tier.
 *
 * Trentino's own sub-regions (the 16 comunità di valle, admin_level=7) give
 * real, locally-correct names, but they are wildly uneven: Valsugana e Tesino
 * holds 64 valleys where Cembra holds 2. So they are the starting point, then
 * undersized ones are merged with their nearest neighbour and oversized ones
 * are bisected until every zone is a playable size.
 */

export type Subregion = { name: string; rings: LonLat[][]; centre: LonLat };

export type Zone = {
  id: string;
  label: string;
  bbox: BBox;
  /**
   * Distinct names in this zone, which is what the player is actually asked.
   * Lower than `featureIds.length` where two unrelated features share a name —
   * the quiz asks once and accepts a click on either.
   */
  questionCount: number;
  featureIds: string[];
};

export type ZoneLimits = { min: number; max: number };

/** Comunità names are long and formulaic; the quiz menu wants the short form. */
export function shortenSubregionName(name: string): string {
  return name
    .replace(/^Magnifica Comunità degli\s+/i, '')
    .replace(/^Comunità territoriale della\s+/i, '')
    .replace(/^Comunità (della|delle|dei|di|del)\s+/i, '')
    .replace(/^Comunità\s+/i, '')
    .replace(/^Comun General de\s+/i, '')
    .replace(/^Territorio\s+/i, '')
    .trim();
}

export async function fetchSubregions(region: Region, refresh: boolean): Promise<Subregion[]> {
  const query = [
    '[out:json][timeout:300];',
    `rel(area:${3600000000 + region.osmRelationId})["boundary"="administrative"]["admin_level"="${region.subregionAdminLevel}"];`,
    'out geom;',
  ].join('\n');
  const response = await cachedQuery(`${region.id}-subregions`, query, refresh);

  const subregions: Subregion[] = [];
  for (const element of response.elements) {
    const name = element.tags?.name;
    if (!name) continue;
    const rings = assembleRings(
      (element.members ?? [])
        .filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry?.length)
        .map((m) => m.geometry!.map((p): LonLat => [p.lon, p.lat])),
    );
    if (rings.length === 0) continue;
    const points = rings.flat();
    subregions.push({
      name: shortenSubregionName(name),
      rings,
      centre: [
        points.reduce((s, p) => s + p[0], 0) / points.length,
        points.reduce((s, p) => s + p[1], 0) / points.length,
      ],
    });
  }
  return subregions;
}

type Placed = { id: string; anchor: LonLat };

/** A group of features under construction, before it becomes a Zone. */
type Bucket = { names: string[]; items: Placed[] };

const centreOf = (items: Placed[]): LonLat => [
  items.reduce((s, i) => s + i.anchor[0], 0) / items.length,
  items.reduce((s, i) => s + i.anchor[1], 0) / items.length,
];

const COMPASS = [
  'east',
  'north-east',
  'north',
  'north-west',
  'west',
  'south-west',
  'south',
  'south-east',
] as const;

/** Which way `to` lies from `from`, to the nearest eighth. */
function compassOf(from: LonLat, to: LonLat): string {
  const dx = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
  const dy = to[1] - from[1];
  const angle = Math.atan2(dy, dx);
  const step = Math.round((((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4));
  return COMPASS[step % 8];
}

/**
 * Splits a group in half across its wider axis, at the median, recursing until
 * every part fits `max`.
 *
 * Parts are labelled afterwards by where they actually sit, not by the chain of
 * splits that produced them — two splits on the same axis would otherwise yield
 * a part named "south-north".
 */
function bisect(items: Placed[], max: number): Placed[][] {
  if (items.length <= max) return [items];

  const lons = items.map((i) => i.anchor[0]);
  const lats = items.map((i) => i.anchor[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lonSpan = (Math.max(...lons) - Math.min(...lons)) * Math.cos((midLat * Math.PI) / 180);
  const byLon = lonSpan >= Math.max(...lats) - Math.min(...lats);

  const sorted = [...items].sort((a, b) =>
    byLon ? a.anchor[0] - b.anchor[0] : a.anchor[1] - b.anchor[1],
  );
  const half = Math.ceil(sorted.length / 2);
  return [...bisect(sorted.slice(0, half), max), ...bisect(sorted.slice(half), max)];
}

/**
 * Groups features into replayable zones.
 *
 * `anchors` maps feature id -> a point on that feature; `bboxes` maps feature
 * id -> its bounding box, used to frame the zone on the map.
 */
export function buildZones(
  featureIds: string[],
  anchors: Map<string, LonLat>,
  bboxes: Map<string, BBox>,
  names: Map<string, string>,
  subregions: Subregion[],
  tierId: string,
  regionLabel: string,
  limits: ZoneLimits,
): Zone[] {
  const placed: Placed[] = featureIds
    .filter((id) => anchors.has(id))
    .map((id) => ({ id, anchor: anchors.get(id)! }));

  // 1. Assign to the sub-region containing the anchor. Anchors that land just
  //    outside every ring (border rounding) fall back to the nearest centre.
  const buckets = new Map<string, Bucket>();
  for (const item of placed) {
    const containing = subregions.find((s) => s.rings.some((r) => pointInRing(item.anchor, r)));
    const nearest =
      containing ??
      subregions.reduce((best, s) =>
        haversineKm(item.anchor, s.centre) < haversineKm(item.anchor, best.centre) ? s : best,
      );
    const bucket = buckets.get(nearest.name) ?? { names: [nearest.name], items: [] };
    bucket.items.push(item);
    buckets.set(nearest.name, bucket);
  }

  // 2. Fold undersized buckets into their nearest neighbour until none are too
  //    small to be worth replaying on their own.
  const list = [...buckets.values()];
  while (list.length > 1) {
    const smallest = list.reduce((a, b) => (a.items.length <= b.items.length ? a : b));
    if (smallest.items.length >= limits.min) break;
    const centre = centreOf(smallest.items);
    const target = list
      .filter((b) => b !== smallest)
      .reduce((a, b) =>
        haversineKm(centre, centreOf(a.items)) <= haversineKm(centre, centreOf(b.items)) ? a : b,
      );
    const absorbed = smallest.items.length;
    target.names = [...target.names, ...smallest.names];
    target.items.push(...smallest.items);
    void absorbed;
    list.splice(list.indexOf(smallest), 1);
  }

  // 3. Bisect anything still oversized, then name the parts by where they sit.
  const regionCentre = centreOf(placed);
  const zones: Zone[] = [];
  for (const bucket of list) {
    const parts = bisect(bucket.items, limits.max);
    const bucketCentre = centreOf(bucket.items);

    // A zone assembled from three or more sub-regions is no longer "X and a bit
    // extra" — it is a quarter of the province, and saying so is more honest.
    const base =
      bucket.names.length === 1
        ? bucket.names[0]
        : bucket.names.length === 2
          ? `${bucket.names[0]} & ${bucket.names[1]}`
          : `${titleCase(compassOf(regionCentre, bucketCentre))} ${regionLabel}`;

    const labels = parts.map((part) =>
      parts.length === 1 ? base : `${base} — ${compassOf(bucketCentre, centreOf(part))}`,
    );
    // Two parts can land on the same eighth; fall back to numbering if so.
    const unique = new Set(labels).size === labels.length;

    parts.forEach((part, i) => {
      const label = unique ? labels[i] : `${base} — ${i + 1} of ${parts.length}`;
      zones.push({
        id: `${tierId}-${slug(label)}`,
        label,
        bbox: bboxUnion(part.map((p) => bboxes.get(p.id)!)),
        questionCount: new Set(
          part.map((p) => (names.get(p.id) ?? p.id).trim().toLowerCase().replace(/\s+/g, ' ')),
        ).size,
        featureIds: part.map((p) => p.id),
      });
    });
  }

  return zones.sort((a, b) => a.label.localeCompare(b.label));
}

const titleCase = (value: string) => value[0].toUpperCase() + value.slice(1);

const slug = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
