<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import type { ValidatorEpochRecord } from '$lib/types';

  let { history }: { history: ValidatorEpochRecord[] } = $props();

  type IncomeChartComponent = Component<{ history: ValidatorEpochRecord[] }>;

  let Chart = $state<IncomeChartComponent | null>(null);
  let loadFailed = $state(false);

  onMount(() => {
    let mounted = true;

    void import('./IncomeChart.svelte')
      .then((mod) => {
        if (mounted) Chart = mod.default;
      })
      .catch(() => {
        if (mounted) loadFailed = true;
      });

    return () => {
      mounted = false;
    };
  });
</script>

{#if Chart !== null}
  <Chart {history} />
{:else}
  <section
    class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
    aria-labelledby="chart-loading-title"
    aria-busy={!loadFailed}
  >
    <header class="mb-3 flex items-baseline justify-between gap-3">
      <div>
        <h2 id="chart-loading-title" class="text-sm font-semibold">Income per leader slot</h2>
        <p class="text-xs text-[color:var(--color-text-muted)]">
          Total income normalized by scheduled leader slots.
        </p>
      </div>
    </header>
    <div
      class="flex h-72 items-center justify-center rounded-lg border border-dashed border-[color:var(--color-border-default)]"
      role="status"
    >
      <p class="text-sm text-[color:var(--color-text-muted)]">
        {#if loadFailed}
          Chart could not be loaded. Refresh the page to try again.
        {:else}
          Loading income chart...
        {/if}
      </p>
    </div>
  </section>
{/if}
