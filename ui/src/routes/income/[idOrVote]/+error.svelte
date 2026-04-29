<!--
  Income page error boundary.

  SvelteKit renders this when the route's `load` function throws (e.g.
  the indexer API is down during a rolling deploy, pod restart, DB
  migration in progress). The default error page is a generic
  "500 — Internal Server Error" — accurate but unfriendly when the
  operator deploys and users happen to click a link at the wrong
  second.

  Shows a softer explanation + an auto-retry so the page recovers
  on its own once the API comes back, typically within 10-30 seconds.
  Also exposes the HTTP status for power users debugging a real
  outage.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { invalidateAll } from '$app/navigation';

  /**
   * Retry cadence — 5s × 6 attempts = 30s total wall time before we
   * stop auto-retrying. That's long enough to cover a standard
   * rolling deploy (Helm terminationGracePeriodSeconds + new pod
   * boot ≈ 15-25s) without flooding the just-recovering server
   * with a reload storm if the issue persists.
   */
  const RETRY_INTERVAL_MS = 5_000;
  const MAX_AUTO_RETRIES = 6;

  let retryCount = $state(0);
  let retrying = $state(false);
  let countdown = $state(RETRY_INTERVAL_MS / 1000);

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
    countdown = RETRY_INTERVAL_MS / 1000;
    try {
      // `invalidateAll` re-runs every load function on the current
      // route. If the server is back, the error page disappears and
      // the actual income page renders.
      await invalidateAll();
    } finally {
      retrying = false;
    }
  }

  onMount(() => {
    // Cap-less on manual retry — the user pressing the button is a
    // deliberate "I want this now" signal.
  });

  const status = $derived(page.status);
  const message = $derived(page.error?.message ?? 'The indexer is temporarily unreachable.');
</script>

<svelte:head>
  <title>Loading validator income…</title>
</svelte:head>

<section
  class="mx-auto mt-20 max-w-xl rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-8 text-center"
>
  {#if status === 404}
    <!--
      Specific 404 copy: the user typed a pubkey the indexer couldn't
      resolve (either not a valid Solana pubkey or — for a genuine
      unknown — our auto-track rejected it for stake-floor reasons).
    -->
    <h1 class="text-xl font-semibold text-[color:var(--color-text-default)]">
      Validator not found
    </h1>
    <p class="mt-3 text-sm text-[color:var(--color-text-muted)]">
      {message}
    </p>
    <a
      href="/"
      class="mt-6 inline-flex items-center rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-brand-600)]"
    >
      Back to top validators
    </a>
  {:else}
    <!--
      All other errors: likely API unavailable (deploy, restart,
      timeout). Treat as recoverable and auto-retry.
    -->
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
      <!--
        Surface the HTTP status when it's meaningful (anything other
        than the default 500). Helps us diagnose if users report
        specific codes.
      -->
      <p class="mt-6 text-[11px] text-[color:var(--color-text-subtle)]">
        HTTP <span class="font-mono">{status}</span> — {message}
      </p>
    {/if}
  {/if}
</section>
