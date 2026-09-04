import assert from 'node:assert/strict';
import test from 'node:test';

import { normalize } from '../../../pipeline/src/normalize.ts';
import { kinds } from '../../../pipeline/src/featureTypes.ts';
import type { RawElement } from '../../../pipeline/src/source.ts';
import type { LonLat } from '../../../pipeline/src/geo.ts';

/*
 * Merging lives in the pipeline but is tested here, where the test runner is —
 * the same arrangement as `stitch.test.ts` and `placeZoom.test.ts`.
 *
 * What these pin is not the merge itself but its *stability*: the same OSM
 * elements must produce the same ids, names and tags whatever order they were
 * streamed in. Once a quiz can be shared, a feature's id is a reference someone
 * else's saved quiz holds, so an id that moves when nothing moved is a quiz
 * that quietly shrinks.
 */

const valley = kinds.valley;

/** A named way, as a segment from `from` to `to` at latitude `lat`. */
const way = (
  id: string,
  name: string,
  from: number,
  to: number,
  lat = 46,
  tags: Record<string, string> = {},
): RawElement => ({
  id,
  tags: { name, ...tags },
  coords: [
    [from, lat],
    [to, lat],
  ] as LonLat[],
  closed: false,
  geometry: { type: 'LineString', coordinates: [[from, lat], [to, lat]] },
});

/** Every permutation of a small list, so "order-independent" is not spot-checked. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

test('a merged feature keeps the same id however its segments were streamed', () => {
  // Three touching segments of one valley: one feature, whatever the order.
  const segments = [
    way('w300', 'Val Rendena', 10.7, 10.75),
    way('w100', 'Val Rendena', 10.75, 10.8),
    way('w200', 'Val Rendena', 10.8, 10.85),
  ];

  const ids = new Set<string>();
  for (const order of permutations(segments)) {
    const { features } = normalize(order, valley);
    assert.equal(features.length, 1, 'the three segments are one valley');
    ids.add(features[0].id);
  }

  assert.deepEqual([...ids], ['valley/w100'], 'the lowest osm id speaks for the cluster');
});

test('the merged name and tags do not depend on stream order either', () => {
  // The same valley spelled two ways, and only one segment carrying wikidata.
  // Before sorting, both the spelling shown to the player and the wikidata tag
  // used to repair a moved id were whichever segment happened to arrive last.
  const segments = [
    way('w200', 'val  rendena', 10.75, 10.8, 46, { wikidata: 'Q222' }),
    way('w100', 'Val Rendena', 10.7, 10.75, 46, { wikidata: 'Q111' }),
  ];

  const seen = new Set<string>();
  for (const order of permutations(segments)) {
    const { features } = normalize(order, valley);
    assert.equal(features.length, 1);
    seen.add(`${features[0].properties.name}|${features[0].properties.wikidata}`);
  }

  assert.deepEqual([...seen], ['Val Rendena|Q111'], 'the same member speaks for both');
});

test('separate valleys sharing a name stay separate, and each is stable', () => {
  // Trentino's four Valsordas: same name, nowhere near each other. The gap here
  // is far wider than valley.mergeGapKm, so proximity must keep them apart.
  const segments = [
    way('w900', 'Valsorda', 11.6, 11.65),
    way('w100', 'Valsorda', 10.7, 10.75),
  ];

  const results = new Set<string>();
  for (const order of permutations(segments)) {
    const { features } = normalize(order, valley);
    results.add([...features.map((f) => f.id)].sort().join(','));
  }

  assert.deepEqual([...results], ['valley/w100,valley/w900'], 'two features, stable ids');
});

test('points are untouched: a peak keeps its own node id', () => {
  // mergeGapKm is 0 for peaks, so two same-named summits never merge and the
  // sort has nothing to decide.
  const summits: RawElement[] = [
    { id: 'n2', tags: { name: 'Cima Tosa' }, coords: [[10.87, 46.16]], closed: false,
      geometry: { type: 'Point', coordinates: [10.87, 46.16] } },
    { id: 'n1', tags: { name: 'Cima Tosa' }, coords: [[11.4, 46.4]], closed: false,
      geometry: { type: 'Point', coordinates: [11.4, 46.4] } },
  ];

  for (const order of permutations(summits)) {
    const { features } = normalize(order, kinds.peak);
    assert.deepEqual(
      features.map((f) => f.id).sort(),
      ['peak/n1', 'peak/n2'],
      'both summits survive with their own ids',
    );
  }
});
