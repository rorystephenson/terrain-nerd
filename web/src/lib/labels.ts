/**
 * Measures the ink a label puts on the screen, so the pipeline and the renderer
 * agree on how much room a name takes.
 *
 * There used to be a collision pass here too — MapLibre's symbol layers
 * collide-avoid for free, but the whole style is deliberately symbol-free, so
 * labels are HTML markers and the thinning had to happen in app code. Doing it
 * per frame against a viewport-clipped candidate list is what made place names
 * churn while panning, so the choice moved offline to `pipeline/src/placeZoom.ts`
 * and every settlement now ships the zooms it may be drawn at. What is left here
 * is the box model both ends measure with, and the screen-edge test.
 *
 * Kept free of MapLibre and DOM so it can be tested directly.
 */

export type Screen = { x: number; y: number };
export type Rect = { x1: number; y1: number; x2: number; y2: number };

/**
 * Rough on-screen size of a label, in pixels.
 *
 * Duplicated in `pipeline/src/placeZoom.ts`, which thins names against these
 * numbers long before the browser sees them, and pinned to it by
 * `placeZoom.test.ts` — a mismatch would silently produce a map whose names
 * overlap or are needlessly sparse, with nothing to catch it.
 */
export const LABEL_BOX = { charWidth: 7.2, padding: 14, height: 20, gap: 4 } as const;

/**
 * Per-rank size, from the font sizes in `styles.css`: 0.95rem for a city down to
 * 0.7rem for a hamlet, against the 0.74rem base the flat `charWidth` was fitted
 * to. One width for all four ranks under-measured city names by a quarter.
 */
export const RANK_SCALE = [1.28, 1.14, 1.0, 0.95] as const;

export const scaleForRank = (rank: number): number => RANK_SCALE[rank - 1] ?? 1;

/**
 * The ink a label puts on the screen.
 *
 * Markers are anchored by their bottom edge, so a label hangs above its point
 * and is centred on it. An estimate of the text's width rather than a
 * measurement, deliberately: it is wanted before the label exists in the DOM,
 * and it only has to be close.
 */
export function labelRect(at: Screen, text: string, scale = 1): Rect {
  const { charWidth, padding, height } = LABEL_BOX;
  const halfWidth = (text.length * charWidth * scale + padding) / 2;
  return { x1: at.x - halfWidth, y1: at.y - height * scale, x2: at.x + halfWidth, y2: at.y };
}

/** Does a rectangle overlap the screen at all? */
const reaches = (rect: Rect, size: { width: number; height: number }): boolean =>
  rect.x2 >= 0 && rect.y2 >= 0 && rect.x1 <= size.width && rect.y1 <= size.height;

/**
 * Does any part of the label reach the screen?
 *
 * The test has to be the label's rectangle, never its anchor point. A point
 * test holds a name back until its *centre* crosses the edge, so a label whose
 * text is already well over the map is still not drawn — and since the anchor
 * is up to half a label's width behind the ink, the name appears to pop into
 * existence some way in from the edge instead of sliding in from it.
 */
export function labelReachesScreen(
  at: Screen,
  text: string,
  size: { width: number; height: number },
  scale = 1,
): boolean {
  return reaches(labelRect(at, text, scale), size);
}
