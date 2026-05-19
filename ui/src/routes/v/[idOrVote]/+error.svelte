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

  /** Retry cadence — matches `/income/[idOrVote]/+error.svelte`. */
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
      await invalidateAll();
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
    <p class="mt-2 text-xs text-[color:var(--color-text-subtle)]">
      The validator may not be indexed yet, or may have opted out of public scoring.
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
