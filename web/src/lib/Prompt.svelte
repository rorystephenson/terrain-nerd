<script lang="ts">
  import { MAX_TRIES, type Question } from './quiz.ts';

  type Feedback =
    | { kind: 'miss'; name: string; triesLeft: number }
    | { kind: 'correct'; name: string };

  type Props = {
    question: Question | null;
    feedback: Feedback | null;
    /** The tries are spent: the answer is flashing and must be clicked. */
    revealing: boolean;
    triesLeft: number;
    zoneLabel: string;
    index: number;
    total: number;
    correct: number;
    onquit: () => void;
  };

  let {
    question,
    feedback,
    revealing,
    triesLeft,
    zoneLabel,
    index,
    total,
    correct,
    onquit,
  }: Props = $props();

  const tone = $derived(
    feedback?.kind === 'correct' ? 'good' : feedback || revealing ? 'bad' : 'neutral',
  );
</script>

<div class="prompt" data-tone={tone}>
  <div class="progress">
    <button class="quit" onclick={onquit} title="Back to areas">← {zoneLabel}</button>
    <span class="pos">{Math.min(index + 1, total)} / {total}</span>
    <span class="tries" aria-label="{triesLeft} of {MAX_TRIES} tries left">
      {#each { length: MAX_TRIES } as _, i (i)}
        <span class="pip" class:spent={i >= triesLeft}></span>
      {/each}
    </span>
    <span class="pos">{correct} first-try</span>
  </div>

  <p class="ask" aria-live="polite">
    {#if revealing && question}
      {#if feedback?.kind === 'miss' && feedback.name}
        That's <strong>{feedback.name}</strong> — click the flashing one
      {:else}
        Out of tries. Click <strong>{question.name}</strong>, now flashing, to continue
      {/if}
    {:else if feedback?.kind === 'correct'}
      Correct
    {:else if feedback?.kind === 'miss'}
      {#if feedback.name}That's <strong>{feedback.name}</strong>.{:else}Nothing there.{/if}
      Try again — {feedback.triesLeft}
      {feedback.triesLeft === 1 ? 'try' : 'tries'} left
    {:else if question}
      Find <strong>{question.name}</strong>
    {/if}
  </p>

  <div class="bar" role="presentation">
    <div class="fill" style:width="{total === 0 ? 0 : (index / total) * 100}%"></div>
  </div>
</div>

<style>
  .prompt {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 5;
    padding: 0.7rem 1rem 0;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(6px);
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
    transition: background-color 150ms ease;
  }
  .prompt[data-tone='good'] { background: rgba(226, 246, 233, 0.96); }
  .prompt[data-tone='bad'] { background: rgba(252, 233, 233, 0.96); }

  .progress {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .pos { text-transform: uppercase; white-space: nowrap; }
  .quit {
    flex: 1;
    min-width: 0;
    padding: 0;
    font: inherit;
    text-align: left;
    color: var(--muted);
    background: none;
    border: 0;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quit:hover { color: var(--accent); }

  .tries { display: inline-flex; gap: 4px; }
  .pip {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    transition: background-color 180ms ease;
  }
  .pip.spent { background: rgba(0, 0, 0, 0.16); }

  .ask {
    margin: 0.25rem 0 0.55rem;
    font-size: clamp(1.05rem, 3.2vw, 1.5rem);
    line-height: 1.25;
  }
  .ask strong { font-weight: 650; }

  .bar { height: 3px; background: rgba(0, 0, 0, 0.09); }
  .fill { height: 100%; background: var(--accent); transition: width 220ms ease; }
</style>
