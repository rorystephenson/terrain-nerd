/**
 * Region registry. Adding a new quiz region means adding one entry here —
 * everything downstream is driven off it.
 */

export type Region = {
  id: string;
  label: string;
  /** OSM relation id of the administrative boundary. */
  osmRelationId: number;
  /** admin_level of the sub-regions quiz zones are built from. */
  subregionAdminLevel: number;
  /** Initial map camera for the quiz. */
  center: [number, number];
  zoom: number;
};

export const regions = {
  trentino: {
    id: 'trentino',
    label: 'Trentino',
    osmRelationId: 45756, // Provincia di Trento, admin_level=6
    subregionAdminLevel: 7, // the 16 comunità di valle
    center: [11.12, 46.07],
    zoom: 8.2,
  },
} satisfies Record<string, Region>;

export type RegionId = keyof typeof regions;

/** Overpass addresses relations as areas by offsetting the relation id. */
export const areaIdFor = (region: Region) => 3600000000 + region.osmRelationId;

export function getRegion(id: string): Region {
  const region = (regions as Record<string, Region>)[id];
  if (!region) {
    throw new Error(`Unknown region "${id}". Known: ${Object.keys(regions).join(', ')}`);
  }
  return region;
}
