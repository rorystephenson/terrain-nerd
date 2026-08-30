/**
 * How much settlement detail to show, and where to fetch it from.
 *
 * Place names are always on. They are the only thing on the map allowed to name
 * anything — the features being quizzed never are — so they are what you orient
 * by, both while picking an area and while playing. Making them optional only
 * ever produced a quiz you could not find your way around.
 *
 * The level follows the scale being looked at, never the viewport's position,
 * so panning at a fixed zoom cannot change which names are eligible. That is
 * half of what keeps labels stable; `labels.ts` handles the other half.
 */

/** Fetch places a little beyond the view, so labels can collide across the edge. */
export const PLACE_PAD = 0.35;

/**
 * Villages across half a country is noise; cities alone in one valley tells you
 * nothing. Scale the granularity to the span being looked at.
 */
export function levelFor(box: [number, number, number, number]): number {
  const span = Math.max(box[2] - box[0], box[3] - box[1]);
  if (span > 3) return 1; // most of a country: cities only
  if (span > 1.2) return 2; // a region: towns
  if (span > 0.25) return 3; // a valley system: villages, which is where the
  return 4; //                  useful names live — Pinzolo, Madonna di Campiglio
}
