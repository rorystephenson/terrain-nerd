<script lang="ts">
  import MapView from './lib/MapView.svelte';
  import Minimap from './lib/Minimap.svelte';
  import Prompt from './lib/Prompt.svelte';
  import Results from './lib/Results.svelte';
  import ZonePicker from './lib/ZonePicker.svelte';
  import { gradeColor } from './lib/mapStyle.ts';
  import {
    attempt,
    createQuiz,
    currentQuestion,
    isFinished,
    score,
    triesLeft,
    MAX_TRIES,
    type QuizState,
  } from './lib/quiz.ts';
  import type {
    ContextCollection,
    FeatureFile,
    Group,
    MapLabel,
    QuizFeature,
    QuizManifest,
    Tier,
    ViewState,
    Zone,
  } from './lib/types.ts';

  /** How long each kind of feedback stays on screen. */
  const FEEDBACK_MS = { correct: 550, miss: 1200 };
  const BEST_KEY = 'terrain-nerd:best';

  type Feedback =
    | { kind: 'miss'; missedId: string | null; name: string; triesLeft: number }
    | { kind: 'correct'; name: string };

  let manifest = $state<QuizManifest | null>(null);
  let context = $state<ContextCollection | null>(null);
  let loadError = $state<string | null>(null);

  let selection = $state<{ group: Group; tier: Tier; zone: Zone } | null>(null);
  let features = $state<QuizFeature[]>([]);
  let quiz = $state<QuizState | null>(null);
  let feedback = $state<Feedback | null>(null);
  let locked = $state(false);
  let collapsed = $state(false);
  let viewState = $state<ViewState>({ view: [0, 0, 0, 0], covers: true });
  let best = $state<Record<string, number>>(readBest());
  let timers: ReturnType<typeof setTimeout>[] = [];

  /** Data files already fetched, keyed by filename. */
  const loaded = new Map<string, QuizFeature[]>();

  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));

  function readBest(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Record<string, number>;
    } catch {
      return {}; // private browsing, blocked storage — scores just don't persist
    }
  }

  function recordBest(zoneId: string, pct: number) {
    if (best[zoneId] !== undefined && best[zoneId] >= pct) return;
    best = { ...best, [zoneId]: pct };
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(best));
    } catch {
      // Not worth interrupting the game over.
    }
  }

  $effect(() => {
    Promise.all([
      fetch('data/quizzes-trentino.json').then((r) => r.json() as Promise<QuizManifest>),
      fetch('data/context-trentino.geojson').then((r) => r.json() as Promise<ContextCollection>),
    ])
      .then(([m, c]) => { manifest = m; context = c; })
      .catch((error: unknown) => {
        loadError = error instanceof Error ? error.message : String(error);
      });
    return clearTimers;
  });

  const byId = $derived(new Map(features.map((f) => [f.id, f])));
  const nameById = $derived(new Map(features.map((f) => [f.id, f.properties.name])));
  const zoneFeatures = $derived(
    selection ? selection.zone.featureIds.flatMap((id) => byId.get(id) ?? []) : [],
  );

  const question = $derived(quiz ? currentQuestion(quiz) : null);
  const finished = $derived(quiz ? isFinished(quiz) : false);
  const tally = $derived(quiz ? score(quiz) : { correct: 0, solved: 0, total: 0, pct: 0 });
  const remaining = $derived(
    feedback?.kind === 'miss' ? feedback.triesLeft : quiz ? triesLeft(quiz) : MAX_TRIES,
  );

  /** Set while the tries are spent and the answer must be clicked to continue. */
  const revealId = $derived(quiz?.revealing ? (question?.targetId ?? null) : null);
  const missId = $derived(feedback?.kind === 'miss' ? feedback.missedId : null);

  const graded = $derived.by(() => {
    const out: Record<string, number> = {};
    for (const a of quiz?.answers ?? []) out[a.targetId] = a.grade;
    return out;
  });

  /**
   * Answered features keep their name on the map for the rest of the round,
   * tinted by how many tries they took — so the finished map is a readable
   * picture of what you know. Transient feedback wins for the same feature.
   */
  const labels = $derived.by(() => {
    const byFeature = new Map<string, MapLabel>();
    for (const a of quiz?.answers ?? []) {
      byFeature.set(a.targetId, {
        featureId: a.targetId,
        text: a.name,
        tone: 'answered',
        color: gradeColor(a.grade),
      });
    }
    if (revealId && question) {
      byFeature.set(revealId, { featureId: revealId, text: question.name, tone: 'reveal' });
    }
    if (feedback?.kind === 'miss' && feedback.missedId && feedback.name) {
      byFeature.set(feedback.missedId, {
        featureId: feedback.missedId,
        text: feedback.name,
        tone: 'wrong',
      });
    }
    return [...byFeature.values()];
  });

  $effect(() => {
    if (finished && selection && quiz) recordBest(selection.zone.id, score(quiz).pct);
  });

  async function play(group: Group, tier: Tier, zone: Zone) {
    clearTimers();
    feedback = null;
    locked = false;
    collapsed = false;

    let data = loaded.get(group.data);
    if (!data) {
      try {
        const file = (await fetch(`data/${group.data}`).then((r) => r.json())) as FeatureFile;
        data = file.features;
        loaded.set(group.data, data);
      } catch (error) {
        loadError = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    features = data;
    selection = { group, tier, zone };
    const lookup = new Map(data.map((f) => [f.id, f]));
    quiz = createQuiz(zone.featureIds.flatMap((id) => lookup.get(id) ?? []));
  }

  const replay = () => selection && play(selection.group, selection.tier, selection.zone);

  function toMenu() {
    clearTimers();
    feedback = null;
    locked = false;
    collapsed = false;
    quiz = null;
    selection = null;
  }

  function pick(clickedId: string | null) {
    if (!quiz || locked || finished) return;
    clearTimers();

    const outcome = attempt(quiz, clickedId);
    quiz = outcome.state;

    if (outcome.kind === 'correct' || outcome.kind === 'found') {
      feedback = { kind: 'correct', name: '' };
      locked = true;
      later(() => { feedback = null; locked = false; }, FEEDBACK_MS.correct);
      return;
    }

    // A wrong click — name the feature they actually hit. That near-miss is
    // where most of the learning is; "wrong" on its own teaches nothing.
    const missedId = outcome.kind === 'nudge' ? clickedId : outcome.missedId;
    feedback = {
      kind: 'miss',
      missedId,
      name: missedId ? (nameById.get(missedId) ?? '') : '',
      triesLeft: outcome.kind === 'retry' ? outcome.triesLeft : 0,
    };
    // Clicks stay live: during a reveal the player still has to go and find it.
    later(() => { feedback = null; }, FEEDBACK_MS.miss);
  }
</script>

<main>
  {#if loadError}
    <div class="centred">
      <h1>Terrain Nerd</h1>
      <p class="error">Could not load the quiz data: {loadError}</p>
      <p class="hint">Run <code>npm run build:data</code> from the repo root, then reload.</p>
    </div>
  {:else if !manifest || !context}
    <div class="centred"><p class="hint">Loading terrain…</p></div>
  {:else if selection && quiz}
    <MapView
      collection={{ type: 'FeatureCollection', features }}
      {context}
      activeIds={zoneFeatures.map((f) => f.id)}
      bbox={selection.zone.bbox}
      {graded}
      {missId}
      {revealId}
      {labels}
      enabled={!locked && !finished}
      onpick={pick}
      onview={(v) => (viewState = v)}
    />
    {#if !viewState.covers}
      <Minimap bbox={selection.zone.bbox} view={viewState.view} features={zoneFeatures} />
    {/if}
    <Prompt
      {question}
      {feedback}
      revealing={Boolean(revealId)}
      triesLeft={remaining}
      zoneLabel={selection.zone.label}
      index={quiz.index}
      total={quiz.questions.length}
      correct={tally.correct}
      onquit={toMenu}
    />
    {#if finished}
      <Results
        answers={quiz.answers}
        zoneLabel={selection.zone.label}
        previousBest={best[selection.zone.id]}
        correct={tally.correct}
        solved={tally.solved}
        total={tally.total}
        pct={tally.pct}
        {collapsed}
        ontoggle={() => (collapsed = !collapsed)}
        onreplay={replay}
        onmenu={toMenu}
        nameOf={(id) => nameById.get(id) ?? 'empty ground'}
      />
    {/if}
  {:else}
    <ZonePicker {manifest} {best} onpick={play} />
  {/if}
</main>

<style>
  main {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }
  .centred {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    gap: 0.4rem;
    padding: 1.5rem;
  }
  h1 { margin: 0; font-size: clamp(2rem, 7vw, 3rem); letter-spacing: -0.02em; }
  .hint { margin: 0.5rem 0 0; max-width: 24rem; color: var(--muted); line-height: 1.5; }
  .error { color: var(--wrong); max-width: 30rem; }
  code { background: rgba(0, 0, 0, 0.07); padding: 0.1em 0.35em; border-radius: 4px; }
</style>
