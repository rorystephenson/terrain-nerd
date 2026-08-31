import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampRect,
  defaultRect,
  fitPadding,
  MIN_SIDE_PX,
  regionFor,
  resizeRect,
  scaleRect,
  type Rect,
} from './selection.ts';

const size = { width: 1000, height: 800 };
const region = regionFor(size);

test('the region keeps the frame clear of every window edge', () => {
  // 5% of the shorter side, which beats the 28px floor on a window this big.
  assert.deepEqual(region, { left: 40, top: 40, right: 960, bottom: 760 });
});

test('a small window falls back to the pixel floor, not to a hairline', () => {
  // 5% of 320 is 16px, which is not enough to get a finger around.
  assert.deepEqual(regionFor({ width: 360, height: 320 }), {
    left: 28,
    top: 28,
    right: 332,
    bottom: 292,
  });
});

test('chrome drawn over the map is ground the frame may not use', () => {
  const docked = regionFor(size, { bottom: 200 });
  assert.equal(docked.bottom, 560);
  assert.equal(docked.top, 40, 'the other sides are untouched');
});

test('a region with no room left collapses rather than inverting', () => {
  const squeezed = regionFor({ width: 400, height: 300 }, { bottom: 900 });
  assert.ok(squeezed.bottom >= squeezed.top, 'bottom never crosses top');
});

test('the frame opens on everything it is allowed to have', () => {
  // The builder offered the whole view before there was a frame; opening on
  // the largest legal one keeps that as the default and makes trimming opt-in.
  assert.deepEqual(defaultRect(region), region);
});

test('dragging a corner outwards stops at the region', () => {
  const rect: Rect = { left: 300, top: 300, right: 600, bottom: 600 };
  assert.deepEqual(resizeRect(rect, 'nw', -400, -400, region), {
    left: 40,
    top: 40,
    right: 600,
    bottom: 600,
  });
  assert.deepEqual(resizeRect(rect, 'se', 900, 900, region), {
    left: 300,
    top: 300,
    right: 960,
    bottom: 760,
  });
});

test('an edge handle moves only its own edge', () => {
  const rect: Rect = { left: 300, top: 300, right: 600, bottom: 600 };
  assert.deepEqual(resizeRect(rect, 'e', -50, -50, region), {
    left: 300,
    top: 300,
    right: 550,
    bottom: 600,
  });
  assert.deepEqual(resizeRect(rect, 'n', 40, 40, region), {
    left: 300,
    top: 340,
    right: 600,
    bottom: 600,
  });
});

test('a drag past the far side leaves the minimum, not an inside-out frame', () => {
  const rect: Rect = { left: 300, top: 300, right: 600, bottom: 600 };
  const pulled = resizeRect(rect, 'w', 900, 0, region);
  assert.equal(pulled.left, 600 - MIN_SIDE_PX);
  assert.equal(pulled.right, 600, 'the edge it was dragged towards did not move');

  const pushed = resizeRect(rect, 's', -900, -900, region);
  assert.equal(pushed.bottom, 300 + MIN_SIDE_PX);
});

test('a region too small for the minimum is filled rather than overflowed', () => {
  // A phone in landscape with a tall panel: there is less room than the
  // minimum asks for, and the frame has to fit the room that exists.
  const tight = regionFor({ width: 700, height: 300 }, { bottom: 160 });
  const rect = resizeRect({ ...tight }, 'n', 200, 200, tight);
  assert.ok(rect.top >= tight.top && rect.bottom <= tight.bottom);
  assert.ok(rect.bottom - rect.top > 0, 'the frame keeps a positive height');
});

test('clamping brings a stray frame back without resizing it needlessly', () => {
  const rect: Rect = { left: 800, top: 600, right: 1100, bottom: 900 };
  const held = clampRect(rect, region);
  assert.deepEqual(held, { left: 660, top: 460, right: 960, bottom: 760 });
});

test('clamping shrinks a frame that cannot fit the region', () => {
  const held = clampRect({ left: 0, top: 0, right: 4000, bottom: 4000 }, region);
  assert.deepEqual(held, region);
});

test('a resized window carries the frame by where it sat, not by its pixels', () => {
  // The right half of the region stays the right half, rather than sliding to
  // wherever the old pixels still happened to fit.
  const rect: Rect = { left: 500, top: 400, right: 960, bottom: 760 };
  const wider = regionFor({ width: 1400, height: 800 });
  const moved = scaleRect(rect, region, wider);
  assert.equal(moved.right, wider.right);
  assert.ok(Math.abs((moved.left - wider.left) / (wider.right - wider.left) - 0.5) < 1e-9);
});

test('a frame scaled into a region too small for it is clamped as well', () => {
  const rect: Rect = { ...region };
  const tiny = regionFor({ width: 300, height: 240 });
  const moved = scaleRect(rect, region, tiny);
  assert.deepEqual(moved, tiny);
});

test('fit padding leaves the area inside the region with room to grow', () => {
  const pad = fitPadding(size, region);
  assert.ok(pad.left > region.left, 'clears the region and then some');
  assert.ok(pad.bottom > size.height - region.bottom);
  assert.ok(pad.left + pad.right < size.width, 'never asks for more than the canvas');
});

test('fit padding is capped when chrome has already eaten the window', () => {
  const short = { width: 380, height: 420 };
  const docked = regionFor(short, { bottom: 240 });
  const pad = fitPadding(short, docked);
  assert.ok(pad.top + pad.bottom <= 0.45 * short.height + 1e-9);
  assert.ok(pad.left + pad.right <= 0.45 * short.width + 1e-9);
});
