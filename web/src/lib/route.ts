/**
 * Where the app is, as a URL.
 *
 * There was no router at all: every screen was a value in `App.svelte` and the
 * address bar never moved. That was fine while a quiz could not leave the
 * browser that built it — there was nothing to link *to*. A published quiz is a
 * thing you hand to someone, so it needs an address.
 *
 * Two forms are accepted and only one is produced. `/q/<id>` is what gets
 * shared, and needs the host to rewrite unknown paths to `index.html`.
 * `?q=<id>` is understood as well, costs three lines, and means a link still
 * works somewhere that has no such rewrite — `vite preview`, a plain static
 * bucket, a file server someone is trying the app out on. Producing only the
 * pretty one keeps the shared form consistent; accepting both keeps it working.
 *
 * Pure, so `node --test` can hold it: nothing here touches `location` or
 * `history` — see `bind` in `App.svelte` for the half that does.
 */

export type Route =
  | { at: 'list' }
  | { at: 'browse' }
  | { at: 'build'; quizId: string | null }
  /** A published quiz, by id. `version` addresses an exact frozen copy. */
  | { at: 'quiz'; quizId: string; version?: number };

/** Ids are minted by `newQuizId` or by Firestore; both are alphanumerics and dashes. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const versionOf = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/**
 * Reads a route out of a URL, falling back to the list.
 *
 * Anything unrecognised is the list rather than an error. A URL is the one
 * input that arrives mangled by other people's software — trimmed by a chat
 * client, wrapped by a mail scanner — and a stranger's first sight of the app
 * should not be a message about a malformed path.
 */
export function parseRoute(href: string): Route {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { at: 'list' };
  }

  const query = url.searchParams.get('q');
  if (query && ID.test(query)) {
    return { at: 'quiz', quizId: query, version: versionOf(url.searchParams.get('v')) };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'q' && ID.test(parts[1])) {
    return { at: 'quiz', quizId: parts[1], version: versionOf(url.searchParams.get('v')) };
  }
  if (parts.length === 1 && parts[0] === 'browse') return { at: 'browse' };
  if (parts.length === 1 && parts[0] === 'build') return { at: 'build', quizId: null };
  if (parts.length === 2 && parts[0] === 'build' && ID.test(parts[1])) {
    return { at: 'build', quizId: parts[1] };
  }

  return { at: 'list' };
}

/** The address of a route, always in the shareable form. */
export function routeUrl(route: Route): string {
  switch (route.at) {
    case 'list':
      return '/';
    case 'browse':
      return '/browse';
    case 'build':
      return route.quizId ? `/build/${route.quizId}` : '/build';
    case 'quiz':
      return route.version === undefined ? `/q/${route.quizId}` : `/q/${route.quizId}?v=${route.version}`;
  }
}

/** A link worth sending someone, given wherever the app is being served from. */
export const shareUrl = (origin: string, quizId: string, version?: number): string =>
  origin.replace(/\/$/, '') + routeUrl({ at: 'quiz', quizId, version });

export const sameRoute = (a: Route, b: Route): boolean => routeUrl(a) === routeUrl(b);
