<script lang="ts">
  import { shareUrl } from './route.ts';
  import { session } from './session.svelte.ts';
  import type { Published } from './codec.ts';
  import type { QuizSpec } from './types.ts';

  type Props = { quiz: QuizSpec; onclose: () => void };
  let { quiz, onclose }: Props = $props();

  let phase = $state<'loading' | 'ready' | 'working'>('loading');
  let published = $state<Published | null>(null);
  let error = $state<string | null>(null);
  let copied = $state(false);

  const account = $derived(session.account);
  const link = $derived(published ? shareUrl(location.origin, quiz.id) : '');

  /**
   * Whether the quiz has moved on since it was last published.
   *
   * Compared on the feature set rather than on a timestamp: reopening the
   * builder and changing nothing should not make a quiz look stale, and
   * `updatedAt` moves whether or not anything did.
   */
  const changed = $derived(
    published !== null &&
      (published.spec.name !== quiz.name ||
        published.spec.features.length !== quiz.features.length ||
        published.spec.features.some((ref, i) => ref.id !== quiz.features[i]?.id)),
  );

  $effect(() => {
    const id = quiz.id;
    let cancelled = false;
    session
      .published(id)
      .then((found) => {
        if (cancelled) return;
        published = found;
        phase = 'ready';
      })
      .catch(() => {
        if (!cancelled) phase = 'ready';
      });
    return () => {
      cancelled = true;
    };
  });

  async function doPublish() {
    phase = 'working';
    error = null;
    try {
      await session.publish(quiz);
      published = await session.published(quiz.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      phase = 'ready';
    }
  }

  async function doUnpublish() {
    phase = 'working';
    try {
      await session.unpublish(quiz.id);
      published = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      phase = 'ready';
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 1800);
    } catch {
      // Clipboard refused — the link is on screen and selectable anyway.
    }
  }

  /** The system share sheet where there is one; it is much the better thing on a phone. */
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = () =>
    navigator.share({ title: quiz.name, text: `A Terrain Nerd quiz: ${quiz.name}`, url: link }).catch(() => {});
</script>

<div class="sheet">
  <header>
    <h3>{quiz.name}</h3>
    <button class="x" onclick={onclose} aria-label="Close">×</button>
  </header>

  {#if phase === 'loading'}
    <p class="muted">Checking…</p>
  {:else if account?.anonymous}
    <p class="muted">
      Sharing a quiz needs an account, so it has an author and stays reachable. Your quizzes
      and scores are safe on this device either way.
    </p>
  {:else if quiz.source === 'shared'}
    <p class="muted">This quiz is someone else's. You can play and keep it, but not republish it.</p>
  {:else if published}
    <p class="muted">
      Published as version {published.version} · {published.questions}
      {published.questions === 1 ? 'question' : 'questions'} ·
      {published.players} {published.players === 1 ? 'player' : 'players'}
    </p>
    <div class="link"><input readonly value={link} onfocus={(e) => e.currentTarget.select()} /></div>
    <div class="row">
      <button class="go" onclick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
      {#if canShare}<button onclick={share}>Share…</button>{/if}
    </div>
    {#if changed}
      <!--
        A published quiz is frozen, so an edit here has not reached anyone. Say
        so plainly rather than quietly diverging.
      -->
      <p class="stale">
        This quiz has changed since it was published. Publishing again makes version
        {published.version + 1}; the link stays the same, and scores already earned are kept.
      </p>
      <button class="go wide" onclick={doPublish} disabled={phase === 'working'}>
        Publish the changes
      </button>
    {/if}
    <button class="quiet" onclick={doUnpublish} disabled={phase === 'working'}>
      Stop sharing
    </button>
  {:else}
    <p class="muted">
      Publishing freezes the quiz as it stands and gives it a link. Editing it afterwards does
      not change what people already have until you publish again.
    </p>
    <button class="go wide" onclick={doPublish} disabled={phase === 'working'}>
      {phase === 'working' ? 'Publishing…' : 'Publish and get a link'}
    </button>
  {/if}

  {#if error}<p class="bad">{error}</p>{/if}
</div>

<style>
  .sheet {
    margin: 0.4rem 0 0.6rem;
    padding: 0.9rem 1rem;
    background: #fff;
    border: 1px solid var(--accent);
    border-radius: 10px;
  }
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h3 { margin: 0; font-size: 0.95rem; }
  .x {
    font: inherit; font-size: 1.2rem; line-height: 1; color: var(--muted);
    background: none; border: 0; cursor: pointer; padding: 0 0.2rem;
  }
  .muted { margin: 0.5rem 0 0.7rem; font-size: 0.85rem; color: var(--muted); line-height: 1.5; }
  .link { margin: 0 0 0.5rem; }
  .link input {
    width: 100%; padding: 0.5rem 0.6rem; font: inherit; font-size: 0.82rem;
    color: #1d232b; background: rgba(0, 0, 0, 0.04);
    border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 7px;
  }
  .row { display: flex; gap: 0.5rem; }
  button {
    padding: 0.55rem 0.8rem; font: inherit; background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.15); border-radius: 8px; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .go { color: #fff; background: var(--accent); border-color: var(--accent); font-weight: 650; }
  .wide { width: 100%; }
  .quiet {
    width: 100%; margin-top: 0.5rem; color: var(--muted);
    background: none; border-color: rgba(0, 0, 0, 0.1);
  }
  .stale {
    margin: 0.7rem 0 0.5rem; padding: 0.5rem 0.65rem; font-size: 0.82rem; line-height: 1.5;
    color: var(--muted); background: rgba(0, 0, 0, 0.04); border-radius: 7px;
  }
  .bad { margin: 0.5rem 0 0; font-size: 0.82rem; color: var(--wrong); }
</style>
