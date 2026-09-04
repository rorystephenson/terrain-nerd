<script lang="ts">
  import { untrack } from 'svelte';
  import MapView from './MapView.svelte';
  import { loadArea, loadByIds, loadPlaces } from './chunks.ts';
  import {
    clearOverrides,
    clearSpacing,
    initialState,
    isIncluded,
    shadeOf,
    padBox,
    questionCount,
    resolve,
    setKind,
    setRange,
    setSpacing,
    SPACING_NONE,
    SPACING_STEP,
    toggleOverride,
  } from './builder.ts';
  import { placeFetchBox } from './places.ts';
  import { hasSeen, markSeen, newQuizId } from './storage.ts';
  import type {
    BuilderState,
    FilterSpec,
    KindId,
    KindInfo,
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
    /*
     * Reopening restores the sliders but starts with the spacing off.
     *
     * A saved quiz is a decided set, and the spacing is part of the query that
     * decided it — running it again over a pool rebuilt from a different area
     * can only disagree. It does not lose anything (reconcile pins the saved set
     * back in), but a pin takes no ground, so freeing the ground of everything
     * pinned *out* lets a third feature through that was crowded before: the
     * quiz quietly grows by one each time it is opened.
     *
     * Raising it again is a decision the person editing can make, and then it
     * means what it says.
     */
    builder: editing
      ? clearSpacing(editing.builder ?? initialState(index.kinds))
      : initialState(index.kinds),
    name: editing?.name ?? '',
  }));

  let step = $state<'area' | 'features'>(seed.step);

  /**
   * The two step explainers, each read once at mount and never re-read.
   *
   * Read once on purpose: they are marked seen as soon as the step carrying one
   * is on screen, and a live read would then delete the paragraph out from under
   * whoever is halfway through it.
   */
  const HINT_AREA = 'build:area';
  const HINT_FEATURES = 'build:features';
  const hints = untrack(() => ({
    area: !hasSeen(HINT_AREA),
    features: !hasSeen(HINT_FEATURES),
  }));

  $effect(() => {
    if (step === 'area' && hints.area) markSeen(HINT_AREA);
    if (step === 'features' && hints.features) markSeen(HINT_FEATURES);
  });

  /**
   * What the map frames. Deliberately *not* fed from the map's own reported
   * view: framing pads outwards, so feeding the result back in would inflate
   * the area a little more every time anything re-framed.
   */
  const home = untrack(() => (editing ? padBox(editing.bbox, 0.02) : HOME));
  /** Where the map is now, reported by MapView. Output only. */
  let view = $state<[number, number, number, number]>(home);
  /**
   * What the map has measured of itself: null until it has reported once.
   *
   * Nullable rather than seeded with zeros, because there is no honest zero
   * here. `view` has one — `home`, which is a real place to look at before the
   * map speaks — but a zoom of 0 and a canvas of no size are not small values,
   * they are absent ones, and code downstream divides by them.
   */
  let measured = $state<{ zoom: number; canvas: { width: number; height: number } } | null>(null);
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
  let places = $state.raw<PlaceFeature[]>([]);
  let loading = $state(false);
  let name = $state(seed.name);
  /**
   * Folded down to its own head, so the map underneath can be worked on.
   *
   * Picking features is half panel and half map — you set the sliders, then you
   * tap the ones the filter got wrong. On a phone the panel is nearly the whole
   * screen, so the tapping half is done blind, and there is no scrolling out of
   * its way: it is pinned to the viewport, not to the page.
   *
   * What stays is the panel's head, unchanged and in place, so the fold reads as
   * this panel rolled up rather than as something else taking its corner.
   */
  let minimised = $state(false);

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
   *
   * "What the filters say" has to mean the *thinned* selection, not the slider
   * verdict on its own. A feature the sliders admit but the spacing drops looks
   * like agreement to a check that only asks `inclusionOf`, so it gets no pin
   * and is then thinned away anyway — the saved quiz quietly losing features,
   * which is the same failure as the 71 reopening as 104, in the other
   * direction. Pinning it in is also what protects it: `thin` never drops a pin.
   */
  let reconciled = $state(false);
  $effect(() => {
    if (!editing || reconciled || pool.length === 0) return;
    const saved = new Set(editing.featureIds);
    const overrides = { ...builder.overrides };
    let pinned = 0;

    const offered = new Set(resolve(pool, builder).included.map((f) => f.id));
    for (const feature of pool) {
      const wanted = saved.has(feature.id);
      if (wanted === offered.has(feature.id)) continue;
      overrides[feature.id] = wanted ? 'in' : 'out';
      pinned++;
    }

    if (pinned > 0) builder = { ...builder, overrides };
    reconciled = true;
  });


  /**
   * Place names, always on and always following the map.
   *
   * You cannot pick the valley you fly if you cannot tell which one it is, and
   * that is no less true once you are choosing features than while framing the
   * area — so both steps use the one rule in `places.ts`.
   *
   * Runs on every view change, with no settling delay. There used to be one,
   * because a batch landing late could make the old collision pass reshuffle
   * names that were already drawn — but selection is a per-label test now, so a
   * late arrival can only add. What is left is a filter over cells already
   * held: about two milliseconds at the widest view, a fraction of one at a
   * valley. Waiting a quarter of a second for that was a hundred times the
   * price of doing it, and it was the whole of the pause after a pan.
   */
  $effect(() => {
    // Nothing until the map has reported itself: both the pad and the zoom cut
    // are read off what it says.
    if (!measured) return;
    const box = placeFetchBox(view, measured.canvas);
    const at = measured.zoom;

    let cancelled = false;
    loadPlaces(index, box, at).then((loaded) => {
      if (!cancelled) places = loaded;
    });

    return () => {
      cancelled = true;
    };
  });

  const picked = $derived(resolve(visible, builder));
  const shade = $derived(shadeOf(visible, builder, picked));
  const questions = $derived(questionCount(picked.included));

  function useThisArea() {
    if (!pending) return;
    area = pending;
    step = 'features';
    // A new area is a new set of features to filter: come back to the controls.
    minimised = false;
  }

  function pick(id: string | null) {
    if (!id) return;
    const feature = visible.find((f) => f.id === id);
    if (feature) builder = toggleOverride(builder, feature, isIncluded(shade[feature.id]));
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

  /** Filters that are still worth a control. See `hidden` in `featureTypes.ts`. */
  const shown = (kind: KindInfo) => kind.filters.filter((filter) => !filter.hidden);

  /*
   * Straight off the state, with no fall back to the kind's default. Falling
   * back showed 3km on a panel whose state said nothing, so the control read as
   * applied while the selection was untouched — and a quiz reopened before
   * spacing existed would silently start thinning.
   */
  const spacingOf = (kind: KindInfo) => builder.spacing?.[kind.id] ?? 0;

  /** Where a valley is as long as naming an area cares about. */
  const VALLEY_FULL_KM = 40;

  /**
   * One step past the top of the scale, where the slider selects nothing.
   *
   * Filtering to the maximum used to leave a handful of features behind, which
   * is no use when what you want is an empty set to hand-pick a few into. The
   * old score was a percentile, so its top bucket was non-empty by construction
   * — 373 peaks sat at exactly 100 — and both ends of the range compare
   * inclusively.
   *
   * Nothing needed changing in `matchesFilter` for this. A floor above every
   * value a feature can hold fails `value < min` for all of them, so the set
   * empties through the comparison that was always there. Pinned features still
   * survive it, because `inclusionOf` short-circuits to `locked-in` before the
   * filter is consulted at all.
   */
  const noneStop = (filter: FilterSpec) => filter.max + filter.step;

  /** Steps like 0.01 land on 0.30000000000000004 without this. */
  const round = (value: number, step: number) =>
    step < 1 ? value.toFixed(String(step).split('.')[1]?.length ?? 2) : String(value);

  /** The most prominent thing in the selection usually names the area well. */
  function suggestedName(): string {
    /*
     * Prominence rather than flight: an area is named after the mountain that
     * dominates it, not after wherever the traffic happens to funnel.
     *
     * A valley has neither score, so its length stands in — but it has to be
     * brought onto the same 0-1 scale first. Compared raw, twenty kilometres of
     * valley beats every mountain there has ever been, and every quiz would be
     * named after the longest valley it touches.
     */
    const rank = (f: QuizFeature) =>
      f.properties.prominence ?? Math.min(1, f.properties.lengthKm / VALLEY_FULL_KM);
    const best = [...picked.included].sort((a, b) => rank(b) - rank(a))[0];
    return best ? `Around ${best.properties.name}` : 'My quiz';
  }
</script>

<svelte:window bind:innerWidth={windowWidth} />

<MapView
  {collection}
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
  onview={(v) => {
    view = v.view;
    measured = { zoom: v.zoom, canvas: v.canvas };
  }}
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
    {#if hints.area}
      <p class="hint">
        Drag the red frame's handles over the ground you want to be quizzed on, panning and
        zooming the map underneath it. Everything the frame crosses becomes available to pick
        from.
      </p>
    {/if}
    <div class="actions">
      <button class="ghost" onclick={oncancel}>Cancel</button>
      <button class="primary" disabled={!pending} onclick={useThisArea}>Use this area</button>
    </div>
  </div>
{:else}
  <!--
    Folding hides the panel's body and leaves its head exactly as it was: same
    plate, same corner, same width, same two controls, with the minus turned
    into a plus. A pill that shrank to a different shape read as a new thing
    arriving where the panel used to be, and the eye had to find it again.
  -->
  <div class="panel">
    <div class="head">
      <h2>{editing ? 'Edit quiz' : 'Pick features'}</h2>
      <div class="head-actions">
        <button class="link" onclick={() => (step = 'area')}>Change area</button>
        <button
          class="fold"
          onclick={() => (minimised = !minimised)}
          title={minimised ? 'Maximise' : 'Minimise'}
          aria-label={minimised ? 'Maximise the panel' : 'Minimise the panel'}
        >{minimised ? '+' : '−'}</button>
      </div>
    </div>

    {#if !minimised}
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
            {#each shown(kind) as filter, at (filter.key)}
              {@const range = builder.ranges[kind.id]?.[filter.key] ?? filter.default}
              {@const none = noneStop(filter)}
              <!--
                The sliders add to each other rather than narrowing each other, and
                nothing about two stacked sliders says which. Without the word,
                every reading of this panel is the wrong one.
              -->
              {#if at > 0}<div class="joiner">or</div>{/if}
              <div class="filter">
                <div class="filter-head">
                  <span>{filter.label}</span>
                  <span class="value" class:none={range[0] >= none}>
                    {range[0] >= none ? 'none' : `${round(range[0], filter.step)}${filter.unit} +`}
                  </span>
                </div>
                <input
                  type="range"
                  min={filter.min}
                  max={none}
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

            {#if kind.defaultSpacingKm !== undefined}
              {@const km = spacingOf(kind)}
              <!--
                The one control per kind, and it runs the whole way: everything
                that qualifies at one end, none of it at the other. What decides
                *what* qualifies is settled and no longer on the panel.
              -->
              <div class="filter">
                <div class="filter-head">
                  <span>Thin out</span>
                  <span class="value" class:none={km === 0 || km >= SPACING_NONE}>
                    {km >= SPACING_NONE ? 'none' : km === 0 ? 'show all' : `${km.toFixed(1)}km apart`}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={SPACING_NONE}
                  step={SPACING_STEP}
                  value={km}
                  oninput={(e) =>
                    (builder = setSpacing(builder, kind.id, Number(e.currentTarget.value)))}
                />
              </div>
            {/if}
          {/if}
        </section>
      {/each}


      <div class="tally">
        {#if loading}
          <span class="loading">Loading the area…</span>
        {:else}
          <strong>{questions}</strong> question{questions === 1 ? '' : 's'}
          {#if picked.thinnedOut}
            <span class="locks">· {picked.thinnedOut} thinned out</span>
          {/if}
          {#if picked.lockedIn || picked.lockedOut}
            <span class="locks">
              · {picked.lockedIn + picked.lockedOut} pinned
              <button class="link" onclick={() => (builder = clearOverrides(builder))}>clear</button>
            </span>
          {/if}
        {/if}
      </div>
      {#if hints.features}
        <p class="sub">
          Tap a feature to pin it in or out, whatever the filter says. Tap it again to hand it
          back to the filter.
        </p>
      {/if}

      <input class="name" placeholder={suggestedName()} bind:value={name} />
      <div class="actions">
        <button class="ghost" onclick={oncancel}>Cancel</button>
        <button class="primary" disabled={questions === 0} onclick={save}>
          {editing ? 'Save changes' : 'Save quiz'}
        </button>
      </div>
    {/if}
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
    /*
     * Bounded by the app frame rather than by `vh`, and scrolled inside it.
     *
     * The panel is as tall as its controls make it, which on a small phone is
     * taller than the screen — so without a cap the name field and the save
     * button sit below the fold with nothing to scroll. `100vh` is not the cap
     * to use: on a phone it means the viewport with the browser bars collapsed,
     * which is taller than what is actually on screen, so the foot of the panel
     * stays unreachable by exactly the height of the bars. The percentage is of
     * the fixed, inset-0 frame the app draws in, which is the real thing.
     *
     * `dvh` says the same as the percentage and is kept as the tighter of the
     * two where a browser reports a frame taller than the visible viewport; the
     * plain declaration above it is what an engine without `dvh` falls back to.
     */
    max-height: calc(100% - 1.5rem);
    max-height: min(calc(100% - 1.5rem), calc(100dvh - 1.5rem));
    overflow-y: auto;
    /* The map is behind it: scrolling to the end of the panel must not go on to
       pan the terrain underneath. */
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 0.9rem 1rem 1rem;
    background: rgba(255, 255, 255, 0.96);
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(6px);
  }
  h2 { margin: 0; font-size: 1.05rem; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  /* Wrapping as a pair, so the fold glyph never lands alone under the heading. */
  .head-actions { display: flex; align-items: baseline; gap: 0.9rem; flex: 0 0 auto; }
  /*
   * A minus or a plus rather than the word, on the app's own icon-button idiom —
   * the name lives in `title`/`aria-label`. No box around it: the row it shares
   * is a text link, not the strip of buttons the quiz list draws.
   *
   * The hit area is grown to a thumb and the margins pull the glyph back to
   * where it looks right, asymmetrically. It takes the panel's own right
   * padding, where there is nothing to hit by mistake, and stops short on the
   * left of "Change area" — a mis-tap there costs you the area you just framed.
   */
  .fold {
    margin: -0.75rem -1rem -0.75rem 0;
    padding: 0.75rem 1rem 0.75rem 0.75rem;
    font: inherit;
    font-size: 1.25rem;
    line-height: 1;
    color: var(--muted);
    background: none;
    border: 0;
    cursor: pointer;
  }
  .fold:hover { color: #1d232b; }
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
  .joiner {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8a94a2;
    margin: 0.1rem 0 0.25rem;
  }
  /* The stop that selects nothing reads as off rather than as a number. */
  .value.none { color: #8a94a2; font-weight: 500; font-style: italic; }
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
