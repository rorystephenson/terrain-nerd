<script lang="ts">
  import Nav from './Nav.svelte';
  import Share from './Share.svelte';
  import type { Status } from './session.svelte.ts';
  import type { PoolIndex, QuizSpec } from './types.ts';

  type Props = {
    /** Null until the pool index lands; this screen opens without waiting for it. */
    index: PoolIndex | null;
    quizzes: QuizSpec[];
    /** Best first-try percentage per quiz id. */
    best: Record<string, number>;
    /**
     * Whether the quizzes have arrived yet.
     *
     * They come from the account rather than from this browser, so on a cold
     * load there is a moment where the right answer is neither a list nor "no
     * quizzes yet" — and telling somebody who has twenty quizzes that they have
     * none, for as long as a round trip takes, is the one thing this must not
     * do.
     */
    status: Status;
    onbuild: () => void;
    onbrowse: () => void;
    onplay: (quiz: QuizSpec) => void;
    onedit: (quiz: QuizSpec) => void;
    ondelete: (quiz: QuizSpec) => void;
    /** A link pointed at a quiz that is not there any more. */
    missing: boolean;
  };

  let {
    index,
    quizzes,
    best,
    status,
    onbuild,
    onbrowse,
    onplay,
    onedit,
    ondelete,
    missing,
  }: Props = $props();

  const total = $derived(index?.kinds.reduce((sum, kind) => sum + kind.count, 0) ?? 0);

  /** Which quiz has its share panel open, if any. */
  let sharing = $state<string | null>(null);

  /** Which row has its actions menu open. One at a time, by construction. */
  let menuFor = $state<string | null>(null);
  let menuEl = $state<HTMLElement | null>(null);
  /** The button the open menu belongs to, so Escape can hand focus back to it. */
  let trigger: HTMLButtonElement | null = null;

  function openMenu(quizId: string, event: MouseEvent) {
    trigger = event.currentTarget as HTMLButtonElement;
    menuFor = menuFor === quizId ? null : quizId;
  }

  function closeMenu(returnFocus = false) {
    menuFor = null;
    if (returnFocus) trigger?.focus();
    trigger = null;
  }

  /** Opening the menu puts the keyboard in it; there is nowhere else to be. */
  $effect(() => {
    menuEl?.querySelector('button')?.focus();
  });

  $effect(() => {
    if (!menuFor) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The trigger toggles itself, so leave it alone and let its own click run.
      if (menuEl?.contains(target as Node) || target?.closest('.more')) return;
      closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu(true);
    };
    addEventListener('pointerdown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', onDown);
      removeEventListener('keydown', onKey);
    };
  });

  /** Up and down walk the menu, which is what a menu is expected to do. */
  function onMenuKey(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menuEl?.querySelectorAll('button') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }
</script>

<div class="picker">
  <Nav onhome={null} {onbuild} {onbrowse} />

  <!--
    The hero is a frame of the app, not a picture of one: `tools/hero/capture.mjs`
    photographs a real first question over real terrain. The map render is the
    most characteristic thing this app owns, and until now the home page was the
    one screen that showed none of it.
  -->
  <section class="hero">
    <picture>
      <source media="(max-width: 40rem)" srcset="/hero/hero-narrow.webp" />
      <source srcset="/hero/hero.webp 1600w, /hero/hero@2x.webp 3200w" />
      <img src="/hero/hero.webp" alt="" width="1600" height="827" fetchpriority="high" />
    </picture>

    <div class="pitch">
      <h1>Know the terrain better than the locals.</h1>
      <div class="start">
        <button class="play" onclick={onbrowse}>Play</button>
        <button class="build" onclick={onbuild}>Build a quiz</button>
      </div>
    </div>
  </section>

  <div class="body">
    {#if missing}
      <p class="missing">
        That link does not lead anywhere any more — the quiz may have been unpublished.
        Everything below is still yours.
      </p>
    {/if}

    {#if status === 'loading' && quizzes.length === 0}
      <p class="waiting" aria-live="polite">
        <span class="spinner" aria-hidden="true"></span>
        Fetching your quizzes…
      </p>
    {:else if status === 'error' && quizzes.length === 0}
      <p class="empty">
        Your quizzes could not be fetched. They are safe — this browser just
        cannot reach them right now. Try again in a moment.
      </p>
    {:else if quizzes.length > 0}
      <h2>Your quizzes</h2>
      <ul class="quizzes">
        {#each quizzes as quiz (quiz.id)}
          <li>
            <div class="row" class:row--menu={menuFor === quiz.id}>
              <button class="open" onclick={() => onplay(quiz)}>
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
                class="more"
                aria-haspopup="menu"
                aria-expanded={menuFor === quiz.id}
                aria-label="Actions for {quiz.name}"
                onclick={(event) => openMenu(quiz.id, event)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="3.2" r="1.35" />
                  <circle cx="8" cy="8" r="1.35" />
                  <circle cx="8" cy="12.8" r="1.35" />
                </svg>
              </button>
            </div>

            {#if menuFor === quiz.id}
              <!--
                Labelled, because the three glyphs this replaced were a guess
                every time — and one of them deletes the quiz.
              -->
              <!-- `tabindex` so the role is focusable in principle; focus actually
                   lands on the first item, and the arrow keys bubble up to here. -->
              <div class="menu" role="menu" tabindex="-1" bind:this={menuEl} onkeydown={onMenuKey}>
                <button
                  role="menuitem"
                  onclick={() => {
                    sharing = sharing === quiz.id ? null : quiz.id;
                    closeMenu();
                  }}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 10.5V2m0 0L5 5m3-3 3 3" />
                    <path d="M3 9.5v3.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5" />
                  </svg>
                  Share
                </button>
                <button
                  role="menuitem"
                  onclick={() => {
                    closeMenu();
                    onedit(quiz);
                  }}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5Z" />
                  </svg>
                  Edit
                </button>
                <button
                  role="menuitem"
                  class="danger"
                  onclick={() => {
                    closeMenu();
                    ondelete(quiz);
                  }}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" />
                  </svg>
                  Delete
                </button>
              </div>
            {/if}
          </li>
          {#if sharing === quiz.id}
            <li class="panel"><Share {quiz} onclose={() => (sharing = null)} /></li>
          {/if}
        {/each}
      </ul>
    {:else}
      <p class="empty">
        No quizzes yet. Build one for the area you fly most — pick the peaks and valleys you
        actually want to know, and skip the rest.
      </p>
    {/if}

    <!-- Holds its line before the index arrives, so nothing above it jumps. -->
    <footer>
      {#if index}
        {total.toLocaleString()} named features · {index.attribution} · data {index.generatedAt}
      {/if}
    </footer>
  </div>
</div>

<style>
  .picker {
    /* One measure and one gutter for the whole screen: the hero copy and the
       quiz rows below it have to start on the same vertical, or the page has no
       spine and the image reads as pasted on. */
    --measure: 44rem;
    --gutter: clamp(1.1rem, 4vw, 2rem);

    position: absolute;
    inset: 0;
    overflow-y: auto;
  }

  /*
   * Full bleed, and deliberately taller than a banner: the terrain is the
   * argument for the product, so it gets the room to be looked at rather than
   * skimmed past. Capped so it never pushes the quiz list off a laptop screen.
   */
  .hero {
    position: relative;
    background: #dfe3d8;
  }
  .hero img {
    display: block;
    width: 100%;
    height: clamp(19rem, 48vh, 28rem);
    object-fit: cover;
    /* Where the capture is most legible: ridges and passes, not the flat valley. */
    object-position: 32% 38%;
  }

  /*
   * The copy sits on the image, over a scrim that resolves into the page ground
   * rather than stopping at an edge — so the terrain reads as the top of the
   * page rather than as a picture pasted onto it.
   */
  .pitch {
    position: absolute;
    inset: auto 0 0;
    padding: 5rem var(--gutter) clamp(1.3rem, 2.5vw, 1.8rem);
    background: linear-gradient(
      to bottom,
      rgba(236, 238, 232, 0) 0%,
      rgba(236, 238, 232, 0.5) 34%,
      rgba(236, 238, 232, 0.88) 62%,
      var(--paper) 88%
    );
  }
  /* Same width the list rows get, centred the same way, so both share an edge. */
  .pitch > * {
    max-width: calc(var(--measure) - 2 * var(--gutter));
    margin-inline: auto;
  }

  /*
   * Lettered the way the map letters a summit: ink in a paper halo, no plate.
   * That convention is already in `styles.css` for `.map-place`, and borrowing
   * it here is what keeps the headline legible without washing the terrain out
   * under a heavier scrim — the type sits *on* the ground rather than on a bar
   * laid over it.
   */
  h1 {
    margin: 0;
    max-width: 22ch;
    font-size: clamp(1.9rem, 5.2vw, 3.1rem);
    font-weight: 700;
    font-stretch: 84%;
    line-height: 1.06;
    letter-spacing: -0.015em;
    text-wrap: balance;
    paint-order: stroke fill;
    -webkit-text-stroke: 0.1em rgba(236, 238, 232, 0.88);
  }

  .start { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1.2rem; }
  /*
   * Playing somebody else's quiz is the shortest route to the thing this app
   * does, and it needs no ground picked first. Building one is the answer to
   * "not the area I wanted", which is a second visit's question.
   */
  .play {
    padding: 0.8rem 2rem;
    font: inherit;
    font-weight: 650;
    color: var(--surface);
    /* The violet the hero's own markers are wearing: on this page the button
       and the unanswered peaks behind it are the same invitation. 7:1 on white. */
    background: var(--violet);
    border: 0;
    border-radius: var(--r-md);
    cursor: pointer;
  }
  /* Darker, not lighter. The map lightens a feature on hover, but that step
     lands at 3.3:1 under white text, which a button cannot afford. */
  .play:hover { background: var(--violet-deep); }
  .build {
    padding: 0.8rem 1.1rem;
    font: inherit;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--r-md);
    cursor: pointer;
  }
  .build:hover { border-color: var(--accent); }

  .body {
    max-width: var(--measure);
    margin: 0 auto;
    padding: 1.5rem var(--gutter) 2.5rem;
  }

  h2 {
    margin: 0 0 0.6rem;
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--muted);
  }

  .quizzes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  /* Anchors the actions menu to the row it belongs to. */
  .quizzes li { position: relative; }
  .tag {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted); padding: 0.12rem 0.4rem;
    background: rgba(0, 0, 0, 0.06); border-radius: var(--r-pill);
  }
  .missing {
    margin: 0 0 1rem; padding: 0.7rem 0.85rem; font-size: 0.85rem; line-height: 1.5;
    color: var(--muted); background: var(--quiet); border-radius: var(--r);
  }
  /*
   * The card is the container now, not the button. Playing and the actions menu
   * are two buttons inside one border — a button inside a button is not markup
   * a browser will keep, and the menu has to live on the row, not beside it.
   */
  .row {
    display: flex;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
  }
  .row:hover,
  .row--menu { border-color: var(--accent); }
  .row:hover { background: #fbfdfb; }

  .open {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-width: 0;
    padding: 0.8rem 0.2rem 0.8rem 0.9rem;
    font: inherit;
    text-align: left;
    color: inherit;
    background: none;
    border: 0;
    border-radius: var(--r) 0 0 var(--r);
    cursor: pointer;
  }
  .name { font-weight: 550; }
  .meta { display: flex; align-items: center; gap: 0.55rem; }
  .count { font-size: 0.78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .best {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.12rem 0.45rem;
    border-radius: var(--r-pill);
    color: var(--surface);
    background: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .best.perfect { background: var(--right); }

  .more {
    display: grid;
    place-items: center;
    align-self: stretch;
    width: 2.6rem;
    color: var(--muted);
    background: none;
    border: 0;
    border-radius: 0 var(--r) var(--r) 0;
    cursor: pointer;
  }
  .more svg { width: 1.05rem; height: 1.05rem; fill: currentColor; }
  .more:hover { color: var(--ink); background: var(--quiet); }
  .row--menu .more { color: var(--ink); background: var(--quiet); }

  .menu {
    position: absolute;
    top: calc(100% + 0.25rem);
    right: 0;
    z-index: 5;
    min-width: 10.5rem;
    padding: 0.25rem;
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: var(--r-md);
    box-shadow: var(--lift-panel);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    font: inherit;
    font-size: 0.9rem;
    text-align: left;
    color: var(--ink);
    background: none;
    border: 0;
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .menu button:hover { background: var(--quiet); }
  .menu svg {
    flex: none;
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    color: var(--muted);
  }
  /* The one item here that cannot be undone, said in the colour that means so. */
  .menu .danger,
  .menu .danger svg { color: var(--wrong); }
  .menu .danger:hover { background: rgba(214, 69, 69, 0.08); }

  /*
   * On a phone the three icon buttons leave the name about 250px, which broke
   * every real quiz name across three lines. The meta drops under the name
   * instead: the name is what you are looking for, and the score and the count
   * are what you check once you have found it.
   */
  @media (max-width: 30rem) {
    .open { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
  }

  .empty {
    margin: 0;
    padding: 1.25rem;
    color: var(--muted);
    text-align: center;
    line-height: 1.55;
    background: rgba(0, 0, 0, 0.03);
    border-radius: var(--r-md);
  }

  /*
   * Same box as `.empty`, so the one becoming the other does not move the page.
   * The list below is the only thing that should change height when the
   * quizzes land.
   */
  .waiting {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: 1.25rem;
    color: var(--muted);
    line-height: 1.55;
    background: rgba(0, 0, 0, 0.03);
    border-radius: var(--r-md);
  }

  .spinner {
    width: 0.9em;
    height: 0.9em;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    opacity: 0.7;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(1turn);
    }
  }

  /* A spinner is decoration; a reader who has asked for stillness keeps it. */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  footer {
    min-height: 1lh;
    margin-top: 1.75rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
