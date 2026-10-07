<script lang="ts">
  let {
    status,
    onRetry,
  }: {
    status: 'loading' | 'unavailable' | 'error';
    onRetry: () => void;
  } = $props();
</script>

<div
  class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]/40 px-3 py-2 text-xs text-[color:var(--color-text-muted)]"
>
  <span role="status">
    {#if status === 'loading'}
      Loading tier and commission details…
    {:else if status === 'unavailable'}
      Tier and commission details aren't available for this validator yet.
    {:else}
      Tier and commission details couldn't be loaded. Income history is still available.
    {/if}
  </span>
  {#if status === 'error'}
    <button
      type="button"
      onclick={onRetry}
      class="min-h-11 font-semibold text-[color:var(--color-brand-500)] underline underline-offset-2"
    >
      Retry details
    </button>
  {/if}
</div>
