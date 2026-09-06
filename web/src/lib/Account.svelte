<script lang="ts">
  import { session } from './session.svelte.ts';

  type Props = {
    /**
     * `nudge` is the same control with a reason attached, shown once after a
     * finished round; `nav` is the same control with the reason dropped, because
     * the bar has no room for a sentence. Same code path, so there is only ever
     * one sign-in button in this app however many places offer it.
     */
    variant?: 'inline' | 'nudge' | 'nav';
  };
  let { variant = 'inline' }: Props = $props();

  let busy = $state(false);
  let note = $state<string | null>(null);

  const account = $derived(session.account);
  const offered = $derived(session.offered);

  async function signIn() {
    busy = true;
    note = null;
    try {
      const plan = await session.signIn();
      // A plan comes back only on the second-machine path, where the account
      // already existed. `offered` drives the panel below.
      if (plan && plan.upload.length === 0) note = 'Signed in. Your quizzes are here.';
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Closing the popup is not an error worth reporting back.
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        note = 'That did not work. Try again?';
      }
    } finally {
      busy = false;
    }
  }
</script>

{#if offered.length > 0}
  <!--
    The one moment worth interrupting for. Moving somebody's work into an
    account they had already made on another machine is not a thing to do
    quietly, and it is also not a thing to do without saying what it will do.

    Which is why, in the nav, it does not render in the nav: a decision this
    size squeezed into a bar would be a decision made by accident. It drops out
    of the bar and hangs under it instead, at the width it needs.
  -->
  <div class="offer" class:offer--hanging={variant === 'nav'}>
    <p>
      You already had an account. Keep the {offered.length}
      {offered.length === 1 ? 'quiz' : 'quizzes'} made on this device as well?
    </p>
    <ul>
      {#each offered as quiz (quiz.id)}<li>{quiz.name}</li>{/each}
    </ul>
    <div class="row">
      <button class="yes" onclick={() => session.acceptOffered()}>Keep them</button>
      <button onclick={() => session.declineOffered()}>Not now</button>
    </div>
  </div>
{:else if variant === 'nav'}
  {#if account?.anonymous}
    <button class="signin" onclick={signIn} disabled={busy}>
      {busy ? 'Signing in…' : 'Sign in'}
    </button>
  {:else if account}
    <span class="whoami">
      <span class="who who--nav">{account.name ?? 'Signed in'}</span>
      <button class="link" onclick={() => session.signOut()}>Sign out</button>
    </span>
  {/if}
{:else if account?.anonymous && variant === 'nudge'}
  <p class="nudge">
    Your scores are saved on this device.
    <button class="link" onclick={signIn} disabled={busy}>
      {busy ? 'Signing in…' : 'Sign in'}
    </button>
    and they will follow you to the next one.
  </p>
{:else if account?.anonymous}
  <p class="line">
    <button class="link" onclick={signIn} disabled={busy}>
      {busy ? 'Signing in…' : 'Sign in'}
    </button>
    <span class="why">to keep your quizzes and scores if you change device.</span>
  </p>
{:else if account}
  <p class="line">
    <span class="who">{account.name ?? 'Signed in'}</span>
    <button class="link" onclick={() => session.signOut()}>Sign out</button>
  </p>
{/if}

{#if note}<p class="note" class:note--nav={variant === 'nav'}>{note}</p>{/if}

<style>
  .line {
    margin: 0.9rem 0 0;
    font-size: 0.82rem;
    color: var(--muted);
    text-align: center;
  }
  .who { font-weight: 600; color: #1d232b; margin-right: 0.5rem; }
  .why { margin-left: 0.3rem; }
  .link {
    font: inherit;
    font-weight: 650;
    color: var(--accent);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  .link:disabled { opacity: 0.5; cursor: default; }

  .offer {
    margin: 1rem 0 0;
    padding: 0.9rem 1rem;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--r-md);
  }
  /* Out of the bar's flex row and under it, still inside the nav's own box. */
  .offer--hanging {
    position: absolute;
    top: 100%;
    right: clamp(0.9rem, 3vw, 1.5rem);
    z-index: 7;
    width: min(22rem, calc(100vw - 2rem));
    margin: 0.4rem 0 0;
    box-shadow: var(--lift-panel);
  }

  /* Compact enough for the bar, and still a real target on a phone. */
  .signin {
    padding: 0.38rem 0.8rem;
    font: inherit;
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--surface);
    background: var(--accent);
    border: 0;
    border-radius: var(--r-pill);
    cursor: pointer;
    white-space: nowrap;
  }
  .signin:disabled { opacity: 0.6; cursor: default; }

  .whoami {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.86rem;
    color: var(--muted);
  }
  .who--nav {
    display: block;
    margin-right: 0;
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.86rem;
  }
  .note--nav {
    position: absolute;
    top: 100%;
    right: clamp(0.9rem, 3vw, 1.5rem);
    margin: 0.35rem 0 0;
    padding: 0.35rem 0.7rem;
    background: var(--glass);
    border-radius: var(--r-pill);
  }
  .offer p { margin: 0; font-size: 0.9rem; line-height: 1.5; }
  .offer ul {
    margin: 0.5rem 0 0.75rem;
    padding-left: 1.1rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .row { display: flex; gap: 0.5rem; }
  .row button {
    flex: 1;
    padding: 0.55rem;
    font: inherit;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 8px;
    cursor: pointer;
  }
  .row .yes { color: #fff; background: var(--accent); border-color: var(--accent); font-weight: 650; }

  .nudge {
    margin: 0.6rem 0 0;
    padding: 0.55rem 0.7rem;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--muted);
    background: rgba(0, 0, 0, 0.04);
    border-radius: 7px;
  }

  .note { margin: 0.5rem 0 0; font-size: 0.82rem; color: var(--accent); text-align: center; }
</style>
