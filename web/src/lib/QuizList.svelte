<script lang="ts">
  import { makeQuizFile, mergeQuizFile, quizFilename, readQuizFile } from './storage.ts';
  import type { PoolIndex, QuizSpec } from './types.ts';

  type Props = {
    index: PoolIndex;
    quizzes: QuizSpec[];
    /** Best first-try percentage per quiz id. */
    best: Record<string, number>;
    onbuild: () => void;
    onplay: (quiz: QuizSpec) => void;
    onedit: (quiz: QuizSpec) => void;
    ondelete: (quiz: QuizSpec) => void;
    onimport: (quizzes: QuizSpec[]) => void;
  };

  let { index, quizzes, best, onbuild, onplay, onedit, ondelete, onimport }: Props = $props();

  const total = $derived(index.kinds.reduce((sum, kind) => sum + kind.count, 0));

  let picker: HTMLInputElement;
  let note = $state<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  /**
   * Writes one quiz out as a download.
   *
   * Quizzes live only in this browser's localStorage, which is wiped by
   * clearing site data and is not synced anywhere — so a file you keep yourself
   * is the only thing standing between you and losing one. The file holds the
   * quiz alone: your scores stay here, where you earned them.
   */
  function exportOne(quiz: QuizSpec) {
    const blob = new Blob([JSON.stringify(makeQuizFile([quiz]), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = quizFilename(quiz.name);
    link.click();
    URL.revokeObjectURL(url);
    note = { tone: 'ok', text: `Saved “${quiz.name}”.` };
  }

  async function importQuiz(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared straight away so picking the same file twice still fires a change.
    input.value = '';
    if (!file) return;

    try {
      const merged = mergeQuizFile(quizzes, readQuizFile(await file.text()));
      onimport(merged.quizzes);
      const parts = [
        merged.added > 0 ? `${merged.added} added` : '',
        merged.replaced > 0 ? `${merged.replaced} updated` : '',
      ].filter(Boolean);
      note = { tone: 'ok', text: parts.length ? `Loaded: ${parts.join(', ')}.` : 'Nothing new to load.' };
    } catch (error) {
      note = { tone: 'bad', text: error instanceof Error ? error.message : String(error) };
    }
  }
</script>

<div class="picker">
  <header>
    <h1>Terrain Nerd</h1>
    <p class="lede">Learn the terrain you fly</p>
    <p class="hint">
      Build a quiz for an area you care about, then replay it until you know it. Every round
      asks the same set in a new order. Four tries a question, then you are shown the answer
      and have to go and click it.
    </p>
  </header>

  <button class="build" onclick={onbuild}>+ Build a quiz</button>

  {#if quizzes.length > 0}
    <h2>Your quizzes</h2>
    <ul class="quizzes">
      {#each quizzes as quiz (quiz.id)}
        <li>
          <button class="row" onclick={() => onplay(quiz)}>
            <span class="name">{quiz.name}</span>
            <span class="meta">
              {#if best[quiz.id] !== undefined}
                <span class="best" class:perfect={best[quiz.id] === 100}>{best[quiz.id]}%</span>
              {/if}
              <span class="count">{quiz.features.length}</span>
            </span>
          </button>
          <button class="icon" title="Save to file" aria-label="Save {quiz.name} to file" onclick={() => exportOne(quiz)}>↓</button>
          <button class="icon" title="Edit" aria-label="Edit {quiz.name}" onclick={() => onedit(quiz)}>✎</button>
          <button class="icon" title="Delete" aria-label="Delete {quiz.name}" onclick={() => ondelete(quiz)}>×</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">
      No quizzes yet. Build one for the area you fly most — pick the peaks and valleys you
      actually want to know, and skip the rest.
    </p>
  {/if}

  <section class="backup">
    <h2>Quiz files</h2>
    <p class="why">
      Quizzes are stored in this browser only, so clearing site data loses them. Use
      <span class="glyph">↓</span> on a quiz to save it to a file. A file holds the quiz
      itself, not your scores.
    </p>
    <div class="backup-actions">
      <button onclick={() => picker.click()}>Load a quiz from file</button>
    </div>
    <input
      class="file-input"
      type="file"
      accept="application/json,.json"
      bind:this={picker}
      onchange={importQuiz}
    />
    {#if note}
      <p class="note" class:bad={note.tone === 'bad'}>{note.text}</p>
    {/if}
  </section>

  <footer>
    {total.toLocaleString()} named features · {index.attribution} · data {index.generatedAt}
  </footer>
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

  .build {
    width: 100%;
    margin: 1.75rem 0 0;
    padding: 0.85rem;
    font: inherit;
    font-weight: 650;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: 10px;
    cursor: pointer;
  }

  h2 {
    margin: 1.75rem 0 0.6rem;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .quizzes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
  .quizzes li { display: flex; gap: 0.3rem; }
  .row {
    flex: 1;
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
  .row:hover { border-color: var(--accent); background: #fbfdfb; }
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

  .icon {
    width: 2.2rem;
    font: inherit;
    font-size: 1rem;
    color: var(--muted);
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 9px;
    cursor: pointer;
  }
  .icon:hover { color: #1d232b; border-color: rgba(0, 0, 0, 0.25); }

  .empty {
    margin: 1.5rem 0 0;
    padding: 1.25rem;
    color: var(--muted);
    text-align: center;
    line-height: 1.55;
    background: rgba(0, 0, 0, 0.03);
    border-radius: 10px;
  }

  .backup {
    margin-top: 2rem;
    padding-top: 1.25rem;
    border-top: 1px solid rgba(0, 0, 0, 0.1);
  }
  .backup h2 { margin-top: 0; }
  .why { margin: 0 0 0.6rem; font-size: 0.85rem; color: var(--muted); line-height: 1.5; }
  .glyph { color: #1d232b; font-weight: 700; }
  .backup-actions { display: flex; gap: 0.5rem; }
  .backup-actions button {
    flex: 1;
    padding: 0.6rem;
    font: inherit;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 8px;
    cursor: pointer;
  }
  .backup-actions button:hover:not(:disabled) { border-color: var(--accent); }
  .backup-actions button:disabled { opacity: 0.45; cursor: not-allowed; }
  /* Driven by the buttons above; a bare file input is ugly. Note this must not
     be called `.picker` — that is the root element's class, and the rule would
     hide the entire page. */
  .file-input { display: none; }
  .note { margin: 0.6rem 0 0; font-size: 0.85rem; color: var(--accent); }
  .note.bad { color: var(--wrong); }

  footer {
    margin-top: 1.75rem;
    text-align: center;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
