<script lang="ts">
  /**
   * A modal that has to be answered before anything behind it can be touched.
   *
   * It covers the whole screen rather than sitting near what it is asking
   * about, because the thing it guards — leaving a round part-finished — is
   * exactly the sort of one-tap mistake that a dialog next to the button would
   * catch too late.
   */
  type Props = {
    title: string;
    body: string;
    /** The wording on the button that goes through with it. */
    confirmLabel: string;
    cancelLabel: string;
    onconfirm: () => void;
    oncancel: () => void;
  };

  let { title, body, confirmLabel, cancelLabel, onconfirm, oncancel }: Props = $props();

  /**
   * Focus starts on cancel, not on confirm: a stray Enter or Space left over
   * from whatever opened this should keep the round, never bin it.
   */
  let cancelButton = $state<HTMLButtonElement | null>(null);
  $effect(() => cancelButton?.focus());

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    oncancel();
  }

  /**
   * Only a click on the backdrop itself dismisses. Testing the target rather
   * than stopping the click inside the card keeps the card a plain container:
   * a div that swallows clicks is one a screen reader has to be told about.
   */
  function onbackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) oncancel();
  }
</script>

<svelte:window {onkeydown} />

<!-- Clicking the backdrop cancels, which is the harmless answer. -->
<div class="overlay" role="presentation" onclick={onbackdrop}>
  <div
    class="card"
    role="alertdialog"
    aria-modal="true"
    aria-label={title}
    aria-describedby="confirm-body"
  >
    <h2>{title}</h2>
    <p id="confirm-body">{body}</p>
    <div class="actions">
      <button class="go" onclick={onconfirm}>{confirmLabel}</button>
      <button class="stay" bind:this={cancelButton} onclick={oncancel}>{cancelLabel}</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    /* Above the prompt and the results card: nothing behind it is clickable. */
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgba(30, 36, 44, 0.45);
    backdrop-filter: blur(3px);
  }
  .card {
    width: min(23rem, 100%);
    background: #fff;
    border-radius: 14px;
    padding: 1.4rem;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.3);
  }
  h2 {
    margin: 0;
    font-size: 1.25rem;
    letter-spacing: -0.01em;
  }
  p {
    margin: 0.5rem 0 1.2rem;
    color: var(--muted);
    line-height: 1.45;
  }

  /*
   * Staying is the primary button. The dialog only ever appears when there is
   * progress to lose, so the safe answer should be the one under the thumb.
   */
  .actions { display: flex; gap: 0.5rem; }
  button {
    flex: 1;
    padding: 0.75rem 1rem;
    font: inherit;
    font-weight: 600;
    border-radius: 9px;
    cursor: pointer;
  }
  .stay {
    color: #fff;
    background: var(--accent);
    border: 0;
  }
  .stay:hover { filter: brightness(1.08); }
  .go {
    color: var(--wrong);
    background: transparent;
    border: 1px solid rgba(214, 69, 69, 0.4);
  }
  .go:hover { background: rgba(214, 69, 69, 0.08); border-color: var(--wrong); }
</style>
