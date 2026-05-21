<!--
  Client-only loader for `ComputeUnitsChart`. Mirrors
  `IncomeChartLoader` exactly: LayerChart is not safe to import during
  SSR / static prerender, so the chart module is dynamically imported
  in `onMount` and a styled placeholder card holds the layout until it
  resolves. Keeping the loader shape identical to IncomeChartLoader
  means the two charts size + fall back the same way.
-->
<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import type { ValidatorEpochRecord } from '$lib/types';

  let { history }: { history: ValidatorEpochRecord[] } = $props();

  type ComputeUnitsChartComponent = Component<{ history: ValidatorEpochRecord[] }>;

  let Chart = $state<ComputeUnitsChartComponent | null>(null);
  let loadFailed = $state(false);

  onMount(() => {
    let mounted = true;

    void import('./ComputeUnitsChart.svelte')
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
    aria-labelledby="cu-chart-loading-title"
    aria-busy={!loadFailed}
  >
    <header class="mb-3 flex items-baseline justify-between gap-3">
      <div>
        <h2 id="cu-chart-loading-title" class="text-sm font-semibold">Compute units per block</h2>
        <p class="text-xs text-[color:var(--color-text-muted)]">
          Average compute units per produced block.
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
          Loading compute units chart...
        {/if}
      </p>
    </div>
  </section>
{/if}
