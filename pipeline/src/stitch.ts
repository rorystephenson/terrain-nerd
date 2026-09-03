/**
 * Joins ways that continue each other into single lines.
 *
 * OSM splits a road wherever anything about it changes — a bridge, a speed
 * limit, a surface — so the Brenner motorway is not one line but hundreds of
 * fragments meeting end to end. That costs almost nothing while the geometry
 * ships whole, and everything once it has to be simplified: Douglas-Peucker
 * runs per line and cannot drop the two points a fragment is made of, so a road
 * layer of 240,000 rings averaging 2.6 points each survives simplification
 * almost intact. Measured, secondary roads kept 76% of their vertices at a
 * tolerance of 800 m, which is a tolerance that should have flattened them to
 * near nothing.
 *
 * Stitching first gives Douglas-Peucker something continuous to work on, and
 * the same 800 m then takes those roads from 485,776 vertices to 133,452.
 * Tippecanoe hits exactly the same floor for exactly the same reason, so this
 * belongs in front of it rather than instead of it.
 *
 * Pure, and deliberately conservative: it only ever joins at a point where
 * exactly two line ends meet, so a junction stays a junction and nothing is
 * invented that was not in the data.
 */
import type { LonLat } from './geo.ts';

/** Endpoints are shared node positions in the source, so they match exactly. */
const key = (point: LonLat): string => `${point[0]},${point[1]}`;

const isClosed = (line: LonLat[]): boolean =>
  line.length > 2 && key(line[0]) === key(line[line.length - 1]);

type End = { line: number; atStart: boolean };

/**
 * Merges `lines` into the longest chains that are unambiguous.
 *
 * Call it per group of things that are alike — one kind, one class — because
 * joining a motorway to the trunk road it feeds would produce a line that is
 * neither, and the renderer styles on exactly those properties.
 *
 * Rings are returned untouched: they are already whole, and a ring has no ends
 * to join anything to.
 */
export function stitch(lines: readonly LonLat[][]): LonLat[][] {
  const open: LonLat[][] = [];
  const out: LonLat[][] = [];
  for (const line of lines) {
    if (line.length < 2) continue;
    if (isClosed(line)) out.push([...line]);
    else open.push([...line]);
  }

  // Which line ends meet at each point.
  const ends = new Map<string, End[]>();
  const add = (point: LonLat, end: End) => {
    const at = key(point);
    const held = ends.get(at);
    if (held) held.push(end);
    else ends.set(at, [end]);
  };
  open.forEach((line, index) => {
    add(line[0], { line: index, atStart: true });
    add(line[line.length - 1], { line: index, atStart: false });
  });

  /**
   * The one line that continues `from` at `point`, if there is exactly one.
   *
   * Three or more ends meeting is a junction and stops the chain; one end is
   * the end of the road. Two ends of the *same* line is a loop closing on
   * itself, which is already whole.
   */
  const next = (point: LonLat, from: number): End | null => {
    const meeting = ends.get(key(point));
    if (!meeting || meeting.length !== 2) return null;
    const other = meeting.find((end) => end.line !== from);
    return other ?? null;
  };

  const used = new Array<boolean>(open.length).fill(false);
  const degree = (point: LonLat) => ends.get(key(point))?.length ?? 0;

  /** Follows the chain out of one end of `seed`, consuming what it passes. */
  const walk = (seed: number, forwards: boolean): LonLat[] => {
    used[seed] = true;
    let tail = seed;
    let chain = forwards ? [...open[seed]] : [...open[seed]].reverse();
    for (;;) {
      const step = next(chain[chain.length - 1], tail);
      if (!step || used[step.line]) break;
      used[step.line] = true;
      tail = step.line;
      const piece = step.atStart ? open[step.line] : [...open[step.line]].reverse();
      // The shared node belongs to both, so drop the copy.
      chain = chain.concat(piece.slice(1));
    }
    return chain;
  };

  // Chain ends first, so every chain is walked from a real end rather than from
  // somewhere in its middle — which would leave it split into two halves.
  for (let index = 0; index < open.length; index++) {
    if (used[index]) continue;
    const line = open[index];
    const startIsEnd = degree(line[0]) !== 2;
    if (!startIsEnd && degree(line[line.length - 1]) === 2) continue;
    out.push(walk(index, startIsEnd));
  }

  // Anything left is a closed loop of two-degree joins, with no end to start at.
  for (let index = 0; index < open.length; index++) {
    if (used[index]) continue;
    out.push(walk(index, true));
  }

  return out;
}
