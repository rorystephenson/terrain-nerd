<script lang="ts">
  import type { AnsweredQuestion } from './quiz.ts';

  type Props = {
    answers: AnsweredQuestion[];
    zoneLabel: string;
    /** Best first-try score on this zone before today's round, if any. */
    previousBest: number | undefined;
    correct: number;
    solved: number;
    total: number;
    pct: number;
    onreplay: () => void;
    onmenu: () => void;
    /** Folded away so the finished map can be studied. */
    collapsed: boolean;
    ontoggle: () => void;
    nameOf: (id: string) => string;
  };

  let {
    answers,
    zoneLabel,
    previousBest,
    correct,
    solved,
    total,
    pct,
    onreplay,
    onmenu,
    collapsed,
    ontoggle,
    nameOf,
  }: Props = $props();

  const beaten = $derived(previousBest !== undefined && pct > previousBest);

  const verdict = $derived(
    pct === 100 ? 'Perfect round.'
    : pct >= 80 ? 'Strong — you know this valley system.'
    : pct >= 50 ? 'Getting there.'
    : 'Plenty left to learn.',
  );
</script>

{#if collapsed}
  <button class="restack" onclick={ontoggle}>
    <span class="mini-pct">{pct}%</span>
    <span class="mini-zone">{zoneLabel}</span>
    <span class="mini-hint">Show results</span>
  </button>
{:else}
  <div class="overlay">
    <div class="card">
      <div class="head">
        <p class="zone">{zoneLabel}</p>
        <button class="collapse" onclick={ontoggle} title="Hide and study the map">
          Study map ↓
        </button>
      </div>
      <p class="pct">{pct}%</p>
      <p class="tally">
        {correct} of {total} found first try
        {#if solved > correct}· {solved} without being shown{/if}
      </p>
      <p class="verdict">
        {verdict}
        {#if beaten}<span class="pb">New best — was {previousBest}%</span>
        {:else if previousBest !== undefined}<span class="pb dim">Best {previousBest}%</span>{/if}
      </p>

      <ul class="review">
        {#each answers as answer (answer.targetId)}
          <li class:hit={answer.firstTry} class:near={!answer.revealed && !answer.firstTry}>
            <span class="mark" aria-hidden="true">
              {answer.firstTry ? '✓' : answer.revealed ? '✗' : '~'}
            </span>
            <span class="name">{answer.name}</span>
            {#if answer.misses.length > 0}
              <span class="given">
                {answer.revealed
                  ? `shown · last picked ${nameOf(answer.misses[answer.misses.length - 1] ?? '')}`
                  : `${answer.misses.length} ${answer.misses.length === 1 ? 'miss' : 'misses'}`}
              </span>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="actions">
        <button class="ghost" onclick={onmenu}>Other areas</button>
        <button onclick={onreplay}>Replay this area</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgba(30, 36, 44, 0.45);
    backdrop-filter: blur(3px);
  }
  .card {
    width: min(30rem, 100%);
    max-height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #fff;
    border-radius: 14px;
    padding: 1.5rem;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.3);
  }
  .head,
  .zone,
  .pct,
  .tally,
  .verdict,
  .actions {
    flex: 0 0 auto;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  .collapse {
    flex: 0 0 auto;
    padding: 0;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
    background: none;
    border: 0;
    cursor: pointer;
  }
  .collapse:hover { color: var(--accent); filter: none; }
  .restack {
    position: absolute;
    left: 50%;
    bottom: 1.1rem;
    transform: translateX(-50%);
    z-index: 10;
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    padding: 0.6rem 1rem;
    font: inherit;
    background: #fff;
    border: 0;
    border-radius: 30px;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.25);
    cursor: pointer;
  }
  .restack:hover { filter: brightness(0.98); }
  .mini-pct { font-size: 1.1rem; font-weight: 700; }
  .mini-zone {
    max-width: 11rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .mini-hint { font-size: 0.78rem; font-weight: 600; color: var(--accent); }
  .zone {
    margin: 0 0 0.15rem;
    font-size: 0.82rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .pct {
    margin: 0;
    font-size: 3.6rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .tally { margin: 0.35rem 0 0; color: var(--muted); }
  .verdict { margin: 0.15rem 0 1rem; color: var(--muted); }

  .review {
    list-style: none;
    margin: 0 0 1.1rem;
    padding: 0;
    /*
     * `min-height: 0` is what actually makes this scroll: a flex child's
     * default `min-height: auto` refuses to shrink below its content, so the
     * list would grow past the card and push the buttons off screen instead of
     * overflowing internally.
     */
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
  }
  .review li {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.42rem 0;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    font-size: 0.92rem;
  }
  .mark { color: var(--wrong); font-weight: 700; width: 1ch; }
  .hit .mark { color: var(--right); }
  .near .mark { color: #b8860b; }
  .name { flex: 1; }
  .given { color: var(--muted); font-size: 0.82rem; }

  .actions { display: flex; gap: 0.5rem; }
  .pb {
    display: inline-block;
    margin-left: 0.35rem;
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--right);
  }
  .pb.dim { color: var(--muted); font-weight: 600; }
  button {
    flex: 1;
    padding: 0.75rem 1rem;
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: 9px;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .ghost {
    flex: 0 1 auto;
    color: var(--muted);
    background: transparent;
    border: 1px solid rgba(0, 0, 0, 0.15);
  }
  .ghost:hover { filter: none; color: #1d232b; border-color: rgba(0, 0, 0, 0.3); }
</style>
