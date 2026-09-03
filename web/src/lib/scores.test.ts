import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dominanceTerm,
  flankTerm,
  heightTerm,
  passProminence,
  peakProminence,
} from '../../../pipeline/src/scores.ts';
import { SKYWAYS_ZOOM, sampleFlight, tilesFor, tmsY } from '../../../pipeline/src/skyways.ts';

/*
 * Scoring lives in the pipeline but is tested here, where the test runner is.
 *
 * These are the numbers the whole builder is filtered by, and none of them
 * announce themselves when wrong — a prominence that quietly favours shoulders
 * over summits just makes the quiz worse.
 */

test('height runs from sea level to four thousand metres', () => {
  assert.equal(heightTerm(0), 0);
  assert.equal(heightTerm(2000), 0.5);
  assert.equal(heightTerm(4000), 1);
  // A 4,800 m peak is not more than fully tall.
  assert.equal(heightTerm(4808), 1);
  assert.equal(heightTerm(-10), 0);
});

test('dominance is compressed, so the first kilometres carry it', () => {
  assert.equal(dominanceTerm(0), 0);
  assert.equal(dominanceTerm(40), 1);
  // Half the scale is used up by 5.3 km, which is where the difference between
  // a sub-summit and a mountain actually lives.
  assert.ok(dominanceTerm(5) > 0.45 && dominanceTerm(5) < 0.55);
  // Past the top it saturates rather than running away.
  assert.equal(dominanceTerm(200), 1);
});

test('either term at zero zeroes a peak', () => {
  // A shoulder of Mont Blanc: as tall as it gets, with something higher next
  // to it. This is the sub-summit problem, and a weighted sum would score it
  // 0.5 rather than nothing.
  assert.equal(peakProminence(4700, 0), 0);
  // A hillock with nothing higher for 40 km is still a hillock.
  assert.equal(peakProminence(0, 40), 0);
});

test('a big isolated peak scores the top of the scale', () => {
  assert.equal(peakProminence(4000, 40), 1);
});

test('the same mountain scores lower with something higher nearby', () => {
  const alone = peakProminence(3000, 20);
  const crowded = peakProminence(3000, 0.5);
  assert.ok(crowded < alone, `${crowded} should be below ${alone}`);
  // And a smaller peak that dominates its area can outrank a buried giant,
  // which is the whole point of asking for prominence rather than altitude.
  assert.ok(peakProminence(2000, 25) > peakProminence(3800, 0.4));
});

test('a pass is measured by the mountain over it, not by isolation', () => {
  assert.equal(flankTerm(0), 0);
  assert.equal(flankTerm(1200), 1);
  assert.equal(flankTerm(3000), 1);
  // A high col under real mountains beats a low one under none.
  assert.ok(passProminence(2500, 1200) > passProminence(2500, 50));
  assert.equal(passProminence(2500, 0), 0);
});

test('tms rows count from the south and round-trip', () => {
  // Getting this backwards does not fail loudly: the service just answers with
  // placeholders, and the layer silently reads as empty ground.
  assert.equal(tmsY(0, 11), 2047);
  assert.equal(tmsY(2047, 11), 0);
  assert.equal(tmsY(tmsY(1319, 11), 11), 1319);
});

test('coverage cells expand to the skyways tiles under them', () => {
  const span = 2 ** (SKYWAYS_ZOOM - 10);
  const tiles = tilesFor({ zoom: 10, cells: ['x100y200'] });
  assert.equal(tiles.length, span * span);
  assert.ok(tiles.includes(`${100 * span}/${200 * span}`));
  assert.ok(tiles.includes(`${100 * span + span - 1}/${200 * span + span - 1}`));
});

test('two cells sharing no ground produce no shared tiles', () => {
  const one = new Set(tilesFor({ zoom: 10, cells: ['x100y200'] }));
  const two = tilesFor({ zoom: 10, cells: ['x101y200'] });
  assert.ok(two.every((tile) => !one.has(tile)));
});

test('ground with no tiles scores exactly zero', () => {
  // A true zero is what makes the score filterable to nothing, which is the
  // half of the problem the old percentile could never solve.
  const raster = { worldSize: 64 * 2 ** SKYWAYS_ZOOM, cells: new Map<string, Uint8Array>() };
  assert.deepEqual([...sampleFlight(raster, [[11, 46]])], [0]);
});

test('a saturated neighbourhood samples as the top of the alpha range', () => {
  /*
   * The kernel is normalised, so a feature sitting in uniformly maximal ink
   * must read 255 rather than some multiple of it. Filling the tile the point
   * lands in plus its neighbours covers the whole kernel footprint.
   */
  const cellPx = 64;
  const worldSize = cellPx * 2 ** SKYWAYS_ZOOM;
  const cells = new Map<string, Uint8Array>();
  const at: [number, number] = [11.12, 46.07];
  const tileX = Math.floor((((at[0] + 180) / 360) * worldSize) / cellPx);
  const phi = (at[1] * Math.PI) / 180;
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * worldSize;
  const tileY = Math.floor(y / cellPx);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      cells.set(`${tileX + dx}/${tileY + dy}`, new Uint8Array(cellPx * cellPx).fill(255));
    }
  }
  const [sampled] = sampleFlight({ worldSize, cells }, [at]);
  assert.ok(Math.abs(sampled - 255) < 0.5, `expected 255, got ${sampled}`);
});

test('flight falls off with distance rather than cutting off at the summit', () => {
  /*
   * The point of a kernel at all: a track that misses a peak by a kilometre
   * still counts for something, or the score would only ever reward flying
   * directly overhead.
   */
  const cellPx = 64;
  const worldSize = cellPx * 2 ** SKYWAYS_ZOOM;
  const lat = 46;
  const phi = (lat * Math.PI) / 180;
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * worldSize;
  const tileY = Math.floor(y / cellPx);

  // One column of ink, and three points stepping away from it eastwards.
  const busyLon = 11;
  const busyPx = Math.floor((((busyLon + 180) / 360) * worldSize));
  const cells = new Map<string, Uint8Array>();
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const tile = new Uint8Array(cellPx * cellPx);
      const tileX = Math.floor(busyPx / cellPx) + dx;
      for (let py = 0; py < cellPx; py++) {
        const column = busyPx - tileX * cellPx;
        if (column >= 0 && column < cellPx) tile[py * cellPx + column] = 255;
      }
      cells.set(`${tileX}/${tileY + dy}`, tile);
    }
  }

  const degreesPerPixel = 360 / worldSize;
  const [over, near, far] = sampleFlight({ worldSize, cells }, [
    [busyLon, lat],
    [busyLon + degreesPerPixel * 4, lat],
    [busyLon + degreesPerPixel * 18, lat],
  ]);
  assert.ok(over > near, `over ${over} should beat near ${near}`);
  assert.ok(near > far, `near ${near} should beat far ${far}`);
  assert.ok(near > 0, 'a peak beside the route must not score zero');
});
