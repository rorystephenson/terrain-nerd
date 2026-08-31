<script lang="ts">
  import { untrack } from 'svelte';
  import MapView from './MapView.svelte';
  import { loadArea, loadByIds, loadContext, loadPlaces } from './chunks.ts';
  import {
    clearOverrides,
    initialState,
    inclusionOf,
    isIncluded,
    padBox,
    questionCount,
    resolve,
    setKind,
    setRange,
    toggleOverride,
  } from './builder.ts';
  import { levelFor, PLACE_PAD } from './places.ts';
  import { newQuizId } from './storage.ts';
  import type {
    BuilderState,
    ContextCollection,
    Inclusion,
    KindId,
    PlaceFeature,
    PoolIndex,
    QuizFeature,
    QuizSpec,
  } from './types.ts';

  type Props = {
    index: PoolIndex;
    /** Set when editing an existing quiz rather than starting fresh. */
    editing?: QuizSpec | null;
    onsave: (quiz: QuizSpec) => void;
    oncancel: () => void;
  };

  let { index, editing = null, onsave, oncancel }: Props = $props();

  /**
   * Where the map opens with nothing to go back to: Val Rendena and the Brenta.
   *
   * Sized like a quiz rather than like a region — an area this big is already
   * ~40 questions at the default filters, and opening on half the Alps just
   * means everyone's first act is zooming in.
   */
  const HOME: [number, number, number, number] = [10.72, 46.06, 10.94, 46.26];

  // Seeded from the props once, on purpose: after that the builder owns them.
  // App remounts this component per edit target, so there is nothing to react to.
  const seed = untrack(() => ({
    step: (editing ? 'features' : 'area') as 'area' | 'features',
    builder: editing?.builder ?? initialState(index.kinds),
    name: editing?.name ?? '',
  }));

  let step = $state<'area' | 'features'>(seed.step);
  /**
   * What the map frames. Deliberately *not* fed from the map's own reported
   * view: framing pads outwards, so feeding the result back in would inflate
   * the area a little more every time anything re-framed.
   */
  const home = untrack(() => (editing ? padBox(editing.bbox, 0.02) : HOME));
  /** Where the map is now, reported by MapView. Output only. */
  let view = $state<[number, number, number, number]>(home);
  let area = $state<[number, number, number, number] | null>(null);
  /**
   * What the crop frame currently covers, which is not yet what the pool is
   * loaded from. Committing is a separate act on purpose: the frame reports a
   * new area on every pan, and a pool that refetched each time would spend the
   * whole of choosing an area downloading the ones you passed over.
   */
  let pending = $state<[number, number, number, number] | null>(null);

  /** Breathing room between the frame and the panel it is keeping clear of. */
  const CHROME_GAP_PX = 12;
  /**
   * The area panel, measured rather than assumed: it wraps differently at every
   * width, and it is only measured while it is the one on screen, which is the
   * only time the frame is open.
   */
  let windowWidth = $state(0);
  let panelWidth = $state(0);
  let panelHeight = $state(0);

  /**
   * Room the crop frame has to leave for the panel, on whichever side costs
   * less: a desktop window has room to the right of it, where a phone's panel
   * is nearly the full width and only the strip below it is worth having.
   *
   * The panel is the only thing reserved for. The map's zoom buttons and credit
   * are drawn above the frame instead, so the frame may run under them — an
   * inset for them would be one the user cannot see the reason for, and it
   * would stop the frame reaching as far one way as it reaches the other.
   */
  const selectInset = $derived(
    panelWidth + CHROME_GAP_PX > 0.45 * windowWidth
      ? { top: panelHeight + CHROME_GAP_PX }
      : { left: panelWidth + CHROME_GAP_PX },
  );

  let builder = $state<BuilderState>(seed.builder);
  /**
   * Geometry is held raw, not as deep `$state`.
   *
   * `$state` proxies an object and everything reachable from it, so a plain
   * `$state` here would hand MapLibre a few hundred thousand coordinates behind
   * reactive proxies and pay for a trap on every read — which showed up as most
   * of the CPU time in a pan. None of these are ever mutated in place, only
   * reassigned, which is exactly what `$state.raw` is for.
   */
  let pool = $state.raw<QuizFeature[]>([]);
  let context = $state.raw<ContextCollection>({ type: 'FeatureCollection', features: [] });
  let places = $state.raw<PlaceFeature[]>([]);
  let loading = $state(false);
  let name = $state(seed.name);

  /**
   * Everything in the area, every kind — filtered for display rather than
   * refetched. Toggling a type is a decision about the quiz, not about what to
   * download, and refetching on each tick threw away the other types' features
   * and made the map flash.
   */
  const visible = $derived(pool.filter((f) => builder.kinds[f.properties.kind]));

  /** A stable identity while the features are unchanged, so the map is not re-fed. */
  const collection = $derived({ type: 'FeatureCollection' as const, features: visible });

  /**
   * Rebuilds the candidate area when reopening a saved quiz.
   *
   * The build area is deliberately never saved, so it has to be recovered from
   * the features — and from their *anchors*, not their extents. A quiz's bbox
   * spans the full geometry of everything in it, and one long valley reaches
   * far past the area you actually picked, which would offer a far wider pool
   * than the one the quiz was built from.
   *
   * This only has to get the *candidates* roughly right. What the quiz actually
   * contains on reopening is pinned down exactly by `reconcile` below, because
   * no reconstruction of an area that was never saved can be relied on to
   * reproduce a feature set.
   */
  $effect(() => {
    if (!editing || area) return;
    let cancelled = false;
    loadByIds(index, editing.bbox, editing.featureIds).then((chosen) => {
      if (cancelled || chosen.length === 0) return;
      let box: [number, number, number, number] | null = null;
      for (const { properties } of chosen) {
        const [lon, lat] = properties.anchor;
        box = box
          ? [Math.min(box[0], lon), Math.min(box[1], lat), Math.max(box[2], lon), Math.max(box[3], lat)]
          : [lon, lat, lon, lat];
      }
      if (box) area = padBox(box, 0.05);
    });
    return () => {
      cancelled = true;
    };
  });

  /**
   * The candidate pool is frozen to the area you chose, not to wherever the map
   * happens to be now — so panning around to inspect your selection cannot
   * quietly pull in features from the next valley.
   */
  $effect(() => {
    const box = area;
    if (!box) return;
    const kinds = index.kinds.map((kind) => kind.id);
    loading = true;
    let cancelled = false;

    loadArea(index, box, kinds as KindId[])
      .then((loaded) => {
        if (cancelled) return;
        pool = loaded;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });

  /**
   * Reopening a saved quiz must offer exactly the quiz that was saved.
   *
   * The filters cannot be trusted to reproduce it. The candidate pool is
   * rebuilt from an area that was never stored, and it holds every feature
   * *crossing* that area — so re-running the sliders over it turns up features
   * the original never contained, and reopening a 71-feature quiz silently
   * offered 104. A saved quiz is a decided set, not a query to re-run.
   *
   * So the saved set wins, and any disagreement with the filters is recorded as
   * a pin — which is exactly what a pin means. Features the filters already
   * agree about are left alone, so the sliders still do something afterwards,
   * and pins the user made themselves are preserved.
   */
  let reconciled = $state(false);
  $effect(() => {
    if (!editing || reconciled || pool.length === 0) return;
    const saved = new Set(editing.featureIds);
    const overrides = { ...builder.overrides };
    let pinned = 0;

    for (const feature of pool) {
      const wanted = saved.has(feature.id);
      if (wanted === isIncluded(inclusionOf(feature, builder))) continue;
      overrides[feature.id] = wanted ? 'in' : 'out';
      pinned++;
    }

    if (pinned > 0) builder = { ...builder, overrides };
    reconciled = true;
  });

  /**
   * Roads and glaciers follow the map, not the chosen area.
   *
   * While you are still picking an area they have to track the view for the
   * same reason place names do: they are what you navigate by, and a blank
   * hillshade gives you nothing to recognise the valley from.
   */
  $effect(() => {
    const box = step === 'area' ? view : area;
    if (!box) return;
    let cancelled = false;
    loadContext(index, box).then((furniture) => {
      if (!cancelled) context = furniture;
    });
    return () => {
      cancelled = true;
    };
  });

  /**
   * How much settlement detail is worth showing at this scale.
   *
   * Villages across half a country is noise; cities alone in one valley tells
   * you nothing. Scale the granularity to the span being looked at.
   */
  /**
   * Place names, always on and always following the map.
   *
   * You cannot pick the valley you fly if you cannot tell which one it is, and
   * that is no less true once you are choosing features than while framing the
   * area — so both steps use the one rule in `places.ts`.
   */
  $effect(() => {
    const box = padBox(view, PLACE_PAD);
    const level = levelFor(view);

    // Panning fires continuously, so settle before fetching.
    let cancelled = false;
    const timer = setTimeout(() => {
      loadPlaces(index, box, level).then((loaded) => {
        if (!cancelled) places = loaded;
      });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  const shade = $derived.by(() => {
    const out: Record<string, Inclusion> = {};
    for (const feature of visible) out[feature.id] = inclusionOf(feature, builder);
    return out;
  });

  const picked = $derived(resolve(visible, builder));
  const questions = $derived(questionCount(picked.included));

  function useThisArea() {
    if (!pending) return;
    area = pending;
    step = 'features';
  }

  function pick(id: string | null) {
    if (!id) return;
    const feature = visible.find((f) => f.id === id);
    if (feature) builder = toggleOverride(builder, feature);
  }

  function save() {
    if (!picked.bbox || picked.included.length === 0) return;
    onsave({
      id: editing?.id ?? newQuizId(),
      name: name.trim() || suggestedName(),
      source: 'built',
      createdAt: editing?.createdAt ?? new Date().toISOString(),
      featureIds: picked.included.map((f) => f.id),
      // From the features, not the builder viewport: however the map was left,
      // the quiz frames itself sensibly.
      bbox: padBox(picked.bbox),
      builder,
    });
  }

  /** The most prominent thing in the selection usually names the area well. */
  function suggestedName(): string {
    const best = [...picked.included].sort(
      (a, b) =>
        (b.properties.popularity ?? b.properties.lengthKm) -
        (a.properties.popularity ?? a.properties.lengthKm),
    )[0];
    return best ? `Around ${best.properties.name}` : 'My quiz';
  }
</script>

<svelte:window bind:innerWidth={windowWidth} />

<MapView
  {collection}
  context={context}
  mode="build"
  bbox={home}
  coverage={index.area}
  {shade}
  {places}
  enabled={step === 'features'}
  selecting={step === 'area' && panelHeight > 0}
  selected={area}
  {selectInset}
  onpick={pick}
  onview={(v) => (view = v.view)}
  onarea={(box) => (pending = box)}
/>

<!--
  A panel per step rather than one that changes contents, so the area panel is
  measured for itself. The crop frame waits on that measurement — it has to know
  what the panel covers before it can open anywhere sensible — and a shared
  element would carry the features panel's height across the step change and
  open the frame against the wrong one.
-->
{#if step === 'area'}
  <div class="panel" bind:clientWidth={panelWidth} bind:clientHeight={panelHeight}>
    <h2>Choose an area</h2>
    <p class="hint">
      Drag the red frame's handles over the ground you want to be quizzed on, panning and
      zooming the map underneath it. Everything the frame crosses becomes available to pick
      from.
    </p>
    <div class="actions">
      <button class="ghost" onclick={oncancel}>Cancel</button>
      <button class="primary" disabled={!pending} onclick={useThisArea}>Use this area</button>
    </div>
  </div>
{:else}
  <div class="panel">
    <div class="head">
      <h2>{editing ? 'Edit quiz' : 'Pick features'}</h2>
      <button class="link" onclick={() => (step = 'area')}>Change area</button>
    </div>

    {#each index.kinds as kind (kind.id)}
      <section class:off={!builder.kinds[kind.id]}>
        <label class="toggle">
          <input
            type="checkbox"
            checked={builder.kinds[kind.id]}
            onchange={(e) => (builder = setKind(builder, kind.id, e.currentTarget.checked))}
          />
          <span>{kind.label}</span>
        </label>

        {#if builder.kinds[kind.id]}
          {#each kind.filters as filter (filter.key)}
            {@const range = builder.ranges[kind.id]?.[filter.key] ?? filter.default}
            <div class="filter">
              <div class="filter-head">
                <span>{filter.label}</span>
                <span class="value">
                  {range[0]}{filter.unit} +
                </span>
              </div>
              <input
                type="range"
                min={filter.min}
                max={filter.max}
                step={filter.step}
                value={range[0]}
                oninput={(e) =>
                  (builder = setRange(builder, kind.id, filter.key, [
                    Number(e.currentTarget.value),
                    range[1],
                  ]))}
              />
            </div>
          {/each}
        {/if}
      </section>
    {/each}


    <div class="tally">
      {#if loading}
        <span class="loading">Loading the area…</span>
      {:else}
        <strong>{questions}</strong> question{questions === 1 ? '' : 's'}
        {#if picked.lockedIn || picked.lockedOut}
          <span class="locks">
            · {picked.lockedIn + picked.lockedOut} pinned
            <button class="link" onclick={() => (builder = clearOverrides(builder))}>clear</button>
          </span>
        {/if}
      {/if}
    </div>
    <p class="sub">
      Tap a feature to pin it in or out, whatever the filter says. Tap it again to hand it
      back to the filter.
    </p>

    <input class="name" placeholder={suggestedName()} bind:value={name} />
    <div class="actions">
      <button class="ghost" onclick={oncancel}>Cancel</button>
      <button class="primary" disabled={questions === 0} onclick={save}>
        {editing ? 'Save changes' : 'Save quiz'}
      </button>
    </div>
  </div>
{/if}

<style>
  .panel {
    position: absolute;
    /* Above the crop frame, and above the map labels that outrank the map. */
    z-index: 5;
    top: 0.75rem;
    left: 0.75rem;
    width: min(20rem, calc(100vw - 1.5rem));
    max-height: calc(100vh - 1.5rem);
    overflow-y: auto;
    padding: 0.9rem 1rem 1rem;
    background: rgba(255, 255, 255, 0.96);
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(6px);
  }
  h2 { margin: 0; font-size: 1.05rem; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .hint, .sub { color: var(--muted); font-size: 0.82rem; line-height: 1.45; }
  .hint { margin: 0.5rem 0 0; }
  .sub { margin: 0.3rem 0 0; }

  section {
    margin-top: 0.9rem;
    padding-top: 0.75rem;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
  }
  section.off { opacity: 0.55; }
  .toggle { display: flex; align-items: center; gap: 0.45rem; font-weight: 550; cursor: pointer; }

  .filter { margin-top: 0.5rem; }
  .filter-head {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .value { font-variant-numeric: tabular-nums; color: #1d232b; font-weight: 600; }
  input[type='range'] { width: 100%; margin-top: 0.15rem; }

  .tally {
    margin-top: 0.9rem;
    padding-top: 0.75rem;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    font-size: 0.95rem;
  }
  .tally strong { font-size: 1.2rem; }
  .locks { color: var(--muted); font-size: 0.82rem; }
  .loading { color: var(--muted); }

  .name {
    width: 100%;
    margin-top: 0.75rem;
    padding: 0.5rem 0.6rem;
    font: inherit;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 8px;
  }

  .actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  .actions button { flex: 1; padding: 0.6rem; font: inherit; font-weight: 600; border-radius: 8px; cursor: pointer; }
  .primary { color: #fff; background: var(--accent); border: 0; }
  .primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .ghost { background: #fff; border: 1px solid rgba(0, 0, 0, 0.15); }
  .link {
    padding: 0;
    font: inherit;
    font-size: 0.8rem;
    color: var(--accent);
    background: none;
    border: 0;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
