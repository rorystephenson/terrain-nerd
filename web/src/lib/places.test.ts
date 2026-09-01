import assert from 'node:assert/strict';
import test from 'node:test';

import { opacityAtZoom, PLACE_FETCH_PAD_PX, placeFetchBox, visibleAtZoom } from './places.ts';
import type { PlaceFeature } from './types.ts';

const place = (
  properties: { name?: string; rank?: number; minzoom?: number; maxzoom?: number },
  at: [number, number] = [11, 46],
): PlaceFeature => ({
  type: 'Feature',
  bbox: [at[0], at[1], at[0], at[1]],
  geometry: { type: 'Point', coordinates: at },
  properties: { name: 'Somewhere', rank: 3, ...properties },
});

/** The view a landscape and a portrait window see of the same ground at one zoom. */
const landscape = { width: 1400, height: 800 };
const portrait = { width: 420, height: 900 };

test("a name's zoom is a property of the name, not of the map", () => {
  // The successor to 'the level never depends on where the viewport sits', which
  // was only approximately true: it bucketed on the view's span in degrees, and
  // a degree of latitude is worth a different number of pixels at every latitude.
  const village = place({ minzoom: 11 });
  for (const zoom of [9, 10.9, 11, 13.4]) {
    assert.equal(visibleAtZoom(village, zoom), zoom >= 11);
  }
});

test('the window shape no longer decides how much detail you get', () => {
  // This deliberately reverses 'a tall narrow view is judged by its longer side',
  // which asserted the old rule as intended. There is no longer a side to judge:
  // the map reports its zoom, and nothing about the window enters the answer.
  const village = place({ minzoom: 11 });
  assert.equal(visibleAtZoom(village, 11.5), true);
  for (const canvas of [landscape, portrait]) {
    const view: [number, number, number, number] = [
      11 - 0.1 * (canvas.width / 1000),
      46 - 0.1 * (canvas.height / 1000),
      11 + 0.1 * (canvas.width / 1000),
      46 + 0.1 * (canvas.height / 1000),
    ];
    // The fetch box changes shape with the window, as it must. What may be drawn
    // does not: it never sees the box.
    assert.ok(placeFetchBox(view, canvas)[0] < view[0]);
    assert.equal(visibleAtZoom(village, 11.5), true);
  }
});

test('panning north does not change what is eligible', () => {
  // A fixed-pixel window spans about a fifth fewer degrees of latitude in the
  // Alps than in Sicily, which is how the old rule could flip mid-pan on a
  // portrait phone and swap every hamlet for a town.
  const sicily = place({ minzoom: 12 }, [14.5, 37]);
  const alps = place({ minzoom: 12 }, [11, 47.5]);
  assert.equal(visibleAtZoom(sicily, 12.3), visibleAtZoom(alps, 12.3));
  assert.equal(visibleAtZoom(sicily, 11.7), visibleAtZoom(alps, 11.7));
});

test('a name appears as you zoom in and stays, unless it hands over', () => {
  const staying = place({ minzoom: 10 });
  const handing = place({ minzoom: 10, maxzoom: 13 });
  for (let zoom = 10; zoom <= 14; zoom += 0.5) {
    assert.equal(visibleAtZoom(staying, zoom), true);
    assert.equal(visibleAtZoom(handing, zoom), zoom < 13);
  }
});

test('a name fades inward from both ends of its range', () => {
  // Never across either edge: below `minzoom` the name would sit closer to its
  // neighbours than the thinning validated, and past `maxzoom` it would sit on
  // top of whatever reclaimed the space.
  const subject = place({ minzoom: 10, maxzoom: 13 });
  assert.equal(opacityAtZoom(subject, 9.9), 0);
  assert.equal(opacityAtZoom(subject, 10), 0);
  assert.ok(opacityAtZoom(subject, 10.1) > 0 && opacityAtZoom(subject, 10.1) < 1);
  assert.equal(opacityAtZoom(subject, 11.5), 1);
  assert.ok(opacityAtZoom(subject, 12.9) > 0 && opacityAtZoom(subject, 12.9) < 1);
  assert.equal(opacityAtZoom(subject, 13), 0);
});

test('the fetch box always covers the ink, whatever the window shape', () => {
  // The regression test for the pad this replaced, which was a fraction of the
  // view's span: worth a different number of pixels on each axis, and on the
  // vertical axis of any window shorter than about 900px it fell short of how
  // far a label's text actually reaches. Names that should have been on screen
  // were simply never loaded.
  // A phone in portrait is the tight case: 400px of pad is most of its width,
  // so anything that capped the pad as a share of the view would fail here.
  for (const canvas of [landscape, portrait, { width: 900, height: 380 }, { width: 320, height: 560 }]) {
    const view: [number, number, number, number] = [11, 46, 11.4, 46.2];
    const padded = placeFetchBox(view, canvas);

    const degPerPxLon = (view[2] - view[0]) / canvas.width;
    const degPerPxLat = (view[3] - view[1]) / canvas.height;
    assert.ok((view[0] - padded[0]) / degPerPxLon >= PLACE_FETCH_PAD_PX - 1e-9);
    assert.ok((padded[2] - view[2]) / degPerPxLon >= PLACE_FETCH_PAD_PX - 1e-9);
    assert.ok((view[1] - padded[1]) / degPerPxLat >= PLACE_FETCH_PAD_PX - 1e-9);
    assert.ok((padded[3] - view[3]) / degPerPxLat >= PLACE_FETCH_PAD_PX - 1e-9);
  }
});

test('an unmeasured canvas gets no pad rather than an unbounded one', () => {
  // Treating a canvas of zero as one pixel made the pad 400 times the view: a
  // valley became a box eighty degrees across, which touches every cell in the
  // country, so opening the builder pulled the whole settlement pool — twelve
  // megabytes — before it had drawn a name. Callers wait for the map to report;
  // this is what keeps getting that wrong cheap.
  const view: [number, number, number, number] = [10.72, 46.06, 10.94, 46.26];
  for (const canvas of [{ width: 0, height: 0 }, { width: 0, height: 800 }, { width: 1400, height: 0 }]) {
    assert.deepEqual(placeFetchBox(view, canvas), view);
  }
  // And a real canvas still pads, so the guard cannot silently swallow the pad.
  assert.notDeepEqual(placeFetchBox(view, landscape), view);
});

test('the fetch box never asks for more ground than the view it came from', () => {
  // A sanity bound on the whole family: whatever the window, the box stays the
  // same order of size as what is being looked at.
  for (const canvas of [landscape, portrait, { width: 320, height: 560 }]) {
    for (const view of [
      [10.72, 46.06, 10.94, 46.26],
      [6.6, 35.4, 18.6, 47.1],
      [11.1, 46.05, 11.12, 46.07],
    ] as [number, number, number, number][]) {
      const padded = placeFetchBox(view, canvas);
      const grew = (padded[2] - padded[0]) / (view[2] - view[0]);
      assert.ok(grew > 1 && grew < 5, `grew ${grew}x on ${canvas.width}px`);
    }
  }
});

test('a pool built before the thinning still draws something', () => {
  // Denser and overlapping, but a stale map beats a blank one, and `loadIndex`
  // says so on the console.
  const city = place({ rank: 1, minzoom: undefined });
  const hamlet = place({ rank: 4, minzoom: undefined });
  assert.equal(visibleAtZoom(city, 9), true);
  assert.equal(visibleAtZoom(hamlet, 9), false);
  assert.equal(visibleAtZoom(hamlet, 12), true);
  assert.equal(opacityAtZoom(city, 14), 1, 'nothing hands over without a maxzoom');
});
