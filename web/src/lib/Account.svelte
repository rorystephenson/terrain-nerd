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

  async function signIn() {
    busy = true;
    note = null;
    try {
      const plan = await session.signIn();
      // A plan comes back only on the second-machine path, where the account
      // already existed and this device's quizzes have just been merged into
      // it. Worth a line either way: signing in and watching a list you did not
      // recognise appear is unsettling without one.
      if (plan) {
        note =
          plan.upload.length === 0
            ? 'Signed in. Your quizzes are here.'
            : `Signed in. The ${plan.upload.length === 1 ? 'quiz' : plan.upload.length + ' quizzes'} from this device ${plan.upload.length === 1 ? 'was' : 'were'} added to your account.`;
      }
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

{#if variant === 'nav'}
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
