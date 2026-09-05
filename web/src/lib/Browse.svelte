<script lang="ts">
  import { session } from './session.svelte.ts';
  import type { Published } from './codec.ts';
  import type { QuizSpec } from './types.ts';

  type Props = {
    onplay: (published: Published) => void;
    onback: () => void;
    /** Your own quizzes, so a row can say you already have it. */
    mine: QuizSpec[];
  };
  let { onplay, onback, mine }: Props = $props();

  type Tab = 'popular' | 'new' | 'near';

  let tab = $state<Tab>('popular');
  let loading = $state(true);
  let found = $state.raw<Published[]>([]);
  let failed = $state(false);

  /** Only offered when there is ground to be near. */
  const hasGround = $derived(session.myCells.length > 0);

  $effect(() => {
    const wanted = tab;
    let cancelled = false;
    loading = true;
    failed = false;
    session
      .discover(wanted)
      .then((quizzes) => {
        if (cancelled) return;
        found = quizzes;
        loading = false;
      })
      .catch(() => {
        if (cancelled) return;
        failed = true;
        loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  const held = $derived(new Set(mine.map((quiz) => quiz.id)));

  const summary = (quiz: Published) => {
    const bits = [`${quiz.questions} ${quiz.questions === 1 ? 'question' : 'questions'}`];
    if (quiz.players > 0) {
      bits.push(`${quiz.players} ${quiz.players === 1 ? 'player' : 'players'}`);
    }
    return bits.join(' · ');
  };
</script>

<div class="browse">
  <header>
    <button class="back" onclick={onback}>← Your quizzes</button>
    <h1>Quizzes people have shared</h1>
  </header>

  <nav>
    <button class:on={tab === 'popular'} onclick={() => (tab = 'popular')}>Most played</button>
    <button class:on={tab === 'new'} onclick={() => (tab = 'new')}>New</button>
    {#if hasGround}
      <button class:on={tab === 'near'} onclick={() => (tab = 'near')}>Your ground</button>
    {/if}
  </nav>

  {#if loading}
    <p class="muted">Looking…</p>
  {:else if failed}
    <p class="muted">Could not reach the quiz list. Yours are all still here.</p>
  {:else if found.length === 0}
    <p class="muted">
      {#if tab === 'near'}
        Nothing published over the ground your own quizzes cover — yet.
      {:else}
        Nothing published yet. Build a quiz and share it, and it will be the first.
      {/if}
    </p>
  {:else}
    <ul>
      {#each found as quiz (quiz.spec.id)}
        <li>
          <button class="row" onclick={() => onplay(quiz)}>
            <span class="name">
              {quiz.spec.name}
              {#if held.has(quiz.spec.id)}<span class="tag">yours</span>{/if}
            </span>
            <span class="meta">
              <span class="by">{quiz.ownerName}</span>
              <span class="count">{summary(quiz)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
    <p class="note">
      <!--
        Said plainly because the number is easy to read as rounds played, which
        it deliberately is not: replaying a quiz all afternoon never moves it.
      -->
      Player counts are people who have finished a round, not rounds.
    </p>
  {/if}
</div>

<style>
  .browse {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    padding: clamp(1.25rem, 4vw, 2.5rem) 1.25rem 2rem;
    max-width: 44rem;
    margin: 0 auto;
  }
  header { margin-bottom: 1.25rem; }
  .back {
    font: inherit;
    font-size: 0.85rem;
    color: var(--muted);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .back:hover { color: #1d232b; }
  h1 { margin: 0.5rem 0 0; font-size: clamp(1.4rem, 4vw, 1.8rem); letter-spacing: -0.02em; }

  nav { display: flex; gap: 0.4rem; margin-bottom: 1rem; }
  nav button {
    flex: 1;
    padding: 0.5rem;
    font: inherit;
    font-size: 0.85rem;
    color: var(--muted);
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    cursor: pointer;
  }
  nav button.on { color: #fff; background: var(--accent); border-color: var(--accent); font-weight: 650; }

  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.8rem 0.9rem;
    font: inherit;
    text-align: left;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 9px;
    cursor: pointer;
  }
  .row:hover { border-color: var(--accent); background: #fbfdfb; }
  .name { font-weight: 550; }
  .tag {
    margin-left: 0.4rem;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0.12rem 0.4rem;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 20px;
  }
  .meta { display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem; }
  .by { font-size: 0.8rem; color: #1d232b; }
  .count { font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }

  .muted {
    margin: 1.5rem 0 0;
    padding: 1.25rem;
    color: var(--muted);
    text-align: center;
    line-height: 1.55;
    background: rgba(0, 0, 0, 0.03);
    border-radius: 10px;
  }
  .note { margin: 0.9rem 0 0; font-size: 0.78rem; color: var(--muted); text-align: center; }
</style>
