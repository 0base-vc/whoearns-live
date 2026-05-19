<!--
  IncomeSummaryStrip — at-a-glance income context for the hub.

  Two halves on desktop, stacked on mobile:
    - Three KpiStat tiles — "Last 60 days" / "Last 30 days" / "Last 7
      days" total income (fees + tips), driven by the SSR-loaded
      history rows. NOT lifetime — earlier copy claimed "Lifetime"
      but the SSR loader caps history at 30 closed epochs, so the
      tile honestly reports a recent window instead.
    - A 16-epoch mini sparkline of total income per closed epoch,
      with a deep-link to `/income/:vote` for the full table (gated
      so we don't surface the link when there's nothing to drill
      into).

  Cold-start ("brand-new validator, no closed rows") collapses to a
  single muted line — "This validator hasn't earned its first epoch
  of fees yet." The hub keeps the section visible (shorter, not
  sadder) but skips the KPIs + sparkline so a visitor isn't misled
  by ◎0.000 placeholders.

  Lamports/SOL conversion: every numeric tile and the sparkline pass
  through `lamportsStringToSolNumber` (`$lib/format`) before
  formatting. Earlier revision fed the lamports bigint directly to
  `formatSolFixed`, which expects an already-converted SOL string —
  result was a 10⁹× inflation on every claimed validator. Pinned by
  the unit tests for this component's helpers.

  Honesty in the sums: rows that are not `isFinal=true` are excluded
  (the running epoch's partial total would inflate every window).
  Fee/tip fields that are `null` (rare — backfill window) are skipped
  but a row with literally zero income is preserved (a legitimately
  quiet epoch is different from missing data).

  Props:
    - `vote`: vote pubkey, used to build the `/income/:vote` deep
      link to the full epoch table.
    - `items`: history items (newest-first by API contract). May be
      empty for never-finalized validators.
    - `epochDurationDaysApprox`: rough days per epoch (mainnet ≈ 2,
      devnet ≈ 0.4) — surfaces the right window labels per cluster.
-->
<script lang="ts">
  import type { ValidatorEpochRecord } from '$lib/types';
  import KpiStat from './KpiStat.svelte';
  import { lamportsStringToSolNumber } from '$lib/format';

  interface Props {
    vote: string;
    items: ReadonlyArray<ValidatorEpochRecord>;
    epochDurationDaysApprox?: number;
    /**
     * When the parent has ALREADY surfaced a "this validator is
     * brand-new" explanation elsewhere on the page (e.g. the tier
     * card's unrated-reason line), set this to `true` to hide the
     * strip's cold-start prose. Two warm apologies in adjacent
     * sections reads as "we keep apologising for empty data."
     * Section heading still renders so the page rhythm is intact.
     */
    suppressColdStartProse?: boolean;
  }

  let {
    vote,
    items,
    epochDurationDaysApprox = 2,
    suppressColdStartProse = false,
  }: Props = $props();

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
      // Try/catch per field so a single malformed lamports string
      // (e.g. an unexpected non-numeric from an API regression)
      // doesn't crash the whole `$derived` and unmount the strip.
      // Symmetric with the sparkline accumulator — earlier
      // revision only guarded the sparkline path.
      if (row.blockFeesTotalLamports !== null) {
        try {
          sum += BigInt(row.blockFeesTotalLamports);
          hasAny = true;
        } catch {
          // Malformed → ignore this contribution but keep tallying.
        }
      }
      if (row.blockTipsTotalLamports !== null) {
        try {
          sum += BigInt(row.blockTipsTotalLamports);
          hasAny = true;
        } catch {
          // Same posture as above — partial credit beats total render crash.
        }
      }
    }
    return { sum, hasAny };
  }

  // Window sizes (in closed-epoch rows) for the three tiles. `$derived`
  // so a parent that re-passes `epochDurationDaysApprox` (e.g. a
  // devnet variant) updates the windows without remount.
  const rows60d = $derived(Math.max(1, Math.round(60 / epochDurationDaysApprox)));
  const rows30d = $derived(Math.max(1, Math.round(30 / epochDurationDaysApprox)));
  const rows7d = $derived(Math.max(1, Math.round(7 / epochDurationDaysApprox)));

  const last60d = $derived(sumIncomeLamports(lastNRows(rows60d)));
  const last30d = $derived(sumIncomeLamports(lastNRows(rows30d)));
  const last7d = $derived(sumIncomeLamports(lastNRows(rows7d)));

  /**
   * Format a lamports bigint as a 3-decimal SOL string, or `—` when
   * we have no income data for the window. `lamportsStringToSolNumber`
   * does the lossy ÷ 1e9 conversion (acceptable here — humans don't
   * need precision past 6 decimals, and SOL totals stay well within
   * Number.MAX_SAFE_INTEGER for realistic per-validator income).
   */
  function formatLamports(state: { sum: bigint; hasAny: boolean }): string {
    if (!state.hasAny) return '—';
    const sol = lamportsStringToSolNumber(state.sum.toString());
    return sol === null ? '—' : sol.toFixed(3);
  }

  const last60dLabel = $derived(formatLamports(last60d));
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
   * Per-epoch SOL totals for the sparkline. Computed from lamports
   * (the precise source of truth) and narrowed to Number only for
   * the viewBox pixel math. The API also ships `blockFeesTotalSol`
   * strings but parsing those introduces precision drift; staying
   * in bigint until the last step keeps the tile sums + sparkline
   * heights consistent.
   */
  const sparkPoints = $derived(
    sparkRows.map((row) => {
      let lamports = 0n;
      try {
        if (row.blockFeesTotalLamports !== null) lamports += BigInt(row.blockFeesTotalLamports);
        if (row.blockTipsTotalLamports !== null) lamports += BigInt(row.blockTipsTotalLamports);
      } catch {
        // Malformed lamports string → treat as zero rather than NaN.
      }
      const total = lamportsStringToSolNumber(lamports.toString()) ?? 0;
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
  const isColdStart = $derived(!last60d.hasAny && !last30d.hasAny && !last7d.hasAny);

  /** Epoch range label — `oldest–newest` for the sparkline. Hidden when only one epoch is in scope. */
  const sparkRangeLabel = $derived.by(() => {
    if (sparkPoints.length < 2) return null;
    const first = sparkPoints[0]?.epoch;
    const last = sparkPoints.at(-1)?.epoch;
    if (first === undefined || last === undefined) return null;
    return `${first}–${last}`;
  });
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="income-summary-heading"
>
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <h2 id="income-summary-heading" class="text-base font-semibold tracking-tight">
      Recent income
    </h2>
    {#if !isColdStart}
      <a
        href={`/income/${vote}`}
        class="inline-flex min-h-11 items-center text-xs text-[color:var(--color-brand-500)] hover:underline"
      >
        Full epoch history ›
      </a>
    {/if}
  </header>

  {#if isColdStart}
    {#if !suppressColdStartProse}
      <p class="text-sm text-[color:var(--color-text-muted)]">
        This validator hasn't earned its first epoch of fees yet. Check back after the next epoch
        closes.
      </p>
    {/if}
  {:else}
    <div class="grid grid-cols-3 gap-3 sm:gap-4">
      <KpiStat
        label="Last 60 days"
        suffix="SOL"
        title="Sum of fees + tips over the {rows60d} most-recent closed epochs (~60 days). Excludes the running epoch."
      >
        {#if last60dLabel === '—'}
          <!--
            `role="img"` is the only canonical way to give a generic
            inline element an accessible name per ARIA 1.2 — without
            it, screen readers may ignore aria-label on a plain span
            and announce nothing for empty KPI tiles.
          -->
          <span role="img" aria-label="no data">—</span>
        {:else}
          {last60dLabel}
        {/if}
      </KpiStat>
      <KpiStat
        label="Last 30 days"
        suffix="SOL"
        title="Sum of fees + tips over the {rows30d} most-recent closed epochs (~30 days). Excludes the running epoch."
      >
        {#if last30dLabel === '—'}
          <!--
            `role="img"` is the only canonical way to give a generic
            inline element an accessible name per ARIA 1.2 — without
            it, screen readers may ignore aria-label on a plain span
            and announce nothing for empty KPI tiles.
          -->
          <span role="img" aria-label="no data">—</span>
        {:else}
          {last30dLabel}
        {/if}
      </KpiStat>
      <KpiStat
        label="Last 7 days"
        suffix="SOL"
        title="Sum of fees + tips over the {rows7d} most-recent closed epochs (~7 days). Excludes the running epoch."
      >
        {#if last7dLabel === '—'}
          <!--
            `role="img"` is the only canonical way to give a generic
            inline element an accessible name per ARIA 1.2 — without
            it, screen readers may ignore aria-label on a plain span
            and announce nothing for empty KPI tiles.
          -->
          <span role="img" aria-label="no data">—</span>
        {:else}
          {last7dLabel}
        {/if}
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
        <!--
          `aria-hidden` because the canonical AT-readable data is the
          `sr-only` `<dl>` below. Earlier revision combined an SVG
          aria-label, the sr-only dl, AND the visible epoch range
          label — screen readers got the same trend announced three
          times. The polyline is purely visual chrome for sighted
          viewers; the dl carries the precise per-epoch numbers.
        -->
        <svg
          viewBox="0 0 100 30"
          preserveAspectRatio="none"
          class="h-10 flex-1 text-[color:var(--color-brand-500)]"
          aria-hidden="true"
        >
          <polyline
            points={sparkPath}
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        {#if sparkRangeLabel !== null}
          <span class="text-xs tabular-nums text-[color:var(--color-text-muted)]">
            {sparkRangeLabel}
          </span>
        {/if}
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
