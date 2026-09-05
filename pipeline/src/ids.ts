/**
 * Watching the feature ids for movement.
 *
 * A quiz is a list of ids into this pool, and a *published* quiz is a permanent
 * one that other people hold. So an id that changes between builds is not a
 * detail — it is a feature quietly falling out of somebody's quiz, with nothing
 * anywhere to say it happened.
 *
 * The ids are stable in practice, which is what makes this the right place to
 * check rather than the client. A peak or a pass is one OSM node and keeps that
 * node's id for as long as it exists; most valleys are a single way and do the
 * same. The exception is a valley merged from several ways, which takes the
 * lowest of their ids — about one in eight — and moves only if that particular
 * way is deleted or a lower-numbered one joins the cluster.
 *
 * So instead of every client carrying a fallback for a rare event forever, the
 * build stops once, in front of the person who caused it, and says what moved.
 * The manifest is committed, so the answer to "what changed" is a diff.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';

import { ID_MANIFEST } from './paths.ts';

export type IdCheck = {
  /** Ids the previous build had and this one does not. These break quizzes. */
  gone: string[];
  /** Ids this build has and the previous one did not. Ordinary growth. */
  added: string[];
  kept: number;
};

/** The kind prefix, for reporting: `valley/w123` -> `valley`. */
const kindOf = (id: string) => id.slice(0, id.indexOf('/'));

export async function readManifest(): Promise<Set<string> | null> {
  try {
    const text = await readFile(ID_MANIFEST, 'utf8');
    return new Set(text.split('\n').filter(Boolean));
  } catch {
    // No manifest yet: a first build, or a checkout that has never run one.
    return null;
  }
}

export async function writeManifest(ids: readonly string[]): Promise<void> {
  // Sorted, one per line, so a change reads as a diff rather than a reshuffle.
  const body = [...ids].sort().join('\n') + '\n';
  const temp = `${ID_MANIFEST}.tmp`;
  await writeFile(temp, body);
  await rename(temp, ID_MANIFEST);
}

export function compareIds(before: Set<string>, after: readonly string[]): IdCheck {
  const now = new Set(after);
  const gone = [...before].filter((id) => !now.has(id)).sort();
  const added = after.filter((id) => !before.has(id)).sort();
  return { gone, added, kept: after.length - added.length };
}

/** `valley 123, peak 4` — enough to tell a coverage change from an id shift. */
export function byKind(ids: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(kindOf(id), (counts.get(kindOf(id)) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${kind} ${n.toLocaleString()}`).join(', ');
}

export function report(check: IdCheck): string {
  const lines = [
    `  ids: ${check.kept.toLocaleString()} unchanged` +
      (check.added.length > 0 ? `, ${check.added.length.toLocaleString()} new (${byKind(check.added)})` : '') +
      (check.gone.length > 0 ? `, ${check.gone.length.toLocaleString()} GONE (${byKind(check.gone)})` : ''),
  ];
  if (check.gone.length > 0) {
    for (const id of check.gone.slice(0, 10)) lines.push(`    - ${id}`);
    if (check.gone.length > 10) lines.push(`    …and ${check.gone.length - 10} more`);
  }
  return lines.join('\n');
}
