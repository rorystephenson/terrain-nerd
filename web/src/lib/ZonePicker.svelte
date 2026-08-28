<script lang="ts">
  import type { Group, QuizManifest, Tier, Zone } from './types.ts';

  type Props = {
    manifest: QuizManifest;
    /** Best first-try percentage per zone id. */
    best: Record<string, number>;
    onpick: (group: Group, tier: Tier, zone: Zone) => void;
  };

  let { manifest, best, onpick }: Props = $props();

  let chosen = $state<string | null>(null);
  const group = $derived(manifest.groups.find((g) => g.id === chosen) ?? manifest.groups[0]);
</script>

<div class="picker">
  <header>
    <h1>Terrain Nerd</h1>
    <p class="lede">{manifest.regionLabel}</p>
    <p class="hint">
      Pick an area. Every round asks the same set in a new order, so you can replay one
      until you know it. Four tries a question, then you are shown the answer and have to
      go and click it.
    </p>
  </header>

  <div class="tabs" role="tablist">
    {#each manifest.groups as candidate (candidate.id)}
      <button
        role="tab"
        aria-selected={candidate.id === group?.id}
        class:active={candidate.id === group?.id}
        onclick={() => (chosen = candidate.id)}
      >
        {candidate.label}
      </button>
    {/each}
  </div>

  {#if group}
    {#each group.tiers as tier (tier.id)}
      <p class="blurb">{tier.description}</p>
      <ul class="zones">
        {#each tier.zones as zone (zone.id)}
          <li>
            <button onclick={() => onpick(group, tier, zone)}>
              <span class="name">{zone.label}</span>
              <span class="meta">
                {#if best[zone.id] !== undefined}
                  <span class="best" class:perfect={best[zone.id] === 100}>{best[zone.id]}%</span>
                {/if}
                <span class="count">{zone.questionCount}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/each}
  {/if}

  <footer>{manifest.attribution} · data generated {manifest.generatedAt}</footer>
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

  .tabs {
    display: flex;
    gap: 0.4rem;
    margin: 1.75rem 0 0;
    padding: 0.25rem;
    background: rgba(0, 0, 0, 0.055);
    border-radius: 10px;
  }
  .tabs button {
    flex: 1;
    padding: 0.6rem 0.5rem;
    font: inherit;
    font-weight: 600;
    text-transform: capitalize;
    color: var(--muted);
    background: transparent;
    border: 0;
    border-radius: 7px;
    cursor: pointer;
  }
  .tabs button.active {
    color: #1d232b;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }

  .blurb { margin: 0.9rem 0 0.6rem; color: var(--muted); font-size: 0.9rem; }

  .zones { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  .zones button {
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
  .zones button:hover { border-color: var(--accent); background: #fbfdfb; }
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

  footer {
    margin-top: 1.75rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
