import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignZoomRanges,
  boxAt,
  compareImportance,
  scaleRetireZoom,
  LABEL_BOX as PIPELINE_LABEL_BOX,
  MAX_LABEL_ZOOM,
  parsePopulation,
  RANK_SCALE as PIPELINE_RANK_SCALE,
  territoryKm,
  worldSizeAt,
  worldX,
  worldY,
  type PlaceInput,
} from '../../../pipeline/src/placeZoom.ts';
import { LABEL_BOX, labelRect, RANK_SCALE, scaleForRank } from './labels.ts';

/*
 * The offline pass lives in the pipeline workspace, but what it decides is only
 * correct if it measures the same ink the browser draws — so the tests for it
 * live here, on the side that does the drawing, and import across the boundary.
 * Node strips the types, and nothing here reaches the Vite bundle.
 */

const place = (
  key: string,
  at: [number, number],
  rank = 4,
  name = 'Somewhere',
  population = 0,
): PlaceInput => ({ key, name, rank, population, at });

/** A regular lattice, so the geometry of what survives is easy to reason about. */
function lattice(rows: number, columns: number, stepDeg: number, rank = 4): PlaceInput[] {
  const out: PlaceInput[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      out.push(
        place(`p${row}-${column}`, [10 + column * stepDeg, 46 + row * stepDeg], rank, `Name${row}${column}`),
      );
    }
  }
  return out;
}

const liveAt = (places: PlaceInput[], ranges: ReturnType<typeof assignZoomRanges>, zoom: number) =>
  places.filter((p) => {
    const min = ranges.min.get(p.key)!;
    const max = ranges.max.get(p.key) ?? Number.POSITIVE_INFINITY;
    return zoom >= min && zoom < max;
  });

const hits = (a: ReturnType<typeof boxAt>, b: ReturnType<typeof boxAt>) =>
  a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

test('the offline pass measures the same ink the renderer draws', () => {
  // Not a shared module — crossing the workspace boundary at build time would
  // mean Vite fs rules and a browser bundle that depends on the pipeline. But
  // unlike a key format these numbers cannot be eyeballed for agreement, and a
  // mismatch produces a map that overlaps or is sparse with nothing to catch it.
  assert.deepEqual(PIPELINE_LABEL_BOX, LABEL_BOX);
  assert.deepEqual([...PIPELINE_RANK_SCALE], [...RANK_SCALE]);

  const worldSize = worldSizeAt(12);
  const subject = place('a', [11, 46], 2, 'Pinzolo');
  const box = boxAt(subject, worldSize);
  const drawn = labelRect(
    { x: worldX(11, worldSize), y: worldY(46, worldSize) },
    'Pinzolo',
    scaleForRank(2),
  );
  const gap = LABEL_BOX.gap;
  assert.deepEqual(box, {
    x1: drawn.x1 - gap,
    y1: drawn.y1 - gap,
    x2: drawn.x2 + gap,
    y2: drawn.y2 + gap,
  });
});

test('world pixels match MapLibre 512px tiles', () => {
  assert.equal(worldSizeAt(0), 512);
  assert.equal(worldSizeAt(1), 1024);
  const w = worldSizeAt(0);
  assert.equal(worldX(-180, w), 0);
  assert.equal(worldX(180, w), w);
  assert.equal(worldX(0, w), w / 2);
  assert.equal(worldY(0, w), w / 2);
  assert.ok(Math.abs(worldY(85.051129, w)) < 1e-3, 'the Mercator limit is the top edge');
});

test('a zoom level doubles every world coordinate', () => {
  // The whole design rests on this. Boxes keep their size while distances
  // double, so a set that clears itself at one zoom clears itself at every zoom
  // above it — which is why an integer-zoom decision is safe to use at 11.7, and
  // why nothing has to be recomputed as the map moves.
  for (const zoom of [0, 4, 9, 13]) {
    for (const lat of [-40, 0, 35.5, 46, 47.5]) {
      for (const lon of [-170, -12, 0, 11.1, 179]) {
        assert.ok(Math.abs(worldX(lon, worldSizeAt(zoom + 1)) - 2 * worldX(lon, worldSizeAt(zoom))) < 1e-9);
        assert.ok(Math.abs(worldY(lat, worldSizeAt(zoom + 1)) - 2 * worldY(lat, worldSizeAt(zoom))) < 1e-9);
      }
    }
  }
});

test('no two names drawn together ever overlap', () => {
  const places = lattice(14, 14, 0.02);
  const ranges = assignZoomRanges(places);
  for (let zoom = 0; zoom <= MAX_LABEL_ZOOM; zoom++) {
    const live = liveAt(places, ranges, zoom);
    const boxes = live.map((p) => boxAt(p, worldSizeAt(zoom)));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        assert.ok(!hits(boxes[i], boxes[j]), `${live[i].key} and ${live[j].key} clash at z${zoom}`);
      }
    }
  }
});

test('a set that fits at one zoom still fits at every zoom below it', () => {
  // Fractional zoom draws the set chosen for the integer beneath it, so that set
  // has to stay disjoint all the way to the next integer and past it.
  const places = lattice(12, 12, 0.02);
  const ranges = assignZoomRanges(places);
  for (let zoom = 4; zoom <= MAX_LABEL_ZOOM - 2; zoom++) {
    const live = liveAt(places, ranges, zoom);
    for (const deeper of [zoom + 0.5, zoom + 1, zoom + 2]) {
      const boxes = live.map((p) => boxAt(p, worldSizeAt(deeper)));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          assert.ok(!hits(boxes[i], boxes[j]), `${live[i].key}/${live[j].key} clash at z${deeper}`);
        }
      }
    }
  }
});

test('zooming in only adds names, except where one hands over', () => {
  const places = lattice(12, 12, 0.02, 3).concat(
    lattice(6, 6, 0.04, 4).map((p) => ({ ...p, key: `h${p.key}` })),
  );
  const ranges = assignZoomRanges(places);

  for (let zoom = 0; zoom < MAX_LABEL_ZOOM; zoom++) {
    const before = new Set(liveAt(places, ranges, zoom).map((p) => p.key));
    const after = new Set(liveAt(places, ranges, zoom + 1).map((p) => p.key));
    for (const key of before) {
      if (after.has(key)) continue;
      assert.equal(
        ranges.max.get(key),
        zoom + 1,
        `${key} left the map at z${zoom + 1} without handing over`,
      );
    }
  }
});

test('a name hands over once, and never comes back', () => {
  const places = lattice(10, 10, 0.02, 2).concat(
    lattice(10, 10, 0.02, 4).map((p, i) => ({ ...p, key: `h${i}` })),
  );
  const ranges = assignZoomRanges(places);
  for (const [key, max] of ranges.max) {
    assert.ok(max > ranges.min.get(key)!, `${key} retires at or before it appears`);
    assert.ok(max <= MAX_LABEL_ZOOM);
  }
});

test('a name with nothing finer beneath it keeps its place', () => {
  // The half of the rule that stops retirement ever emptying a stretch of
  // ground: a name only hands over to names that are actually there.
  const alone = [place('city', [11, 46], 1, 'Solitude', 120000)];
  const withTwo = alone.concat([
    place('h1', [11.01, 46.01], 4, 'Aa'),
    place('h2', [10.99, 46.01], 4, 'Bb'),
  ]);
  const withThree = withTwo.concat([place('h3', [11.01, 45.99], 4, 'Cc')]);

  assert.equal(assignZoomRanges(alone).max.has('city'), false);
  assert.equal(assignZoomRanges(withTwo).max.has('city'), false, 'two is under the threshold');
  assert.equal(assignZoomRanges(withThree).max.has('city'), true, 'three of them take over');
});

test('a name keeps its place until the map is inside it', () => {
  // The other half. On the count alone, three frazioni around Trento are drawn
  // by z11 and the city loses its name with twenty kilometres still on screen.
  const trento = place('city', [11.12, 46.07], 1, 'Trento', 117000);
  const frazioni = ['Sardagna', 'Povo', 'Vela', 'Cadine', 'Mesiano'].map((name, i) =>
    place(`f${i}`, [11.12 + (i - 2) * 0.012, 46.07 + ((i % 2) - 0.5) * 0.02], 3, name),
  );
  const ranges = assignZoomRanges([trento, ...frazioni]);

  const handsOver = ranges.max.get('city')!;
  assert.ok(handsOver >= scaleRetireZoom(trento), 'never before the map is inside it');
  assert.ok(handsOver >= 13, 'a city a few km across is still worth naming at z12');
  const shown = [...frazioni].filter((f) => ranges.min.get(f.key)! < handsOver);
  assert.ok(shown.length >= 3, 'and only once there is something to hand over to');
});

test('the scale a name hands over at follows how much ground it covers', () => {
  const city = place('a', [11, 46], 1, 'Trento', 117000);
  const town = place('b', [11, 46], 2, 'Small', 4000);
  assert.ok(scaleRetireZoom(city) < scaleRetireZoom(town), 'a bigger place is inside sooner');
  // A village covers a few hundred metres, which the map is never inside at any
  // zoom it draws — so villages and hamlets keep their names throughout.
  assert.equal(scaleRetireZoom(place('c', [11, 46], 4, 'Vela')), Number.POSITIVE_INFINITY);
});

test('no hamlet ever hands over, because nothing is finer than one', () => {
  const places = lattice(14, 14, 0.01, 4);
  const ranges = assignZoomRanges(places);
  assert.equal(ranges.max.size, 0);
});

test('the answer does not depend on the order the places arrive in', () => {
  const places = lattice(11, 11, 0.02, 3).concat(
    lattice(5, 5, 0.05, 1).map((p) => ({ ...p, key: `c${p.key}`, population: 20000 })),
  );
  const shuffled = [...places].reverse();
  const one = assignZoomRanges(places);
  const two = assignZoomRanges(shuffled);
  assert.deepEqual([...one.min].sort(), [...two.min].sort());
  assert.deepEqual([...one.max].sort(), [...two.max].sort());
});

test('every name is drawable somewhere', () => {
  // Crowded out even at the deepest zoom, a name is drawn there anyway: a
  // settlement the map refuses to name at all is worse than a rare overlap.
  const places = lattice(20, 20, 0.0005);
  const ranges = assignZoomRanges(places);
  assert.equal(ranges.min.size, places.length);
  for (const zoom of ranges.min.values()) assert.ok(zoom <= MAX_LABEL_ZOOM);
});

test('importance is tiered, then by size, then stable', () => {
  const town = place('n2', [11, 46], 2, 'Town', 900);
  const bigVillage = place('n1', [11, 46], 3, 'Village', 8000);
  assert.ok(compareImportance(town, bigVillage) < 0, 'the tier is hard');

  const big = place('n9', [11, 46], 4, 'Big', 500);
  const small = place('n1', [11, 46], 4, 'Small', 100);
  assert.ok(compareImportance(big, small) < 0);

  const a = place('n1', [11, 46], 4, 'A');
  const b = place('n2', [11, 46], 4, 'B');
  assert.ok(compareImportance(a, b) < 0 && compareImportance(b, a) > 0);
  assert.equal(compareImportance(a, a), 0);
});

test('population survives how mappers actually write it', () => {
  assert.equal(parsePopulation('3.404'), 3404, 'Italian thousands dot');
  assert.equal(parsePopulation('15 932'), 15932, 'thin space');
  assert.equal(parsePopulation('17 abitanti'), 17);
  assert.equal(parsePopulation('unknown'), 0);
  assert.equal(parsePopulation(undefined), 0);
  assert.equal(parsePopulation('0'), 0);
});

test('a territory is the ground a name speaks for, not a fixed radius', () => {
  const city = place('a', [11, 46], 1, 'Trento', 117000);
  const hamlet = place('b', [11, 46], 4, 'Vela', 900);
  assert.ok(territoryKm(city) > territoryKm(hamlet));
  assert.ok(territoryKm(city) > 3 && territoryKm(city) < 5, 'Trento is a few km across');
  // An untagged place still gets one, from its rank.
  assert.ok(territoryKm(place('c', [11, 46], 2, 'Town')) > territoryKm(hamlet));
});
