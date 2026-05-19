<!--
  IncomeSummaryStrip — at-a-glance income context for the hub.

  Two halves on desktop, stacked on mobile:
    - Three KpiStat tiles — lifetime / last 30 days / last 7 days
      total income (fees + tips). All driven by the SSR-loaded
      history rows; no extra fetch.
    - A 16-epoch mini sparkline of total income per closed epoch,
      with a deep-link to `/income/:vote` for the full table.

  Cold-start ("brand-new validator, no closed rows") collapses to a
  single muted line — "Income data starts populating once this
  validator finalizes its first epoch." The hub keeps the section
  visible (shorter, not sadder) but skips the KPIs + sparkline so a
  visitor isn't misled by ◎0.000 placeholders.

  Honesty in the sums: every row that wasn't yet `isFinal=true` is
  excluded (the running epoch's partial total would inflate "last
  N days"). If a final row's fee+tip fields are null (rare — only
  during a backfill window) it's treated as zero, but a row with
  ZERO actual income is preserved (legitimately a quiet epoch is
  different from a missing one).

  Props:
    - `vote`: vote pubkey, used to build the `/income/:vote` deep
      link to the full epoch table.
    - `items`: history items (newest-first by API contract). May be
      empty for never-finalized validators.
    - `epochDurationDaysApprox`: rough days per epoch (mainnet ≈ 2)
      used to convert "last N rows" into the human window. Allowed
      to be passed by the caller for testability.
-->
<script lang="ts">
  import type { ValidatorEpochRecord } from '$lib/types';
  import KpiStat from './KpiStat.svelte';
  import { formatSolFixed } from '$lib/format';

  interface Props {
    vote: string;
    items: ReadonlyArray<ValidatorEpochRecord>;
    epochDurationDaysApprox?: number;
  }

  let { vote, items, epochDurationDaysApprox = 2 }: Props = $props();

  /** Final rows only, newest-first (the API already returns that order). */
  const finalRows = $derived(items.filter((r) => r.isFinal === true));

  /** Pick the N most recent final rows for a "last N days" window. */
  function lastNRows(n: number): ValidatorEpochRecord[] {
    return finalRows.slice(0, n);
  }

  /**
   * Sum `blockFeesTotalLamports + blockTipsTotalLamports` across the
   * passed rows. Returns a `bigint` so we never lose precision on
   * lamports totals. `null` fields are treated as missing for the
   * "any income data?" flag below; the sum still adds them as 0.
   */
  function sumIncomeLamports(rows: ReadonlyArray<ValidatorEpochRecord>): {
    sum: bigint;
    hasAny: boolean;
  } {
    let sum = 0n;
    let hasAny = false;
    for (const row of rows) {
      if (row.blockFeesTotalLamports !== null) {
        sum += BigInt(row.blockFeesTotalLamports);
        hasAny = true;
      }
      if (row.blockTipsTotalLamports !== null) {
        sum += BigInt(row.blockTipsTotalLamports);
        hasAny = true;
      }
    }
    return { sum, hasAny };
  }

  // Approximate "last 30 days" = 15 closed epochs (mainnet epochs ≈ 2 days).
  // Approximate "last 7 days"  = 4 closed epochs. `$derived` so a
  // parent that re-passes `epochDurationDaysApprox` (e.g. a
  // future devnet variant) updates the window without remount.
  const rows30d = $derived(Math.max(1, Math.round(30 / epochDurationDaysApprox)));
  const rows7d = $derived(Math.max(1, Math.round(7 / epochDurationDaysApprox)));

  const lifetime = $derived(sumIncomeLamports(finalRows));
  const last30d = $derived(sumIncomeLamports(lastNRows(rows30d)));
  const last7d = $derived(sumIncomeLamports(lastNRows(rows7d)));

  /**
   * Format a lamports bigint as a 3-decimal SOL string, or `—` when
   * we have no income data for the window. Matches the income page
   * hero's same convention.
   */
  function formatLamports(state: { sum: bigint; hasAny: boolean }): string {
    if (!state.hasAny) return '—';
    return formatSolFixed(state.sum.toString(), 3);
  }

  const lifetimeLabel = $derived(formatLamports(lifetime));
  const last30dLabel = $derived(formatLamports(last30d));
  const last7dLabel = $derived(formatLamports(last7d));

  /**
   * 16-epoch sparkline data. Each point is total income (fees + tips)
   * for that closed epoch. Polyline is rendered in viewBox space
   * so it scales with the container; X is the row index (oldest
   * left, newest right), Y is normalised against the window max.
   */
  const SPARK_ROWS = 16;
  const sparkRows = $derived(lastNRows(SPARK_ROWS).slice().reverse());

  /**
   * Per-epoch SOL totals for the sparkline. Pure numbers (not strings)
   * because we need to map to polyline points; we use the SOL string
   * from the API (already lamports / 1e9) and parse it once.
   */
  const sparkPoints = $derived(
    sparkRows.map((row) => {
      const fees = row.blockFeesTotalSol === null ? 0 : Number(row.blockFeesTotalSol);
      const tips = row.blockTipsTotalSol === null ? 0 : Number(row.blockTipsTotalSol);
      const total = (Number.isFinite(fees) ? fees : 0) + (Number.isFinite(tips) ? tips : 0);
      return { epoch: row.epoch, total };
    }),
  );

  /** Window max — drives the Y scale. Bottom is always 0 so a quiet epoch reads correctly. */
  const sparkMax = $derived(Math.max(0, ...sparkPoints.map((p) => p.total)));

  /** Polyline points string in a 100×30 viewBox (svg-ratio agnostic). */
  const sparkPath = $derived.by(() => {
    if (sparkPoints.length === 0) return '';
    if (sparkPoints.length === 1) {
      // Single-point fallback — draw a flat short segment at the centre.
      return '0,15 100,15';
    }
    const stepX = 100 / (sparkPoints.length - 1);
    return sparkPoints
      .map((p, i) => {
        const x = (i * stepX).toFixed(2);
        const y = sparkMax === 0 ? 27 : (28 - (p.total / sparkMax) * 26).toFixed(2);
        return `${x},${y}`;
      })
      .join(' ');
  });

  /** True when no closed epoch has any income data — drives the cold-start state. */
  const isColdStart = $derived(!lifetime.hasAny && !last30d.hasAny && !last7d.hasAny);
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="income-summary-heading"
>
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <h2 id="income-summary-heading" class="text-base font-semibold tracking-tight">
      Income summary
    </h2>
    <a href={`/income/${vote}`} class="text-xs text-[color:var(--color-brand-500)] hover:underline">
      See full epoch history ›
    </a>
  </header>

  {#if isColdStart}
    <p class="text-sm text-[color:var(--color-text-muted)]">
      Income data starts populating once this validator finalizes its first epoch with leader slots.
    </p>
  {:else}
    <div class="grid grid-cols-3 gap-3 sm:gap-4">
      <KpiStat
        label="Lifetime"
        suffix="SOL"
        title="Total block fees + Jito tips across every closed epoch."
      >
        {lifetimeLabel}
      </KpiStat>
      <KpiStat
        label="Last 30d"
        suffix="SOL"
        title="Sum of fees + tips over the {rows30d} most-recent closed epochs (~30 days)."
      >
        {last30dLabel}
      </KpiStat>
      <KpiStat
        label="Last 7d"
        suffix="SOL"
        title="Sum of fees + tips over the {rows7d} most-recent closed epochs (~7 days)."
      >
        {last7dLabel}
      </KpiStat>
    </div>

    {#if sparkPoints.length > 0}
      <!--
        Mini sparkline. 100×30 viewBox lets the SVG scale fluidly
        without aspect-ratio drift. Stroke uses `currentColor`
        through the brand token so dark mode inherits automatically.
        `prefers-reduced-motion` is honored globally via app.css.
      -->
      <div class="mt-4 flex items-center gap-3">
        <svg
          viewBox="0 0 100 30"
          preserveAspectRatio="none"
          class="h-10 flex-1 text-[color:var(--color-brand-500)]"
          role="img"
          aria-label="Last {sparkPoints.length} closed epochs income trend"
        >
          <polyline
            points={sparkPath}
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <span class="text-xs tabular-nums text-[color:var(--color-text-muted)]">
          {sparkPoints[0]?.epoch ?? ''}–{sparkPoints.at(-1)?.epoch ?? ''}
        </span>
      </div>
      <!--
        sr-only data list mirrors the audit-list pattern — AT users
        get the per-epoch numbers the polyline can't surface.
      -->
      <div class="sr-only">
        <p>Per-epoch total income, oldest first:</p>
        <dl>
          {#each sparkPoints as p (p.epoch)}
            <dt>Epoch {p.epoch}</dt>
            <dd>{p.total.toFixed(3)} SOL</dd>
          {/each}
        </dl>
      </div>
    {/if}
  {/if}
</section>
