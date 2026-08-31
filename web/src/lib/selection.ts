/**
 * The crop frame the builder picks an area with.
 *
 * All of it is screen-space arithmetic — pixels on the map canvas, no MapLibre
 * and no DOM — so it is directly testable, the same way `builder.ts` is. The
 * map only ever turns the finished rectangle into longitudes and latitudes.
 *
 * The frame lives in pixels rather than in degrees on purpose. Both rules it
 * has to keep are stated about the screen: it must stay big enough to grab and
 * far enough from the window edge to grab *around*, and a rule stated in
 * degrees would be worth a different number of pixels at every zoom. Holding
 * it still on screen also means zooming in to check what you have caught is a
 * look, not an edit — the frame is a viewfinder over ground that moves under
 * it.
 */

/** A rectangle on the map canvas, in CSS pixels from its top-left corner. */
export type Rect = { left: number; top: number; right: number; bottom: number };

/** Which part of the frame a drag has hold of. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * The smallest frame, in pixels.
 *
 * Two fingertips' worth: below this the opposite handles are close enough that
 * you cannot tell which one you grabbed, and the area is too small to hold a
 * quiz's worth of ground at any sensible zoom anyway.
 */
export const MIN_SIDE_PX = 120;

/** How far the frame stays clear of the window edge, so handles can be grabbed. */
const EDGE_MARGIN_PX = 28;
const EDGE_MARGIN_SHARE = 0.05;

export type Inset = { top: number; right: number; bottom: number; left: number };

const clamp = (value: number, lo: number, hi: number) =>
  lo > hi ? (lo + hi) / 2 : Math.min(Math.max(value, lo), hi);

export const widthOf = (rect: Rect) => rect.right - rect.left;
export const heightOf = (rect: Rect) => rect.bottom - rect.top;

export const sameRect = (a: Rect, b: Rect) =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

/**
 * The ground the frame may cover: the canvas, less a margin on every side and
 * less whatever chrome is drawn over the map.
 *
 * The margin is a share of the canvas with a pixel floor, for the reason the
 * pan slack in `MapView` is: a fixed count of pixels is a tenth of a desktop
 * window and a quarter of a phone's, and what it has to be worth is a grab.
 */
export function regionFor(
  size: { width: number; height: number },
  inset: Partial<Inset> = {},
): Rect {
  const margin = Math.max(EDGE_MARGIN_PX, EDGE_MARGIN_SHARE * Math.min(size.width, size.height));
  const left = margin + (inset.left ?? 0);
  const top = margin + (inset.top ?? 0);
  return {
    left,
    top,
    right: Math.max(size.width - margin - (inset.right ?? 0), left),
    bottom: Math.max(size.height - margin - (inset.bottom ?? 0), top),
  };
}

/** The minimum a side may shrink to here — never more than the region holds. */
const floorFor = (region: Rect) => ({
  width: Math.min(MIN_SIDE_PX, widthOf(region)),
  height: Math.min(MIN_SIDE_PX, heightOf(region)),
});

/**
 * A frame with nothing to inherit from: the whole region.
 *
 * Deliberately not a smaller default. Everything in view is what the builder
 * offered before there was a frame at all, so opening on the largest legal
 * frame changes nobody's first quiz — trimming is the new move, and one the
 * handles advertise on their own.
 */
export const defaultRect = (region: Rect): Rect => ({ ...region });

/** Puts a frame back inside the region, keeping its size where it can. */
export function clampRect(rect: Rect, region: Rect): Rect {
  const floor = floorFor(region);
  const width = clamp(widthOf(rect), floor.width, widthOf(region));
  const height = clamp(heightOf(rect), floor.height, heightOf(region));
  const left = clamp(rect.left, region.left, region.right - width);
  const top = clamp(rect.top, region.top, region.bottom - height);
  return { left, top, right: left + width, bottom: top + height };
}

/**
 * One handle dragged by `dx, dy` pixels.
 *
 * Moved by the drag's distance rather than snapped to the pointer, so grabbing
 * a handle anywhere in its generous hit area does not jerk the edge to the
 * middle of your finger. Each edge is clamped between the region it may not
 * leave and the opposite edge it may not come within `MIN_SIDE_PX` of, which
 * is what stops a drag past the far side from turning the frame inside out.
 */
export function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number, region: Rect): Rect {
  const floor = floorFor(region);
  let { left, top, right, bottom } = rect;

  if (handle.includes('w')) left = clamp(left + dx, region.left, right - floor.width);
  if (handle.includes('e')) right = clamp(right + dx, left + floor.width, region.right);
  if (handle.includes('n')) top = clamp(top + dy, region.top, bottom - floor.height);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + floor.height, region.bottom);

  return { left, top, right, bottom };
}

/**
 * Carries a frame across a change of region — a resized window, a rotated
 * phone — by where it sat in the old one rather than by its pixels.
 *
 * Scaling rather than clamping because the two read differently: a frame round
 * the top half of a window is still round the top half after the window
 * changes shape, where a clamped one would slide to wherever it still fitted
 * and quietly select different ground.
 */
export function scaleRect(rect: Rect, from: Rect, to: Rect): Rect {
  const fx = widthOf(from) || 1;
  const fy = heightOf(from) || 1;
  const kx = widthOf(to) / fx;
  const ky = heightOf(to) / fy;
  return clampRect(
    {
      left: to.left + (rect.left - from.left) * kx,
      top: to.top + (rect.top - from.top) * ky,
      right: to.left + (rect.right - from.left) * kx,
      bottom: to.top + (rect.bottom - from.top) * ky,
    },
    to,
  );
}

/**
 * Padding that lands an existing area inside the region with room to grow.
 *
 * Reopening a quiz has to show the frame the quiz was built with, so the map is
 * fitted to that area first and the frame set to wherever it landed. Fitting it
 * flush to the region would leave every handle against a limit and the area
 * only shrinkable; the extra slack is what makes "change the area" mean either
 * direction. Capped so a tall panel on a short window cannot ask for more
 * padding than there is canvas.
 */
export function fitPadding(size: { width: number; height: number }, region: Rect): Inset {
  const slack = 0.14 * Math.min(widthOf(region), heightOf(region));
  const cap = (near: number, far: number, extent: number) => {
    const room = Math.max(0.45 * extent, 0);
    const share = near + far > 0 ? Math.min(1, room / (near + far)) : 1;
    return { near: near * share, far: far * share };
  };
  const x = cap(region.left + slack, size.width - region.right + slack, size.width);
  const y = cap(region.top + slack, size.height - region.bottom + slack, size.height);
  return { left: x.near, right: x.far, top: y.near, bottom: y.far };
}
