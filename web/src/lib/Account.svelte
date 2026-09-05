<script lang="ts">
  import { session } from './session.svelte.ts';

  type Props = {
    /**
     * `nudge` is the same control with a reason attached, shown once after a
     * finished round. Same code path, so there is only ever one sign-in button
     * in this app however many places offer it.
     */
    variant?: 'inline' | 'nudge';
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
  -->
  <div class="offer">
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

{#if note}<p class="note">{note}</p>{/if}

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
    background: #fff;
    border: 1px solid var(--accent);
    border-radius: 10px;
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
