<!--
  ActivityHeatmap — 53-week × 7-day operator-wallet activity grid.

  GitHub-contribution-graph idiom adapted for Solana operator
  wallets. Each cell is a single UTC day; intensity (0..4) reflects
  the number of transactions involving the wallet that day. The
  scale is log-bucketed (`intensityBucket` in `$lib/heatmap.ts`)
  so a wallet with 80 tx peaks doesn't visually dominate one with
  steady 5 tx days — the question the grid answers is "did
  anything happen?" more than "how much."

  Data flow:
    1. Caller fetches `/v1/operator-wallets/:wallet/activity?days=365`,
       which returns sparse entries (days with 0 tx are omitted).
    2. Caller passes `entries` here. The component zero-fills the
       window, builds the 53 × 7 grid, and renders.
    3. Cells outside the window (older than `windowStartDate` or in
       the future) render as background-only so the grid stays
       rectangular.
    4. Today's cell gets a faint outline so the viewer can locate
       "now." The single brightest day across the window gets a
       small star overlay (the celebratory marker promised by the
       Plan B fun moments).

  Mobile behaviour: the inner SVG renders at a fixed pixel size
  (53 × ~14 ≈ 740 px wide). On viewports narrower than that, the
  outer container is `overflow-x-auto` with `snap-x` so the user
  can swipe through the year. Cells stay 12 × 12 px (too small to
  reliably tap individually); tap-anywhere-in-a-column opens a
  per-week summary (delivered in a future PR — for v1 the hover
  tooltip handles desktop and mobile shows tooltip on tap via
  native `title`).

  Props:
    - `wallet`: the wallet's full pubkey (used for tooltip + label)
    - `label`: operator-chosen wallet label (e.g. "Hot Wallet")
    - `entries`: sparse activity rows from the API
    - `endDate`: anchor date for the rightmost column (default = today UTC)
    - `days`: window size in days (default = 365, matches API cap)
-->
<script lang="ts">
  import type { OperatorWalletActivityEntry } from '$lib/types';
  import {
    HEATMAP_WEEKS,
    HEATMAP_DAYS_PER_WEEK,
    MONTH_NAMES_EN,
    activeDayCount,
    brightestDay,
    buildGridCells,
    daysSinceMostRecentActive,
    monthLabels,
    utcMidnight,
    zeroFillWindow,
    type HeatmapCell,
    type IntensityBucket,
  } from '$lib/heatmap';

  interface Props {
    wallet: string;
    label: string;
    entries: ReadonlyArray<OperatorWalletActivityEntry>;
    endDate?: Date;
    days?: number;
  }

  let { wallet, label, entries, endDate, days = 365 }: Props = $props();

  // Cell geometry — 12 px squares with 2 px gutters reads tight
  // but matches GitHub's same grid almost exactly. Total grid
  // width: 53 × (12 + 2) − 2 = 740 px. Mobile container scrolls
  // horizontally below ~768 px viewport.
  const CELL_SIZE = 12;
  const CELL_GAP = 2;
  const STEP = CELL_SIZE + CELL_GAP;
  // Room above the grid for month labels.
  const MONTH_LABEL_HEIGHT = 14;
  // Room left of the grid for day-of-week labels (Mon / Wed / Fri,
  // every-other-row).
  const DAY_LABEL_WIDTH = 24;

  const totalWidth = DAY_LABEL_WIDTH + HEATMAP_WEEKS * STEP;
  const totalHeight = MONTH_LABEL_HEIGHT + HEATMAP_DAYS_PER_WEEK * STEP;

  const today = $derived(endDate ? utcMidnight(endDate) : utcMidnight(new Date()));
  const filled = $derived(zeroFillWindow(entries, today, days));
  const cells = $derived(buildGridCells(filled, today, days));
  const labels = $derived(monthLabels(today, days));
  const peak = $derived(brightestDay(entries));
  const activeDays = $derived(activeDayCount(entries));
  const lastActive = $derived(daysSinceMostRecentActive(entries, today));
  const truncatedWallet = $derived(`${wallet.slice(0, 4)}…${wallet.slice(-4)}`);

  /**
   * Tier-aware cell colour. We use the `--color-status-ok-bg` ramp
   * for activity (the existing token family for "good things
   * happening"), with `--color-border-default` as the empty
   * baseline. Intensity 0 is the empty colour; 1..4 darken via
   * `opacity` so we don't need 5 separate tokens — Tailwind's
   * arbitrary-value alpha syntax keeps the design system surface
   * small and theme-flippable.
   */
  function cellFill(intensity: IntensityBucket, inWindow: boolean): string {
    if (!inWindow) return 'var(--color-surface-muted)';
    if (intensity === 0) return 'var(--color-border-default)';
    // 1..4 → alpha 35 / 55 / 75 / 95. Linear ramp; gives clear
    // separation between buckets in both light + dark mode.
    const alpha = [0, 35, 55, 75, 95][intensity];
    return `color-mix(in oklab, var(--color-status-ok-fg) ${alpha}%, transparent)`;
  }

  /**
   * Build the title attribute for hover tooltips. Tooltips show
   * date + day-of-week + tx count. We don't use a portal-based
   * tooltip component here because 371 cells would each need a
   * mouse handler; the native `title` attribute is good enough
   * for the v1 hover experience and works on touch via long-press.
   */
  function cellTooltip(cell: HeatmapCell): string {
    if (!cell.inWindow) return `${cell.date} (out of window)`;
    const day = new Date(cell.date).toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    });
    const txWord = cell.txCount === 1 ? 'tx' : 'tx';
    return `${cell.date} (${day}) · ${cell.txCount} ${txWord}`;
  }

  /** "Inactive 365+ days" muted banner — visible when no entries had positive tx counts. */
  const isInactive = $derived(activeDays === 0);

  const lastActiveLabel = $derived.by(() => {
    if (lastActive === null) return 'Inactive 365+ days';
    if (lastActive === 0) return 'Active today';
    if (lastActive === 1) return 'Active yesterday';
    return `Active ${lastActive} days ago`;
  });
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-label="Operator wallet activity heatmap"
>
  <header class="flex flex-col gap-1 pb-3 sm:flex-row sm:items-baseline sm:justify-between">
    <div class="min-w-0">
      <h3 class="text-sm font-semibold tracking-tight">{label}</h3>
      <p class="text-xs text-[color:var(--color-text-muted)]">
        <code class="font-mono">{truncatedWallet}</code>
        {#if peak !== null}
          <span class="ml-1 text-[color:var(--color-text-subtle)]">
            · brightest day: {peak.txCount} tx on {peak.date}
          </span>
        {/if}
      </p>
    </div>
    <div class="text-xs tabular-nums text-[color:var(--color-text-muted)]">
      <span class="font-semibold text-[color:var(--color-text-default)]">{activeDays}</span>
      of last {days} days · <span>{lastActiveLabel}</span>
    </div>
  </header>

  {#if isInactive}
    <!--
      Inactive-state banner — visible when no entries had a positive
      tx count across the window. We DON'T hide the grid (the
      historical empty state is its own signal: "wallet exists,
      registered, ingested, just not used"); we just label it.
    -->
    <p class="pb-2 text-xs text-[color:var(--color-text-muted)]">
      Wallet has not transacted in the last {days} days.
    </p>
  {/if}

  <!--
    Horizontal scroll on narrow viewports. `snap-x` keeps panning
    feel intentional; on desktop the SVG fits without scroll.
    `overflow-y-hidden` so the grid doesn't bleed vertically when
    a tooltip pops near the bottom row.
  -->
  <div class="snap-x overflow-x-auto overflow-y-hidden">
    <svg
      viewBox="0 0 {totalWidth} {totalHeight}"
      width={totalWidth}
      height={totalHeight}
      class="block"
      role="img"
      aria-label="Daily transaction activity for {label}: {activeDays} of last {days} days active"
    >
      <!-- Month labels above the grid. -->
      {#each labels as l, i (i)}
        <text
          x={DAY_LABEL_WIDTH + l.weekColumn * STEP}
          y={MONTH_LABEL_HEIGHT - 4}
          font-size="10"
          fill="currentColor"
          class="text-[color:var(--color-text-subtle)]"
        >
          {MONTH_NAMES_EN[l.month]}
        </text>
      {/each}
      <!-- Day-of-week labels (Mon / Wed / Fri — every other row). -->
      <text
        x="0"
        y={MONTH_LABEL_HEIGHT + STEP * 1 + 9}
        font-size="9"
        class="text-[color:var(--color-text-subtle)]"
        fill="currentColor"
      >
        Mon
      </text>
      <text
        x="0"
        y={MONTH_LABEL_HEIGHT + STEP * 3 + 9}
        font-size="9"
        class="text-[color:var(--color-text-subtle)]"
        fill="currentColor"
      >
        Wed
      </text>
      <text
        x="0"
        y={MONTH_LABEL_HEIGHT + STEP * 5 + 9}
        font-size="9"
        class="text-[color:var(--color-text-subtle)]"
        fill="currentColor"
      >
        Fri
      </text>

      <!-- Cells -->
      {#each cells as cell (cell.date + ':' + cell.weekColumn + ':' + cell.dayRow)}
        <rect
          x={DAY_LABEL_WIDTH + cell.weekColumn * STEP}
          y={MONTH_LABEL_HEIGHT + cell.dayRow * STEP}
          width={CELL_SIZE}
          height={CELL_SIZE}
          rx="2"
          fill={cellFill(cell.intensity, cell.inWindow)}
          stroke={cell.isToday ? 'var(--color-brand-500)' : 'none'}
          stroke-width={cell.isToday ? 1.5 : 0}
        >
          <title>{cellTooltip(cell)}</title>
        </rect>
      {/each}

      <!--
        Brightest-day star overlay. Drawn ON TOP of the cell stack
        so it remains visible above the cell's own fill. 4 px star
        in the centre of the peak day's cell. The 5-point star
        path is hand-positioned; this is small enough that
        re-using `STAR_8_PATH_D` from `$lib/icons/star.ts` would
        require a different transform, so we ship a tiny inline
        path here.
      -->
      {#if peak !== null}
        {@const peakCell = cells.find((c) => c.date === peak.date && c.inWindow)}
        {#if peakCell !== undefined}
          {@const cx = DAY_LABEL_WIDTH + peakCell.weekColumn * STEP + CELL_SIZE / 2}
          {@const cy = MONTH_LABEL_HEIGHT + peakCell.dayRow * STEP + CELL_SIZE / 2}
          <g transform="translate({cx - 4} {cy - 4})" aria-hidden="true">
            <path
              d="M4 0 L5 3 L8 3 L5.5 5 L6.5 8 L4 6 L1.5 8 L2.5 5 L0 3 L3 3 Z"
              fill="var(--color-brand-500)"
              stroke="white"
              stroke-width="0.5"
            />
          </g>
        {/if}
      {/if}
    </svg>
  </div>

  <!-- Legend. Mirrors GitHub's "Less … More" idiom with the 5 buckets. -->
  <footer
    class="mt-3 flex items-center justify-end gap-1 text-[10px] text-[color:var(--color-text-subtle)]"
  >
    <span>Less</span>
    {#each [0, 1, 2, 3, 4] as bucket (bucket)}
      <span
        class="inline-block h-2.5 w-2.5 rounded-sm"
        style="background: {cellFill(bucket as IntensityBucket, true)}"
        aria-hidden="true"
      ></span>
    {/each}
    <span>More</span>
  </footer>
</section>
