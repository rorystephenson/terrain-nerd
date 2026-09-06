<script lang="ts">
  import Account from './Account.svelte';

  /**
   * A null handler means "this is where you already are". The item stays in the
   * bar, because taking it out would move the ones beside it every time the
   * screen changed, but it stops being a way to go somewhere.
   */
  type Props = {
    onhome: (() => void) | null;
    onbuild: (() => void) | null;
    onbrowse: (() => void) | null;
  };
  let { onhome, onbuild, onbrowse }: Props = $props();

  /**
   * Only used to say "there is content under here" once the page has moved. The
   * bar itself is glass from the start — it sits on terrain, and a bar that is
   * transparent over a hypsometric render is a bar nobody can read.
   */
  let scrolled = $state(false);
  let sentinel = $state<HTMLElement | null>(null);

  $effect(() => {
    const target = sentinel;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => (scrolled = !entry.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  });
</script>

<span class="sentinel" bind:this={sentinel}></span>

<header class="nav" class:nav--scrolled={scrolled}>
  {#if onhome}
    <button class="wordmark" onclick={onhome}>Terrain Nerd</button>
  {:else}
    <span class="wordmark">Terrain Nerd</span>
  {/if}

  <nav>
    {#if onbrowse}
      <button class="lead" onclick={onbrowse}>Quizzes</button>
    {:else}
      <span class="lead here" aria-current="page">Quizzes</span>
    {/if}
    {#if onbuild}
      <button onclick={onbuild}>Build a quiz</button>
    {:else}
      <span class="here" aria-current="page">Build a quiz</span>
    {/if}
  </nav>

  <Account variant="nav" />
</header>

<style>
  /* Zero height, above the bar: watched to know when the page has scrolled. */
  .sentinel {
    display: block;
    height: 0;
  }

  .nav {
    position: sticky;
    top: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: clamp(0.5rem, 2.5vw, 1.5rem);
    padding: 0.6rem clamp(0.9rem, 3vw, 1.5rem);
    background: var(--glass);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid transparent;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  .nav--scrolled {
    border-bottom-color: var(--hairline);
    box-shadow: 0 1px 12px rgba(0, 0, 0, 0.06);
  }

  .wordmark {
    margin: 0;
    padding: 0;
    font: inherit;
    font-size: clamp(1rem, 2.4vw, 1.2rem);
    font-weight: 700;
    font-stretch: 78%;
    letter-spacing: 0.055em;
    text-transform: uppercase;
    color: var(--ink);
    background: none;
    border: 0;
    white-space: nowrap;
  }
  button.wordmark { cursor: pointer; }

  nav {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    /* Pushes the account control to the far edge, whatever is between. */
    margin-right: auto;
  }
  nav button,
  nav .here {
    padding: 0.35rem 0.55rem;
    font: inherit;
    font-size: 0.88rem;
    color: var(--muted);
    background: none;
    border: 0;
    border-radius: var(--r-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  nav .here {
    color: var(--ink);
    background: var(--quiet);
    cursor: default;
  }
  nav button:hover {
    color: var(--ink);
    background: var(--quiet);
  }
  /* The way in. Everything else in the bar is somewhere you go afterwards. */
  nav .lead {
    color: var(--ink);
    font-weight: 600;
  }

  @media (max-width: 34rem) {
    nav { gap: 0; }
    nav button,
    nav .here { padding: 0.35rem 0.4rem; font-size: 0.84rem; }
  }
</style>
