/**
 * Decides which labels actually get drawn.
 *
 * MapLibre's symbol layers collide-avoid for free, but the whole style is
 * deliberately symbol-free — a symbol layer needs a glyph endpoint and an API
 * key, and keeping the basemap label-free is what stops it leaking answers. So
 * labels are HTML markers, and the collision handling that symbols would have
 * given us has to happen here.
 *
 * Kept free of MapLibre and DOM so it can be tested directly.
 */

export type LabelCandidate<T> = {
  /** Higher wins when two labels collide. */
  priority: number;
  text: string;
  item: T;
  /**
   * Stable identity, used to break ties.
   *
   * Without it, equally important labels are resolved in whatever order the
   * candidates happened to arrive — which depends on which data chunks loaded
   * first, so the same map could lay out differently twice.
   */
  key?: string;
};

export type Screen = { x: number; y: number };
export type Rect = { x1: number; y1: number; x2: number; y2: number };

/** Rough on-screen size of a label, in pixels. */
const CHAR_WIDTH = 7.2;
const PADDING = 14;
const HEIGHT = 20;
/** Labels must clear each other by this much to both be drawn. */
const GAP = 4;

/**
 * The ink a label puts on the screen.
 *
 * Markers are anchored by their bottom edge, so a label hangs above its point
 * and is centred on it. An estimate of the text's width rather than a
 * measurement, deliberately: it is wanted before the label exists in the DOM,
 * and it only has to be close.
 */
export function labelRect(at: Screen, text: string): Rect {
  const halfWidth = (text.length * CHAR_WIDTH + PADDING) / 2;
  return { x1: at.x - halfWidth, y1: at.y - HEIGHT, x2: at.x + halfWidth, y2: at.y };
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
): boolean {
  return reaches(labelRect(at, text), size);
}

export type LayoutOptions = {
  /** Screen size. Only labels whose text reaches it are returned. */
  width: number;
  height: number;
  /**
   * How far beyond the screen edge to keep considering candidates, in pixels.
   *
   * This is what makes the result stable while panning. A label just off screen
   * still occupies its box and still blocks its neighbours, so scrolling it into
   * view does not suddenly evict a label that was happily drawn a moment before.
   * It needs to exceed the widest label, or a collision can be missed.
   */
  pad?: number;
  /** Safety ceiling. Density is meant to be governed by zoom and collision. */
  max: number;
};

/**
 * Greedy: strongest first, and a label is dropped if its box touches one
 * already placed.
 *
 * Greedy rather than optimal on purpose — the result has to be stable and cheap
 * on every map move, and "the important ones win ties" is the only property
 * that actually matters here.
 *
 * Stability under panning is the other property that matters, and it does not
 * come for free. The selection must depend on where things are relative to each
 * other, never on where the viewport happens to sit: candidates outside the
 * screen still take part in collisions (see `pad`), ties are broken by a stable
 * key rather than arrival order, and the ceiling is high enough that it is not
 * what decides. At a fixed zoom, panning then only moves labels in and out at
 * the edges instead of reshuffling the ones already drawn.
 */
export function layoutLabels<T>(
  candidates: LabelCandidate<T>[],
  project: (item: T) => Screen | null,
  options: LayoutOptions,
): { item: T; text: string; at: Screen }[] {
  const placed: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const out: { item: T; text: string; at: Screen }[] = [];
  const pad = options.pad ?? 0;

  const ordered = [...candidates].sort(
    (a, b) => b.priority - a.priority || (a.key ?? a.text).localeCompare(b.key ?? b.text),
  );

  for (const candidate of ordered) {
    if (out.length >= options.max) break;

    const at = project(candidate.item);
    if (!at) continue;
    if (at.x < -pad || at.y < -pad || at.x > options.width + pad || at.y > options.height + pad) {
      continue;
    }

    // The ink, and the ink plus the clearance it demands of its neighbours.
    const rect = labelRect(at, candidate.text);
    const box = {
      x1: rect.x1 - GAP,
      y1: rect.y1 - GAP,
      x2: rect.x2 + GAP,
      y2: rect.y2 + GAP,
    };

    const clashes = placed.some(
      (other) => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1,
    );
    if (clashes) continue;

    // Placed either way: a label off the edge still has to hold its ground, or
    // panning it into view would evict whatever moved in beside it.
    placed.push(box);
    // Drawn as soon as any of the name reaches the screen, so panning slides
    // labels in from the edge instead of popping them in half a width later.
    if (reaches(rect, options)) {
      out.push({ item: candidate.item, text: candidate.text, at });
    }
  }

  return out;
}
