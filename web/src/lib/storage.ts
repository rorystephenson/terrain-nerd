/**
 * Per-device UI state, in localStorage.
 *
 * Quizzes and best scores are **not** here. They live in Firestore and nowhere
 * else — see `session.svelte.ts` for why the mirror that used to sit alongside
 * them was removed. What is left is the state that is genuinely about *this
 * browser* rather than about the account: which explainers have had their one
 * showing, and the id minted for a new quiz.
 *
 * Every access is wrapped: private browsing and blocked site data throw on
 * plain reads, and an explainer reappearing is not a reason to interrupt
 * someone mid-build. Failures degrade to "it just doesn't persist".
 */
const SEEN_KEY = 'terrain-nerd:seen';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Explainers that have already had their one showing.
 *
 * The builder's panels each carry a paragraph saying how that step works. It is
 * worth reading once and is dead weight forever after — and on a phone it is
 * dead weight occupying a third of the panel, above the controls it explains.
 * So each is shown until it has been, and then the space goes back to the map.
 *
 * Stored per explainer rather than as one "has built a quiz before" flag,
 * because the two steps are not necessarily met together: someone editing a
 * saved quiz lands straight on the features panel and may never have seen the
 * area one.
 *
 * Per device on purpose. It is about what this screen has already shown you,
 * not about who you are, so it does not belong in the account.
 */
export const hasSeen = (id: string): boolean =>
  read<Record<string, boolean>>(SEEN_KEY, {})[id] === true;

export function markSeen(id: string): void {
  const seen = read<Record<string, boolean>>(SEEN_KEY, {});
  if (seen[id]) return;
  write(SEEN_KEY, { ...seen, [id]: true });
}

export const newQuizId = (): string =>
  `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
