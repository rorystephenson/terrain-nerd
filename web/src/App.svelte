<script lang="ts">
  import Builder from './lib/Builder.svelte';
  import Confirm from './lib/Confirm.svelte';
  import MapView from './lib/MapView.svelte';
  import Minimap from './lib/Minimap.svelte';
  import Prompt from './lib/Prompt.svelte';
  import QuizList from './lib/QuizList.svelte';
  import Results from './lib/Results.svelte';
  import { loadByIds, loadIndex, loadPlaces } from './lib/chunks.ts';
  import { placeFetchBox } from './lib/places.ts';
  import { useCoverage } from './lib/tiles.ts';
  import { gradeLabelColor } from './lib/mapStyle.ts';
  import {
    deleteQuiz as removeQuiz,
    loadBest,
    loadQuizzes,
    recordBest,
    saveQuiz,
    saveQuizzes,
  } from './lib/storage.ts';
  import {
    attempt,
    createQuiz,
    currentQuestion,
    isFinished,
    reveal,
    score,
    triesLeft,
    MAX_TRIES,
    type QuizState,
  } from './lib/quiz.ts';
  import type {
    MapLabel,
    PlaceFeature,
    PoolIndex,
    QuizFeature,
    QuizSpec,
    ViewState,
  } from './lib/types.ts';

  /** How long each kind of feedback stays on screen. */
  const FEEDBACK_MS = { correct: 550, miss: 2400 };

  type Feedback =
    | { kind: 'miss'; missedId: string | null; name: string; triesLeft: number }
    | { kind: 'correct'; name: string };

  type Screen =
    | { at: 'list' }
    | { at: 'build'; editing: QuizSpec | null }
    | { at: 'play'; spec: QuizSpec };

  let index = $state.raw<PoolIndex | null>(null);
  let loadError = $state<string | null>(null);
  let screen = $state<Screen>({ at: 'list' });

  let quizzes = $state<QuizSpec[]>([]);
  let best = $state<Record<string, number>>({});

  let features = $state.raw<QuizFeature[]>([]);
  let places = $state.raw<PlaceFeature[]>([]);
  let quiz = $state<QuizState | null>(null);
  let feedback = $state<Feedback | null>(null);
  let locked = $state(false);
  let collapsed = $state(false);
  /** The back button is waiting on an answer before it throws the round away. */
  let confirmingQuit = $state(false);
  let viewState = $state<ViewState>({
    view: [0, 0, 0, 0],
    covers: true,
    zoom: 0,
    canvas: { width: 0, height: 0 },
  });
  /** Measured, not assumed: the prompt grows with the question and the window. */
  let promptHeight = $state(0);
  let timers: ReturnType<typeof setTimeout>[] = [];

  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));

  $effect(() => {
    quizzes = loadQuizzes();
    best = loadBest();
    loadIndex()
      .then((loaded) => {
        // Before anything draws: the tile protocol needs it to tell an
        // uncovered tile from a missing one.
        useCoverage(loaded.coverage);
        index = loaded;
      })
      .catch((error: unknown) => {
        loadError = error instanceof Error ? error.message : String(error);
      });
    return clearTimers;
  });

  // Loading a quiz's features is driven by the screen, so replaying or coming
  // back from the builder always refetches exactly what this quiz needs.
  $effect(() => {
    const current = screen;
    if (current.at !== 'play' || !index) return;
    const pool = index;
    const spec = current.spec;
    let cancelled = false;

    loadByIds(pool, spec.bbox, spec.featureIds)
      .then((loaded) => {
        if (cancelled) return;
        features = loaded;
        quiz = createQuiz(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) loadError = error instanceof Error ? error.message : String(error);
      });

    return () => {
      cancelled = true;
    };
  });

  /**
   * Place names while playing, on the same rule the builder uses.
   *
   * They follow the map rather than a setting saved with the quiz: the player
   * zooms in to hunt for a peak, and the names that help at that scale are not
   * the ones that helped when the whole area was in view. They are also the only
   * names the map is allowed to show — the features being quizzed never are —
   * so switching them off just left you unable to find your way around.
   */
  $effect(() => {
    if (screen.at !== 'play' || !index) return;
    const pool = index;
    const { view: box, zoom, canvas } = viewState;
    // Before the map has reported. One test covers the zoom and the canvas too,
    // since `report` sets the whole of `ViewState` in one go.
    if (box[2] - box[0] <= 0) return;

    // Straight through on every view change, as the builder does. The cells are
    // already held, so this is a filter costing a millisecond or two.
    let cancelled = false;
    loadPlaces(pool, placeFetchBox(box, canvas), zoom).then((named) => {
      if (!cancelled) places = named;
    });

    return () => {
      cancelled = true;
    };
  });

  const nameById = $derived(new Map(features.map((f) => [f.id, f.properties.name])));
  /** Stable while the features are unchanged, so the map is not re-fed on every click. */
  const collection = $derived({ type: 'FeatureCollection' as const, features });
  const activeIds = $derived(features.map((f) => f.id));

  const question = $derived(quiz ? currentQuestion(quiz) : null);
  const finished = $derived(quiz ? isFinished(quiz) : false);
  const tally = $derived(quiz ? score(quiz) : { correct: 0, solved: 0, total: 0, pct: 0 });
  const remaining = $derived(
    feedback?.kind === 'miss' ? feedback.triesLeft : quiz ? triesLeft(quiz) : MAX_TRIES,
  );

  /**
   * Whether leaving now would cost the player something.
   *
   * A round is only written to the scores once it is finished, so anything
   * short of that is thrown away by going back — but only worth asking about
   * once there is something to throw away. Opening a zone and immediately
   * deciding it was the wrong one is not a mistake worth a dialog, and neither
   * is leaving a finished round, whose score is already saved.
   */
  const quitLosesProgress = $derived(
    quiz !== null &&
      !finished &&
      (quiz.answers.length > 0 || quiz.misses.length > 0 || quiz.revealing),
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
        color: gradeLabelColor(a.grade),
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
    if (finished && screen.at === 'play' && quiz) {
      best = recordBest(best, screen.spec.id, score(quiz).pct);
    }
  });

  function play(spec: QuizSpec) {
    clearTimers();
    feedback = null;
    locked = false;
    collapsed = false;
    confirmingQuit = false;
    quiz = null;
    features = [];
    screen = { at: 'play', spec };
  }

  function replay() {
    if (screen.at !== 'play') return;
    clearTimers();
    feedback = null;
    locked = false;
    collapsed = false;
    confirmingQuit = false;
    quiz = createQuiz(features);
  }

  function toList() {
    clearTimers();
    feedback = null;
    locked = false;
    collapsed = false;
    confirmingQuit = false;
    quiz = null;
    screen = { at: 'list' };
  }

  /** Back, via the dialog when there is a part-finished round behind it. */
  function requestQuit() {
    if (quitLosesProgress) confirmingQuit = true;
    else toList();
  }

  function onSaved(spec: QuizSpec) {
    quizzes = saveQuiz(spec);
    play(spec);
  }

  function onDelete(spec: QuizSpec) {
    quizzes = removeQuiz(spec.id);
  }

  // Scores are untouched by an import: the file never carried any.
  function onImport(imported: QuizSpec[]) {
    quizzes = imported;
    saveQuizzes(imported);
  }

  /**
   * "Show me" — the player is stuck and wants the answer.
   *
   * Without it the only way out of a question you cannot answer is to click
   * wrong things until the tries run out, which is busywork that teaches
   * nothing. It grades exactly as a reveal, and the answer still has to be
   * clicked, so the map work of actually going to find it is unchanged.
   */
  function showAnswer() {
    if (!quiz || locked || finished || quiz.revealing) return;
    clearTimers();
    feedback = null;
    quiz = reveal(quiz).state;
  }

  function pick(clickedId: string | null) {
    if (!quiz || locked || finished) return;
    // Bare ground is not a guess. It costs nothing, and it does not even clear
    // the feedback still on screen from the click before it.
    if (clickedId === null) return;
    clearTimers();

    const outcome = attempt(quiz, clickedId);
    quiz = outcome.state;

    if (outcome.kind === 'correct' || outcome.kind === 'found') {
      feedback = { kind: 'correct', name: '' };
      locked = true;
      later(() => {
        feedback = null;
        locked = false;
      }, FEEDBACK_MS.correct);
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
    later(() => {
      feedback = null;
    }, FEEDBACK_MS.miss);
  }
</script>

<main>
  {#if loadError}
    <div class="centred">
      <h1>Terrain Nerd</h1>
      <p class="error">Could not load the feature pool: {loadError}</p>
      <p class="hint">
        Run <code>npm run extract:data</code> then <code>npm run build:data</code> from the
        repo root, and reload.
      </p>
    </div>
  {:else if !index}
    <div class="centred"><p class="hint">Loading terrain…</p></div>
  {:else if screen.at === 'build'}
    <!-- Keyed so editing a different quiz starts from that quiz's own state. -->
    {#key screen.editing?.id ?? 'new'}
      <Builder {index} editing={screen.editing} onsave={onSaved} oncancel={toList} />
    {/key}
  {:else if screen.at === 'play'}
    {#if quiz}
      <Prompt
        {question}
        {feedback}
        revealing={Boolean(revealId)}
        triesLeft={remaining}
        zoneLabel={screen.spec.name}
        index={quiz.index}
        total={quiz.questions.length}
        correct={tally.correct}
        canReveal={Boolean(question) && !revealId && !locked && !finished}
        onquit={requestQuit}
        onreveal={showAnswer}
        onheight={(px) => (promptHeight = px)}
      />
      <!-- The map waits on that measurement: how much of the map the prompt
           covers decides where the map opens, and one built before it is known
           would have to move — and refetch its tiles — once it arrived. -->
      {#if promptHeight > 0}
        <MapView
          {collection}
          mode="play"
          {activeIds}
          bbox={screen.spec.bbox}
          {graded}
          {missId}
          {revealId}
          {labels}
          {places}
          enabled={!locked && !finished}
          chromeTop={promptHeight}
          onpick={pick}
          onview={(v) => (viewState = v)}
        />
        {#if !viewState.covers}
          <Minimap bbox={screen.spec.bbox} view={viewState.view} {features} />
        {/if}
      {/if}
      {#if finished}
        <Results
          answers={quiz.answers}
          zoneLabel={screen.spec.name}
          previousBest={best[screen.spec.id]}
          correct={tally.correct}
          solved={tally.solved}
          total={tally.total}
          pct={tally.pct}
          {collapsed}
          ontoggle={() => (collapsed = !collapsed)}
          onreplay={replay}
          onmenu={toList}
          nameOf={(id) => nameById.get(id) ?? 'empty ground'}
        />
      {/if}
      <!--
        Guarding the back button, not the finished-results one: that round is
        already in the scores, so there is nothing there to lose.
      -->
      {#if confirmingQuit}
        <Confirm
          title="Leave this round?"
          body="You'll lose your progress."
          confirmLabel="Leave"
          cancelLabel="Keep playing"
          onconfirm={toList}
          oncancel={() => (confirmingQuit = false)}
        />
      {/if}
    {:else}
      <div class="centred"><p class="hint">Loading the quiz…</p></div>
    {/if}
  {:else}
    <QuizList
      {index}
      {quizzes}
      {best}
      onbuild={() => (screen = { at: 'build', editing: null })}
      onplay={play}
      onedit={(spec) => (screen = { at: 'build', editing: spec })}
      ondelete={onDelete}
      onimport={onImport}
    />
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
  .hint { margin: 0.5rem 0 0; max-width: 28rem; color: var(--muted); line-height: 1.5; }
  .error { color: var(--wrong); max-width: 30rem; }
  code { background: rgba(0, 0, 0, 0.07); padding: 0.1em 0.35em; border-radius: 4px; }
</style>
