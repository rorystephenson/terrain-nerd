<script lang="ts">
  import Nav from './Nav.svelte';
  import Share from './Share.svelte';
  import type { PoolIndex, QuizSpec } from './types.ts';

  type Props = {
    /** Null until the pool index lands; this screen opens without waiting for it. */
    index: PoolIndex | null;
    quizzes: QuizSpec[];
    /** Best first-try percentage per quiz id. */
    best: Record<string, number>;
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
            <!--
              Drawn, not typed. These were `⇪ ✎ ×` before, which render at three
              different sizes across platforms and reach a screen reader as
              punctuation.
            -->
            <button
              class="icon"
              class:on={sharing === quiz.id}
              title="Share"
              aria-label="Share {quiz.name}"
              onclick={() => (sharing = sharing === quiz.id ? null : quiz.id)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 10.5V2m0 0L5 5m3-3 3 3" />
                <path d="M3 9.5v3.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5" />
              </svg>
            </button>
            <button class="icon" title="Edit" aria-label="Edit {quiz.name}" onclick={() => onedit(quiz)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5Z" />
              </svg>
            </button>
            <button class="icon" title="Delete" aria-label="Delete {quiz.name}" onclick={() => ondelete(quiz)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
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
  .quizzes li { display: flex; gap: 0.3rem; }
  .quizzes li.panel { display: block; }
  .tag {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted); padding: 0.12rem 0.4rem;
    background: rgba(0, 0, 0, 0.06); border-radius: var(--r-pill);
  }
  .missing {
    margin: 0 0 1rem; padding: 0.7rem 0.85rem; font-size: 0.85rem; line-height: 1.5;
    color: var(--muted); background: var(--quiet); border-radius: var(--r);
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
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
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
    border-radius: var(--r-pill);
    color: var(--surface);
    background: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .best.perfect { background: var(--right); }

  .icon {
    display: grid;
    place-items: center;
    width: 2.2rem;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    cursor: pointer;
  }
  .icon svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .icon:hover { color: var(--ink); border-color: var(--hairline-strong); }
  .icon.on { color: var(--surface); background: var(--accent); border-color: var(--accent); }

  /*
   * On a phone the three icon buttons leave the name about 250px, which broke
   * every real quiz name across three lines. The meta drops under the name
   * instead: the name is what you are looking for, and the score and the count
   * are what you check once you have found it.
   */
  @media (max-width: 30rem) {
    .row { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
    .icon { width: 2rem; }
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

  footer {
    min-height: 1lh;
    margin-top: 1.75rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
