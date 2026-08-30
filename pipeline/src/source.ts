/**
 * Streams the extracted pool off disk.
 *
 * `osmium export` writes GeoJSON-seq — one complete feature per line — so a
 * country's worth of data can be walked without ever holding it all as parsed
 * JSON. Everything downstream sees `RawElement`, which knows nothing about
 * where the data came from.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { LonLat } from './geo.ts';
import { layerFile, type LayerId } from './extract.ts';

export type RawElement = {
  /** osmium's type-prefixed id, e.g. `n240109189` or `w41240791`. */
  id: string;
  tags: Record<string, string>;
  /** A point is one coordinate; lines and rings are flattened in order. */
  coords: LonLat[];
  /** True when the source geometry enclosed an area, so it can be drawn filled. */
  closed: boolean;
  /**
   * The geometry as exported, structure intact.
   *
   * `coords` is lossy on purpose — a valley only needs its points in order —
   * but anything drawn as a filled shape needs the real nesting. Flattening
   * Lake Garda's multipolygon into one list and closing it produces a single
   * self-intersecting ring, which renders as wedges and holes.
   */
  geometry: RawGeometry;
};

export type RawGeometry = {
  type: string;
  coordinates: unknown;
};

type ExportedFeature = {
  id?: string;
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, string>;
};

/** Pulls every coordinate pair out of any GeoJSON geometry, in order. */
function flatten(coordinates: unknown, into: LonLat[]): void {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    into.push([coordinates[0], coordinates[1]]);
    return;
  }
  for (const part of coordinates) flatten(part, into);
}

/** GeoJSON-seq permits an ASCII record separator in front of each record. */
const RECORD_SEPARATOR = new RegExp('^\\x1e');

export async function* readLayer(layer: LayerId): AsyncGenerator<RawElement> {
  const stream = createReadStream(layerFile(layer), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    const trimmed = line.replace(RECORD_SEPARATOR, '').trim();
    if (!trimmed) continue;

    let feature: ExportedFeature;
    try {
      feature = JSON.parse(trimmed) as ExportedFeature;
    } catch {
      continue; // a truncated final line, from an interrupted export
    }

    const geometry = feature.geometry;
    if (!geometry || !feature.id) continue;

    const coords: LonLat[] = [];
    flatten(geometry.coordinates, coords);
    if (coords.length === 0) continue;

    yield {
      id: feature.id,
      tags: feature.properties ?? {},
      coords,
      closed: geometry.type === 'Polygon' || geometry.type === 'MultiPolygon',
      geometry: geometry as RawGeometry,
    };
  }
}
