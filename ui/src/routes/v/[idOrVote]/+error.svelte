<!--
  Validator-hub error boundary. Identical structure + auto-retry
  cadence to the income page's error page (`/income/[idOrVote]/+error.svelte`)
  so a user landing on either route sees the same recovery flow when
  the indexer is mid-rolling-deploy. Copy adjusted for the hub
  context ("validator profile" instead of "validator income").

  404 here covers both "unknown validator" AND "opted out" — the
  hub's `+page.ts` intentionally collapses both to 404 so the gate
  that fired stays unobservable.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { invalidateAll } from '$app/navigation';

  /**
   * Base retry cadence — 5 s nominal, jittered ±20 % per attempt so
   * 100 simultaneous error-page viewers don't retry in lockstep
   * during a rolling deploy and thunder-herd the indexer the moment
   * it comes back up. Matches `/income/[idOrVote]/+error.svelte`
   * in cadence but adds the jitter that surfaced in the PR-1
   * adversarial review.
   */
  const RETRY_INTERVAL_MS = 5_000;
  const RETRY_JITTER_FRACTION = 0.2;
  const MAX_AUTO_RETRIES = 6;

  /**
   * Per-attempt cadence with random jitter in `[1 - frac, 1 + frac]`.
   * Rounded to seconds so the visible countdown stays integer.
   */
  function nextCountdownSeconds(): number {
    const jitter = 1 + (Math.random() * 2 - 1) * RETRY_JITTER_FRACTION;
    return Math.max(1, Math.round((RETRY_INTERVAL_MS * jitter) / 1000));
  }

  let retryCount = $state(0);
  let retrying = $state(false);
  let countdown = $state(nextCountdownSeconds());

  $effect(() => {
    if (retryCount >= MAX_AUTO_RETRIES) return;
    const interval = setInterval(() => {
      countdown -= 1;
      if (countdown <= 0) {
        void triggerRetry();
      }
    }, 1000);
    return () => clearInterval(interval);
  });

  async function triggerRetry() {
    retrying = true;
    retryCount += 1;
    countdown = nextCountdownSeconds();
    try {
      await invalidateAll();
      // On successful recovery (no rethrown error), shift focus to
      // the page's main landmark so a keyboard/AT user mid-action
      // isn't stranded — the body element is the default focus
      // target after a SvelteKit navigation, which announces
      // nothing useful. Best-effort: if `#main` isn't present
      // (e.g. layout overrides), the focus stays where SvelteKit
      // put it.
      if (typeof document !== 'undefined') {
        const main = document.getElementById('main');
        main?.focus?.();
      }
    } finally {
      retrying = false;
    }
  }

  const status = $derived(page.status);
  const message = $derived(page.error?.message ?? 'The indexer is temporarily unreachable.');
</script>

<svelte:head>
  <title>Loading validator profile…</title>
</svelte:head>

<section
  class="mx-auto mt-20 max-w-xl rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-8 text-center"
>
  {#if status === 404}
    <h1 class="text-xl font-semibold text-[color:var(--color-text-default)]">
      Validator not found
    </h1>
    <p class="mt-3 text-sm text-[color:var(--color-text-muted)]">
      {message}
    </p>
    <!--
      We deliberately collapse the "unknown to indexer" and "opted
      out" cases to the same 404 so the gate that fired stays
      unobservable (consistent with the leaderboard + `/income/[id]`
      contract). The copy below states both possibilities so a user
      who arrives via an old shared link knows what happened, and
      so the operator who just opted out knows the page is in the
      expected state.
    -->
    <p class="mt-2 text-xs text-[color:var(--color-text-muted)]">
      The validator may not be indexed yet, or may have opted out of public scoring. No automated
      retries — neither case recovers on a refresh.
    </p>
    <a
      href="/"
      class="mt-6 inline-flex items-center rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-brand-600)]"
    >
      Back to top validators
    </a>
  {:else}
    <h1 class="text-xl font-semibold text-[color:var(--color-text-default)]">Refreshing…</h1>
    <p class="mt-3 text-sm text-[color:var(--color-text-muted)]">
      The indexer API didn't respond. This usually means the server is restarting — give it a few
      seconds.
    </p>

    {#if retryCount < MAX_AUTO_RETRIES}
      <p class="mt-6 text-xs text-[color:var(--color-text-subtle)]">
        {#if retrying}
          Retrying now…
        {:else}
          Retrying automatically in <span class="font-mono">{countdown}s</span>
          (attempt {retryCount + 1} of {MAX_AUTO_RETRIES})
        {/if}
      </p>
    {:else}
      <p class="mt-6 text-xs text-[color:var(--color-text-subtle)]">
        Still unreachable after {MAX_AUTO_RETRIES} auto-retries. The indexer may need manual attention.
      </p>
    {/if}

    <div class="mt-6 flex items-center justify-center gap-3">
      <button
        type="button"
        onclick={() => void triggerRetry()}
        disabled={retrying}
        class="inline-flex items-center rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-brand-600)] disabled:opacity-50"
      >
        {retrying ? 'Checking…' : 'Retry now'}
      </button>
      <a
        href="/"
        class="inline-flex items-center rounded-lg border border-[color:var(--color-border-default)] px-4 py-2 text-sm font-semibold text-[color:var(--color-text-default)] hover:bg-[color:var(--color-surface-muted)]"
      >
        Back to top
      </a>
    </div>

    {#if status !== undefined && status !== 500}
      <p class="mt-6 text-[11px] text-[color:var(--color-text-subtle)]">
        HTTP <span class="font-mono">{status}</span> — {message}
      </p>
    {/if}
  {/if}
</section>
