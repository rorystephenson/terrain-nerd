<script lang="ts">
  import Account from './Account.svelte';
  import Share from './Share.svelte';
  import type { PoolIndex, QuizSpec } from './types.ts';

  type Props = {
    index: PoolIndex;
    quizzes: QuizSpec[];
    /** Best first-try percentage per quiz id. */
    best: Record<string, number>;
    onbuild: () => void;
    onplay: (quiz: QuizSpec) => void;
    onedit: (quiz: QuizSpec) => void;
    ondelete: (quiz: QuizSpec) => void;
    /** A link pointed at a quiz that is not there any more. */
    missing: boolean;
    /** Brings a quiz up to date against the pool before it is published. */
    onprepare: (quiz: QuizSpec) => Promise<QuizSpec>;
  };

  let {
    index,
    quizzes,
    best,
    onbuild,
    onplay,
    onedit,
    ondelete,
    missing,
    onprepare,
  }: Props = $props();

  const total = $derived(index.kinds.reduce((sum, kind) => sum + kind.count, 0));

  /** Which quiz has its share panel open, if any. */
  let sharing = $state<string | null>(null);
</script>

<div class="picker">
  <header>
    <h1>Terrain Nerd</h1>
    <p class="lede">Learn the terrain you fly</p>
    <p class="hint">
      Build a quiz for an area you care about, then replay it until you know it. Every round
      asks the same set in a new order. Four tries a question, then you are shown the answer
      and have to go and click it.
    </p>
    <Account />
  </header>

  {#if missing}
    <p class="missing">
      That link does not lead anywhere any more — the quiz may have been unpublished. Everything
      below is still yours.
    </p>
  {/if}

  <button class="build" onclick={onbuild}>+ Build a quiz</button>

  {#if quizzes.length > 0}
    <h2>Your quizzes</h2>
    <ul class="quizzes">
      {#each quizzes as quiz (quiz.id)}
        <li>
          <button class="row" onclick={() => onplay(quiz)}>
            <span class="name">{quiz.name}</span>
            <span class="meta">
              {#if quiz.source === 'shared'}<span class="tag">shared</span>{/if}
              {#if best[quiz.id] !== undefined}
                <span class="best" class:perfect={best[quiz.id] === 100}>{best[quiz.id]}%</span>
              {/if}
              <span class="count">{quiz.features.length}</span>
            </span>
          </button>
          <button
            class="icon"
            class:on={sharing === quiz.id}
            title="Share"
            aria-label="Share {quiz.name}"
            onclick={() => (sharing = sharing === quiz.id ? null : quiz.id)}>⇪</button>
          <button class="icon" title="Edit" aria-label="Edit {quiz.name}" onclick={() => onedit(quiz)}>✎</button>
          <button class="icon" title="Delete" aria-label="Delete {quiz.name}" onclick={() => ondelete(quiz)}>×</button>
        </li>
        {#if sharing === quiz.id}
          <li class="panel"><Share {quiz} {onprepare} onclose={() => (sharing = null)} /></li>
        {/if}
      {/each}
    </ul>
  {:else}
    <p class="empty">
      No quizzes yet. Build one for the area you fly most — pick the peaks and valleys you
      actually want to know, and skip the rest.
    </p>
  {/if}

  <footer>
    {total.toLocaleString()} named features · {index.attribution} · data {index.generatedAt}
  </footer>
</div>

<style>
  .picker {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    padding: clamp(1.25rem, 4vw, 2.5rem) 1.25rem 2rem;
    max-width: 44rem;
    margin: 0 auto;
  }
  header { text-align: center; }
  h1 { margin: 0; font-size: clamp(2rem, 7vw, 2.8rem); letter-spacing: -0.02em; }
  .lede { margin: 0.2rem 0 0; font-size: 1.1rem; color: var(--muted); }
  .hint {
    margin: 0.75rem auto 0;
    max-width: 30rem;
    color: var(--muted);
    line-height: 1.5;
    font-size: 0.95rem;
  }

  .build {
    width: 100%;
    margin: 1.75rem 0 0;
    padding: 0.85rem;
    font: inherit;
    font-weight: 650;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: 10px;
    cursor: pointer;
  }

  h2 {
    margin: 1.75rem 0 0.6rem;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .quizzes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  .quizzes li { display: flex; gap: 0.3rem; }
  .quizzes li.panel { display: block; }
  .tag {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted); padding: 0.12rem 0.4rem;
    background: rgba(0, 0, 0, 0.06); border-radius: 20px;
  }
  .missing {
    margin: 1rem 0 0; padding: 0.7rem 0.85rem; font-size: 0.85rem; line-height: 1.5;
    color: var(--muted); background: rgba(0, 0, 0, 0.04); border-radius: 9px;
  }
  .row {
    flex: 1;
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
  .meta { display: flex; align-items: center; gap: 0.55rem; }
  .count { font-size: 0.78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .best {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.12rem 0.45rem;
    border-radius: 20px;
    color: #fff;
    background: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .best.perfect { background: var(--right); }

  .icon {
    width: 2.2rem;
    font: inherit;
    font-size: 1rem;
    color: var(--muted);
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 9px;
    cursor: pointer;
  }
  .icon:hover { color: #1d232b; border-color: rgba(0, 0, 0, 0.25); }
  .icon.on { color: #fff; background: var(--accent); border-color: var(--accent); }

  .empty {
    margin: 1.5rem 0 0;
    padding: 1.25rem;
    color: var(--muted);
    text-align: center;
    line-height: 1.55;
    background: rgba(0, 0, 0, 0.03);
    border-radius: 10px;
  }


  footer {
    margin-top: 1.75rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
