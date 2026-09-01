/**
 * Which settlement names may be drawn, and where to fetch them from.
 *
 * Place names are always on. They are the only thing on the map allowed to name
 * anything — the features being quizzed never are — so they are what you orient
 * by, both while picking an area and while playing. Making them optional only
 * ever produced a quiz you could not find your way around.
 *
 * Nothing here decides which names win. That is settled once for the whole
 * country in `pipeline/src/placeZoom.ts`, in world pixels, with no viewport in
 * sight; every settlement ships the zooms it may be drawn at. So the answer to
 * "may this name be shown" reads one number off the feature and one off the map,
 * and there is no ordering, no eviction and nothing left to cascade. Panning
 * cannot change a verdict, because nothing in the verdict looks at where the
 * viewport sits.
 */
import type { PlaceFeature } from './types.ts';

/**
 * Old pools have no zoom range. Synthesised from rank so a map built before the
 * thinning existed still draws something — denser and overlapping, but honestly
 * stale rather than silently half-broken. `loadIndex` warns when it sees one.
 */
const LEGACY_MINZOOM = [0, 8, 10, 12];

export function zoomRangeOf(place: PlaceFeature): { minzoom: number; maxzoom: number } {
  const { minzoom, maxzoom, rank } = place.properties;
  return {
    minzoom: minzoom ?? LEGACY_MINZOOM[rank - 1] ?? 12,
    maxzoom: maxzoom ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * A name is drawn from the zoom it was thinned in at until the zoom it hands
 * over to finer names, if it ever does.
 *
 * The floor has to be a floor and never a rounding. The offline pass validated
 * each integer zoom's set against itself, and world pixel distances double per
 * zoom while label boxes do not — so that set is still clear of itself at every
 * fractional zoom above the integer, and at none below it.
 */
export function visibleAtZoom(place: PlaceFeature, zoom: number): boolean {
  const { minzoom, maxzoom } = zoomRangeOf(place);
  return zoom >= minzoom && zoom < maxzoom;
}

/** How far past the screen edge a name's anchor can sit and still be needed. */
export const PLACE_FETCH_PAD_PX = 400;

/**
 * The ground to fetch names for: the view, plus enough for a name whose anchor
 * is off screen but whose text is not.
 *
 * In pixels, not as a fraction of the span. The fraction it replaced was worth a
 * different number of pixels on each axis of every window shape, and on the
 * vertical axis of any window shorter than about 900px it fell short of the
 * reach a label actually has — so names that should have been on screen were
 * never loaded. Degrees per pixel comes from the reported view and the canvas,
 * which is exact on both axes without re-deriving Mercator here.
 *
 * Unlike everything above, this does *not* have to be independent of the
 * viewport. It only decides what is loaded; anything loaded that fails
 * `visibleAtZoom` is simply not drawn. Over-fetching is now wasteful rather than
 * destabilising, which is a real reduction in what has to be got right.
 *
 * An unmeasured canvas gets no pad rather than a guessed one. A pad in pixels is
 * meaningless without a canvas to measure them against, and treating zero as one
 * pixel turned a valley into a box eighty degrees across — which touches every
 * cell in the country, so opening the builder downloaded the entire settlement
 * pool, twelve megabytes of it, before drawing a single name. Callers should
 * hold off until the map has reported its size; this makes doing so anyway cost
 * a missing edge label rather than the whole pool.
 */
export function placeFetchBox(
  view: [number, number, number, number],
  canvas: { width: number; height: number },
): [number, number, number, number] {
  if (canvas.width <= 0 || canvas.height <= 0) return view;
  const lon = PLACE_FETCH_PAD_PX * ((view[2] - view[0]) / canvas.width);
  const lat = PLACE_FETCH_PAD_PX * ((view[3] - view[1]) / canvas.height);
  return [view[0] - lon, view[1] - lat, view[2] + lon, view[3] + lat];
}

/** How much of a zoom level a name takes to fade in, or to hand over. */
export const FADE_ZOOMS = 0.25;

/**
 * How solidly a name is drawn at this zoom.
 *
 * Fades inward from both ends of the range, never across either. Drawing a name
 * below its `minzoom` would place it at less than the separation the offline
 * pass validated; holding one past its `maxzoom` would put it on top of whatever
 * reclaimed the space. Fading inward is the only choice that keeps the map's
 * promise that nothing drawn overlaps anything else drawn.
 */
export function opacityAtZoom(place: PlaceFeature, zoom: number): number {
  const { minzoom, maxzoom } = zoomRangeOf(place);
  return Math.max(0, Math.min(1, (zoom - minzoom) / FADE_ZOOMS, (maxzoom - zoom) / FADE_ZOOMS));
}
