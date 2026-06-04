<!--
  Shared empty-state for IncomeChart / ComputeUnitsChart.

  Rendered when THIS validator has no own line to plot yet (no produced
  blocks recorded in the window). The indexed / same-client averages are
  shown small underneath as reference context — deliberately NOT drawn as
  a full chart. A lone cohort line on an otherwise-empty chart reads as
  "this validator", which is the exact confusion this state exists to
  avoid: the two charts only plot cohort lines ALONGSIDE the validator's
  own line, never on their own.
-->
<script lang="ts">
  interface CohortStat {
    label: string;
    value: string;
  }

  let { message, cohortStats = [] }: { message: string; cohortStats?: CohortStat[] } = $props();
</script>

<div class="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
  <p class="max-w-md text-sm text-[color:var(--color-text-muted)]">{message}</p>
  {#if cohortStats.length > 0}
    <div class="text-xs text-[color:var(--color-text-subtle)]">
      <span class="uppercase tracking-wide">For reference</span>
      <div class="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1">
        {#each cohortStats as stat (stat.label)}
          <span>{stat.label}: <span class="tabular-nums">{stat.value}</span></span>
        {/each}
      </div>
    </div>
  {/if}
</div>
