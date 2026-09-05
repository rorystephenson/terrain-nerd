<script lang="ts">
  /**
   * Shared quizzes, on the ground they are about.
   *
   * The list beside it can say what a quiz is called and how many people have
   * played it, but never where it is — and where it is, is most of what you
   * want to know about somebody else's quiz. Every published document has
   * carried its `bbox` and its discovery `cells` since the day it was first
   * written. This is the screen that reads them.
   *
   * Everything with arithmetic in it lives in `discover.ts`, which has tests.
   * What is left here is the map, the pins and the card.
   */
  import maplibregl from 'maplibre-gl';
  import { untrack } from 'svelte';

  import {
    boundsOf,
    centreOf,
    cluster,
    footprints,
    visiblePins,
    mergeFound,
    queryCells,
    spanKm,
    unasked,
  } from './discover.ts';
  import { buildFootprints } from './mapStyle.ts';
  import { session } from './session.svelte.ts';
  import type { Published } from './codec.ts';
  import type { PoolIndex, QuizSpec } from './types.ts';

  type Props = {
    index: PoolIndex;
    /** Your own quizzes: they open the map on your ground, and a row can say it is yours. */
    mine: QuizSpec[];
    onplay: (published: Published) => void;
  };
  let { index, mine, onplay }: Props = $props();

  /**
   * How close two plates have to be before they are one plate.
   *
   * Wide and short, matching the plates themselves: roughly half the width a
   * name takes, and a little over the height of one, so plates that would
   * overlap are merged while plates that would merely stack are left to stack.
   */
  const PIN_REACH = { x: 62, y: 26 };

  /** Long enough that a flick across a region is one query, short enough to feel live. */
  const SETTLE_MS = 250;

  let container: HTMLDivElement;
  let map = $state.raw<maplibregl.Map | undefined>();
  /** Pending settle timer, so a flick across a region is one query and not twenty. */
  let settle: ReturnType<typeof setTimeout>;
  let found = $state.raw<Published[]>([]);
  let selectedId = $state<string | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  /** Bumped on every map move, so the pins are laid out against the new screen. */
  let viewTick = $state(0);

  /**
   * Ground already asked about, so panning back over it asks nothing.
   *
   * Deliberately not `$state`: nothing renders from it, and making it reactive
   * would put a set that every query writes into the dependencies of the effect
   * that runs the queries.
   */
  const asked = new Set<string>();

  const held = $derived(new Set(mine.map((quiz) => quiz.id)));
  const byId = $derived(new Map(found.map((quiz) => [quiz.spec.id, quiz])));
  const selected = $derived(selectedId ? (byId.get(selectedId) ?? null) : null);

  /**
   * Where the map opens.
   *
   * On your own ground when you have any — someone with two quizzes in the
   * Brenta has said plainly which mountains they care about, and landing there
   * beats landing on a country.
   *
   * With no quizzes of your own there is nothing to go on until the first query
   * answers, so it opens on the whole pool and then settles onto whatever was
   * found. See `settleOnFound`.
   */
  const opening = (): [number, number, number, number] =>
    boundsOf(
      mine.map((quiz) => quiz.bbox),
      0.4,
    ) ?? index.area;

  /**
   * Whether the opening view is still ours to change.
   *
   * A first visit opens on the whole pool, which is a country with the basemap
   * drawn over the fraction of it anyone flies — mostly the hatch that means
   * "no tiles here", with a handful of pins on it. Once the first query has
   * answered we know where the quizzes actually are, and that is a far better
   * place to be standing.
   *
   * Given up the moment the person moves the map themselves, and never taken at
   * all by someone whose own quizzes framed the opening view. Re-framing a map
   * out from under a hand already on it is worse than any view it could arrive
   * at.
   */
  // Untracked because the initial value is exactly what is wanted: whether the
  // opening view was framed by your own quizzes is settled when the map is
  // built, and saving a quiz later must not hand the frame back.
  let mayFrame = untrack(() => mine.length === 0);

  /**
   * Asks about whatever ground is now on screen.
   *
   * Accumulates rather than replaces: a quiz found at one zoom stays found at
   * another, and panning away and back neither refetches it nor makes it blink.
   */
  async function refresh(instance: maplibregl.Map): Promise<void> {
    const bounds = instance.getBounds();
    const view: [number, number, number, number] = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];
    const cells = queryCells(view);

    // A view too wide to ask by ground is asked the other question instead,
    // and only once — `listPopular` has no cells to remember it by.
    if (cells === null) {
      if (asked.has('*')) return;
      asked.add('*');
    } else if (unasked(asked, cells).length === 0) {
      return;
    } else {
      for (const cell of cells) asked.add(cell);
    }

    loading = true;
    try {
      found = mergeFound(found, await session.discoverIn(cells));
      failed = false;
      settleOnFound(instance);
    } catch {
      failed = true;
      // Forgotten, so the next pan over this ground tries again rather than
      // treating a failed query as an answer of "nothing here".
      if (cells === null) asked.delete('*');
      else for (const cell of cells) asked.delete(cell);
    } finally {
      loading = false;
    }
  }

  /** Frames the ground the quizzes turned out to be on, once, if we still may. */
  function settleOnFound(instance: maplibregl.Map): void {
    if (!mayFrame) return;
    const box = boundsOf(found.map((quiz) => quiz.spec.bbox), 0.25);
    if (!box) return;
    mayFrame = false;
    instance.fitBounds(box, { padding: 48, maxZoom: 9, duration: 600 });
  }

  /**
   * The map, built once.
   *
   * Untracked wholesale for the reason `MapView` gives at length: everything
   * read here is state the map is answerable to rather than built from, and one
   * tracked read makes the map depend on its own data — which tears it down and
   * spends a WebGL context every time a query returns.
   */
  $effect(() =>
    untrack(() => {
      const instance = new maplibregl.Map({
        container,
        bounds: opening(),
        fitBoundsOptions: { padding: 40 },
        maxZoom: 12,
        dragRotate: false,
        attributionControl: false,
        style: buildFootprints(footprints(found)),
      });

      instance.addControl(
        new maplibregl.AttributionControl({
          compact: false,
          customAttribution: '© OpenStreetMap contributors',
        }),
        'bottom-right',
      );
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

      instance.on('load', () => {
        map = instance;
        void refresh(instance);
      });
      instance.on('move', () => viewTick++);
      // `originalEvent` is present only for a gesture, so the settling fit
      // below does not count as the person having taken the wheel.
      instance.on('movestart', (event) => {
        if ('originalEvent' in event && event.originalEvent) mayFrame = false;
      });
      instance.on('moveend', () => {
        clearTimeout(settle);
        settle = setTimeout(() => void refresh(instance), SETTLE_MS);
      });
      instance.on('resize', () => viewTick++);

      return () => {
        clearTimeout(settle);
        map = undefined;
        lit = null;
        instance.remove();
      };
    }),
  );

  /** New footprints go into the live source rather than rebuilding the style. */
  $effect(() => {
    const shapes = footprints(found);
    const instance = map;
    if (!instance) return;
    const source = instance.getSource('areas') as maplibregl.GeoJSONSource | undefined;
    source?.setData(shapes);
  });

  /** The footprint currently lit, so the next selection knows what to put out. */
  let lit: string | null = null;

  /**
   * Which footprint is lit, as feature state — one repaint, not a new document.
   *
   * The previous one is put out at the top of the next run rather than in a
   * teardown, because a teardown also runs when the component goes, and by then
   * the map has been removed: `setFeatureState` reaches through a style that no
   * longer exists and throws on the way out of the screen. Leaving the map is
   * exactly when there is nothing to clean up — the feature state goes with the
   * map — so the tidiest fix is to have no teardown at all.
   */
  $effect(() => {
    const instance = map;
    const id = selectedId;
    if (!instance || !instance.getSource('areas')) return;
    if (lit && lit !== id) instance.setFeatureState({ source: 'areas', id: lit }, { on: false });
    lit = id;
    if (id) instance.setFeatureState({ source: 'areas', id }, { on: true });
  });

  /**
   * The pins, gathered into what can be told apart at this zoom.
   *
   * Recomputed on every move, which is what `viewTick` is read for. The list is
   * at most a couple of dozen plates, so laying them out per frame costs less
   * than any arrangement that tried to avoid it.
   */
  const pins = $derived.by(() => {
    void viewTick;
    const instance = map;
    if (!instance) return [];
    const placed = found.map((quiz) => {
      const at = instance.project(centreOf(quiz.spec.bbox));
      return { id: quiz.spec.id, x: at.x, y: at.y };
    });
    const canvas = instance.getCanvas();
    const onScreen = visiblePins(placed, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    return cluster(onScreen, PIN_REACH).map((group) => ({
      ...group,
      quizzes: group.ids.map((id) => byId.get(id)).filter((q): q is Published => Boolean(q)),
    }));
  });

  /** Pressing a group of quizzes flies to them, which is what separates them. */
  function open(quizzes: Published[]): void {
    if (quizzes.length === 1) {
      selectedId = quizzes[0].spec.id;
      return;
    }
    const box = boundsOf(quizzes.map((quiz) => quiz.spec.bbox));
    if (box && map) map.fitBounds(box, { padding: 60, maxZoom: 11 });
  }

  const distance = (quiz: Published) => `${Math.round(spanKm(quiz.spec.bbox))} km across`;

  const players = (count: number) => `${count} ${count === 1 ? 'player' : 'players'}`;

  /**
   * What a plate says when it is read aloud rather than looked at.
   *
   * The plate itself is a name and a bare number, which is as much as fits and
   * is legible on a map because the number sits in its own capsule. Spoken, a
   * bare number is a puzzle — and one whose obvious reading, rounds played, is
   * the wrong one. See the note under the list.
   */
  function label(quizzes: Published[]): string {
    if (quizzes.length > 1) return `${quizzes.length} quizzes here. Zoom in to tell them apart.`;
    const quiz = quizzes[0];
    if (!quiz) return '';
    const bits = [quiz.spec.name, `by ${quiz.ownerName}`, distance(quiz)];
    if (quiz.players > 0) bits.push(players(quiz.players));
    return bits.join(', ');
  }
</script>

<div class="wrap">
  <div class="map" bind:this={container}></div>

  <!--
    Pins are DOM, not a symbol layer: the style has none, by the same decision
    that makes place names HTML on the quiz map. It also makes every quiz on
    this map a real button — reachable by keyboard, which nothing drawn into a
    canvas can be.
  -->
  <div class="pins">
    {#each pins as pin (pin.at.id)}
      <button
        class="pin"
        class:pin--many={pin.quizzes.length > 1}
        class:pin--on={pin.quizzes.length === 1 && pin.at.id === selectedId}
        style:left="{pin.at.x}px"
        style:top="{pin.at.y}px"
        aria-label={label(pin.quizzes)}
        onclick={() => open(pin.quizzes)}
      >
        {#if pin.quizzes.length > 1}
          {pin.quizzes.length} quizzes
        {:else if pin.quizzes[0]}
          <span class="pin-name">{pin.quizzes[0].spec.name}</span>
          {#if pin.quizzes[0].players > 0}
            <span class="pin-count">{pin.quizzes[0].players}</span>
          {/if}
        {/if}
      </button>
    {/each}
  </div>

  {#if loading && found.length === 0}
    <p class="over">Looking…</p>
  {:else if failed && found.length === 0}
    <p class="over">Could not reach the quiz list. Yours are all still here.</p>
  {:else if found.length === 0}
    <p class="over">Nothing published over this ground yet. Zoom out to see further.</p>
  {/if}

  {#if selected}
    <div class="card">
      <button class="close" aria-label="Close" onclick={() => (selectedId = null)}>×</button>
      <h2>
        {selected.spec.name}
        {#if held.has(selected.spec.id)}<span class="tag">yours</span>{/if}
      </h2>
      <p class="who">{selected.ownerName}</p>
      <p class="facts">
        {selected.questions}
        {selected.questions === 1 ? 'question' : 'questions'} · {distance(selected)}
        {#if selected.players > 0}
          · {players(selected.players)}
        {/if}
      </p>
      <button class="play" onclick={() => onplay(selected)}>Play this quiz</button>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid rgba(0, 0, 0, 0.1);
  }
  .map {
    position: absolute;
    inset: 0;
  }

  .pins {
    position: absolute;
    inset: 0;
    /* The map keeps its own gestures: only the plates themselves take a press. */
    pointer-events: none;
    z-index: 2;
  }
  .pin {
    position: absolute;
    /* Centred on the ground it names, so the plate marks the place. */
    translate: -50% -50%;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    max-width: 11rem;
    padding: 0.25rem 0.5rem;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    color: #1d232b;
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid rgba(0, 0, 0, 0.18);
    border-radius: 20px;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
    cursor: pointer;
    pointer-events: auto;
    white-space: nowrap;
  }
  .pin:hover,
  .pin:focus-visible {
    border-color: var(--accent);
    z-index: 1;
  }
  .pin--on {
    color: #fff;
    background: var(--accent);
    border-color: var(--accent);
  }
  .pin--many {
    color: #fff;
    background: rgba(45, 52, 62, 0.92);
    border-color: rgba(0, 0, 0, 0.3);
  }
  .pin-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pin-count {
    padding: 0 0.32rem;
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    background: rgba(0, 0, 0, 0.07);
    border-radius: 20px;
  }
  .pin--on .pin-count {
    color: #fff;
    background: rgba(255, 255, 255, 0.22);
  }

  .over {
    position: absolute;
    left: 50%;
    top: 1rem;
    translate: -50% 0;
    z-index: 3;
    margin: 0;
    max-width: 22rem;
    padding: 0.6rem 0.9rem;
    font-size: 0.85rem;
    color: var(--muted);
    text-align: center;
    background: rgba(255, 255, 255, 0.94);
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
  }

  .card {
    position: absolute;
    left: 0.75rem;
    right: 0.75rem;
    bottom: 0.75rem;
    z-index: 4;
    max-width: 24rem;
    padding: 0.9rem 1rem 1rem;
    background: #fff;
    border-radius: 10px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.22);
  }
  .card h2 {
    margin: 0;
    font-size: 1.05rem;
    letter-spacing: -0.01em;
  }
  .who {
    margin: 0.15rem 0 0;
    font-size: 0.85rem;
    color: #1d232b;
  }
  .facts {
    margin: 0.1rem 0 0.75rem;
    font-size: 0.78rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .tag {
    margin-left: 0.4rem;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0.12rem 0.4rem;
    background: rgba(0, 0, 0, 0.06);
    border-radius: 20px;
    vertical-align: 0.15em;
  }
  .play {
    width: 100%;
    padding: 0.6rem;
    font: inherit;
    font-weight: 650;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  .close {
    position: absolute;
    top: 0.35rem;
    right: 0.5rem;
    font: inherit;
    font-size: 1.2rem;
    line-height: 1;
    color: var(--muted);
    background: none;
    border: 0;
    padding: 0.2rem 0.35rem;
    cursor: pointer;
  }
</style>
