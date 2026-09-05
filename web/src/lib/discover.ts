/**
 * The arithmetic behind browsing quizzes on a map.
 *
 * The browse list could say what a quiz is called and who made it, but never
 * where on earth it was — which is most of what you want to know about someone
 * else's quiz. Every published document has carried `bbox` and `cells` since it
 * was first written; nothing had read them.
 *
 * Kept free of MapLibre and of the Firebase SDK, so it is testable under
 * `node --test` alongside the rest of `lib`. What is left in the component is
 * the map, the markers and the card.
 */
import { CELL_ZOOM } from './codec.ts';
import { cellsCovering, type BBox } from './grid.ts';
import type { Published } from './codec.ts';

/**
 * Firestore's ceiling on `array-contains-any`, which is what `listNear` asks
 * with. Not a number to tune: exceeding it is an error from the server, not a
 * slower query.
 */
export const MAX_QUERY_CELLS = 30;

/**
 * The cells to ask about for this view, or `null` when the view is too wide to
 * ask by ground at all.
 *
 * z7 cells are ~200 km, so `null` means something like half of Italy on screen
 * — a view at which "quizzes over this ground" has stopped being a useful
 * question and "the most played anywhere" is the better answer. The caller
 * switches queries rather than slicing the cell list, because a silent slice
 * would drop whole regions off the map with nothing to show it had happened.
 */
export function queryCells(view: BBox): string[] | null {
  const cells = cellsCovering(view, CELL_ZOOM);
  return cells.length > MAX_QUERY_CELLS ? null : cells;
}

/**
 * The cells in this view that have not been asked about yet.
 *
 * Panning fires constantly and most of it lands on ground already covered by a
 * previous query. Asking only for what is new turns a pan across a region into
 * a handful of queries rather than one per gesture.
 */
export const unasked = (asked: ReadonlySet<string>, wanted: readonly string[]): string[] =>
  wanted.filter((cell) => !asked.has(cell));

export const centreOf = (bbox: BBox): [number, number] => [
  (bbox[0] + bbox[2]) / 2,
  (bbox[1] + bbox[3]) / 2,
];

/** Mean degrees of latitude in km. Good to a few parts in a thousand, which is far past what "28 km across" needs. */
const KM_PER_DEGREE = 111.195;

/**
 * How far the quiz reaches, in km, along whichever axis is longer.
 *
 * The wider of the two rather than the diagonal, because it is the number
 * someone can picture: a quiz "28 km across" is a day's flying, one "3 km
 * across" is a single ridge. Longitude is shortened by the latitude, or every
 * Alpine quiz would read a third wider than it is.
 */
export function spanKm(bbox: BBox): number {
  const midLat = ((bbox[1] + bbox[3]) / 2) * (Math.PI / 180);
  const wide = (bbox[2] - bbox[0]) * Math.cos(midLat) * KM_PER_DEGREE;
  const tall = (bbox[3] - bbox[1]) * KM_PER_DEGREE;
  return Math.max(wide, tall);
}

/** Ground covered, in km². Used only to order overlapping quizzes, never shown. */
export function areaKm2(bbox: BBox): number {
  const midLat = ((bbox[1] + bbox[3]) / 2) * (Math.PI / 180);
  return (
    (bbox[2] - bbox[0]) * Math.cos(midLat) * KM_PER_DEGREE * (bbox[3] - bbox[1]) * KM_PER_DEGREE
  );
}

/**
 * The order quizzes are held and drawn in.
 *
 * Most played first, so the pin that survives a cluster is the one most people
 * have played. `publishedAt` then the id break ties, so the order is total and
 * a pan that re-finds the same quizzes cannot reshuffle them under the cursor.
 */
const byInterest = (a: Published, b: Published): number =>
  b.players - a.players ||
  b.publishedAt.localeCompare(a.publishedAt) ||
  a.spec.id.localeCompare(b.spec.id);

/**
 * What is held, plus what a query just returned.
 *
 * The map accumulates: panning away from a quiz and back should not have to
 * fetch it again, and a quiz found at one zoom should not vanish at another.
 * Incoming wins on a clash, because its counters are the fresher ones.
 */
export function mergeFound(
  held: readonly Published[],
  incoming: readonly Published[],
): Published[] {
  const byId = new Map(held.map((quiz) => [quiz.spec.id, quiz]));
  for (const quiz of incoming) byId.set(quiz.spec.id, quiz);
  return [...byId.values()].sort(byInterest);
}

/** Every quiz's ground, as a polygon the map can draw. */
export function footprints(quizzes: readonly Published[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: quizzes.map((quiz) => {
      const [w, s, e, n] = quiz.spec.bbox;
      return {
        type: 'Feature' as const,
        // Promoted to the feature id by the style, so hovering and selecting can
        // be expressed as feature state rather than by rebuilding the source.
        id: quiz.spec.id,
        properties: { id: quiz.spec.id },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      };
    }),
  };
}

/** One quiz's pin, in screen pixels. */
export type Pin = { id: string; x: number; y: number };

/**
 * How far past an edge a pin's centre may sit and still be worth drawing.
 *
 * A plate is anchored at its middle and is a little under 11rem wide at its
 * widest, so a centre this far out still has ink on the screen.
 */
export const PIN_MARGIN_PX = 100;

/**
 * The pins with any part of themselves on screen.
 *
 * Applied *before* clustering, so a quiz off the edge can neither be counted in
 * a group you can see nor become the group's representative — a plate reading
 * "3 quizzes" that flies you to ground two of which were never in view is worse
 * than no plate.
 *
 * It also has to happen at all. These are DOM buttons, so a pin left in the
 * document for a quiz five hundred kilometres away is clipped out of sight but
 * still in the tab order and still read aloud, which is a worse bug than the
 * layout it wastes.
 */
export const visiblePins = (
  pins: readonly Pin[],
  size: { width: number; height: number },
  pad = PIN_MARGIN_PX,
): Pin[] =>
  pins.filter(
    (pin) =>
      pin.x >= -pad && pin.y >= -pad && pin.x <= size.width + pad && pin.y <= size.height + pad,
  );

/** A pin, and everything close enough to it to be indistinguishable. */
export type Cluster = { at: Pin; ids: string[] };

/**
 * How close two plates have to be before they are one plate, per axis.
 *
 * An ellipse rather than a circle, because a plate is wide and short — a name
 * on a rounded rectangle, not a dot. Two of them 50 px apart *horizontally*
 * overlap almost entirely; the same 50 px vertically leaves both perfectly
 * readable, one above the other. A single radius has to choose which of those
 * to get wrong.
 */
export type Reach = { x: number; y: number };

/**
 * Pins gathered into what can actually be told apart on screen.
 *
 * Quizzes cluster hard in the places people fly — half a dozen over the same
 * valley is the normal case, not the pathological one — and six plates stacked
 * on one another is worse than no pins at all: nothing is readable and only the
 * top one can be pressed.
 *
 * A pin absorbs what is within the radius *of itself*, and never what is only
 * within the radius of something it absorbed. Chaining is single-linkage
 * clustering, and its failure is the one that matters here: a line of quizzes
 * down a valley, each near its neighbour, collapsing into a single group
 * centred on ground none of them cover.
 *
 * Greedy from the head of the list, so the caller's order decides which quiz
 * represents a group. Passed `byInterest` order, that is the most-played one,
 * which is the right thing to name when only one name fits.
 *
 * The reach is elliptical — see `Reach`. Screen pixels rather than ground
 * distance on purpose. Whether two quizzes are
 * distinguishable is a question about the picture, not about the mountains, and
 * zooming in has to separate them — which it does, for free, because the
 * projection that produced these pins already grew the gap.
 */
export function cluster(pins: readonly Pin[], reach: Reach): Cluster[] {
  const out: Cluster[] = [];
  const taken = new Set<string>();

  for (const pin of pins) {
    if (taken.has(pin.id)) continue;
    taken.add(pin.id);
    const ids = [pin.id];
    for (const other of pins) {
      if (taken.has(other.id)) continue;
      if (Math.hypot((other.x - pin.x) / reach.x, (other.y - pin.y) / reach.y) <= 1) {
        taken.add(other.id);
        ids.push(other.id);
      }
    }
    out.push({ at: pin, ids });
  }
  return out;
}

/**
 * A box containing all of these, with room around it.
 *
 * What a cluster zooms to when it is pressed, and what the map opens on. Takes
 * boxes rather than quizzes because both callers have a bbox and only one of
 * them has a published quiz — the opening view is fitted to the boxes of your
 * own drafts, which are not published and never will be.
 *
 * The pad is a fraction of the span rather than a fixed number of degrees, so
 * it stays proportionate for a cluster of adjacent quizzes and for two on
 * opposite sides of a range. The floor stops a cluster of one — or of several
 * sharing a bbox — from asking the map to fit a box of zero width.
 */
export function boundsOf(boxes: readonly BBox[], pad = 0.15): BBox | null {
  if (boxes.length === 0) return null;
  let [w, s, e, n] = boxes[0];
  for (const box of boxes.slice(1)) {
    w = Math.min(w, box[0]);
    s = Math.min(s, box[1]);
    e = Math.max(e, box[2]);
    n = Math.max(n, box[3]);
  }
  const lon = Math.max((e - w) * pad, 0.02);
  const lat = Math.max((n - s) * pad, 0.02);
  return [w - lon, s - lat, e + lon, n + lat];
}
