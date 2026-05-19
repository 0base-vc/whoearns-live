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
       small star overlay.

  Accessibility:
    - The SVG carries a one-line summary as `aria-label`. The full
      per-day data is exposed as an adjacent `sr-only` description
      list (date → tx count for ACTIVE days only — assistive tech
      doesn't need 371 rows of "0 tx").
    - The legend ranges (0 / 1-2 / 3-10 / 11-30 / 31+) appear as
      visible text under each swatch so color-blind viewers can
      read the scale by number, not just lightness.
    - The horizontal-scroll container is keyboard-focusable
      (`tabindex="0"`) with `role="region"` so a keyboard-only
      user can pan with arrow keys on narrow viewports.
    - `overscroll-behavior-x: contain` prevents iOS swipe-back
      from firing when the user pans the heatmap.

  Mobile behaviour: the inner SVG renders at a fixed pixel size
  (~740px wide). On narrower viewports the outer container scrolls
  horizontally. Cells stay 12×12px (too small to reliably tap
  individually); tap-anywhere-in-a-column opens a per-week summary
  in a future PR — for v1 the hover/long-press tooltip on `title=`
  handles desktop and mobile.

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

  // Cell geometry — 12 px squares with 2 px gutters reads tight but
  // matches GitHub's grid almost exactly. Total grid width:
  // 53 × (12 + 2) − 2 = 740 px. Mobile container scrolls horizontally
  // below ~768 px viewport.
  const CELL_SIZE = 12;
  const CELL_GAP = 2;
  const STEP = CELL_SIZE + CELL_GAP;
  // Room above the grid for month labels.
  const MONTH_LABEL_HEIGHT = 14;
  // Room left of the grid for day-of-week labels.
  const DAY_LABEL_WIDTH = 24;

  const totalWidth = DAY_LABEL_WIDTH + HEATMAP_WEEKS * STEP;
  const totalHeight = MONTH_LABEL_HEIGHT + HEATMAP_DAYS_PER_WEEK * STEP;

  /**
   * Day-of-week labels. Cached at module scope so the per-cell
   * `cellTooltip` lookup is constant-time instead of allocating a
   * fresh `Intl.DateTimeFormat` per cell (371 cells × 3 panels =
   * 1113 `Intl` invocations on first paint — measurable on
   * low-end Android).
   */
  const WEEKDAY_SHORT: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /**
   * Pre-built fill expression per intensity bucket. Hoisted out of
   * `cellFill()` so the per-cell render path is an array lookup —
   * avoids a 5-element allocation + `color-mix` template
   * concatenation on every cell.
   */
  const BUCKET_FILL: readonly string[] = [
    // `--color-heatmap-empty` is a dedicated token that lands at
    // zinc-200 in light mode and zinc-700 in dark mode, lifting
    // the empty-cell visibility above the 3:1 non-text floor on
    // dark backgrounds (the earlier `--color-border-default`
    // zinc-800 against zinc-950 surface read at ~1.5:1).
    //
    // Bucket-1 was previously 35% — once bucket-0 lifted to
    // zinc-700, the two cells' luminance differed by only ~10-12 ΔL
    // with a faint green tint that vanishes under protan/deutan
    // simulation. Bucket-1 now starts at 50% so the bucket-0 →
    // bucket-1 luminance gap stays clear for color-blind viewers
    // even when the green hue is desaturated. Buckets 2-4 stay
    // spaced so the cross-bucket ramp still reads as a gradient.
    'var(--color-heatmap-empty)',
    'color-mix(in oklab, var(--color-status-ok-fg) 50%, transparent)',
    'color-mix(in oklab, var(--color-status-ok-fg) 65%, transparent)',
    'color-mix(in oklab, var(--color-status-ok-fg) 80%, transparent)',
    'color-mix(in oklab, var(--color-status-ok-fg) 95%, transparent)',
  ];

  /** Bucket numeric ranges, surfaced visibly in the legend for color-blind viewers. */
  const BUCKET_RANGES: readonly string[] = ['0', '1–2', '3–10', '11–30', '31+'];

  const today = $derived(endDate ? utcMidnight(endDate) : utcMidnight(new Date()));
  const filled = $derived(zeroFillWindow(entries, today, days));
  const cells = $derived(buildGridCells(filled, today, days));
  const labels = $derived(monthLabels(today, days));
  const peak = $derived(brightestDay(entries));
  const activeDays = $derived(activeDayCount(entries));
  const lastActive = $derived(daysSinceMostRecentActive(entries, today));
  const truncatedWallet = $derived(`${wallet.slice(0, 4)}…${wallet.slice(-4)}`);
  const isInactive = $derived(activeDays === 0);

  /**
   * `Map` of date → cell so the brightest-day overlay can resolve
   * its peak cell in O(1) instead of an O(371) scan per derive.
   */
  const cellByDate = $derived.by(() => {
    const m = new Map<string, HeatmapCell>();
    for (const c of cells) m.set(c.date, c);
    return m;
  });

  const peakCell = $derived(peak !== null ? (cellByDate.get(peak.date) ?? null) : null);
  const peakInWindow = $derived(peakCell !== null && peakCell.inWindow);

  /**
   * Per-day data list for screen readers — ONLY active days (skip
   * the 365-of-365 zero baseline so AT users don't sit through
   * hundreds of "0 tx" lines). The full SVG is `aria-hidden`-
   * grouped under a single summary; this list is the AT-readable
   * surface.
   */
  const activeEntries = $derived(
    entries
      .filter((e) => Number.isFinite(e.txCount) && e.txCount > 0)
      .slice()
      // newest-first so AT readout matches the visual scan direction
      .sort((a, b) => (a.date > b.date ? -1 : 1)),
  );

  /** Tier-aware cell colour — array lookup, no template string per cell. */
  function cellFill(intensity: IntensityBucket, inWindow: boolean): string {
    if (!inWindow) return 'var(--color-surface-muted)';
    return BUCKET_FILL[intensity] ?? BUCKET_FILL[0]!;
  }

  /**
   * Title tooltip — date + day-of-week + tx count. Day-of-week comes
   * from the cached `WEEKDAY_SHORT` array, not `Intl.DateTimeFormat`,
   * because building 1113 `Intl` instances is a measurable paint cost.
   */
  function cellTooltip(cell: HeatmapCell): string {
    if (!cell.inWindow) return `${cell.date} (out of window)`;
    const day = WEEKDAY_SHORT[cell.dayRow] ?? '';
    const txWord = cell.txCount === 1 ? 'tx' : 'txs';
    return `${cell.date} (${day}) · ${cell.txCount} ${txWord}`;
  }

  const lastActiveLabel = $derived.by(() => {
    if (lastActive === null) return null;
    if (lastActive === 0) return 'Active today';
    if (lastActive === 1) return 'Active yesterday';
    return `Active ${lastActive} days ago`;
  });

  /**
   * Headline accessible name for the SVG. Includes the wallet
   * label, the activity headline, and (when present) the brightest
   * day — so a screen-reader user receives the same celebratory
   * signal sighted users get from the star overlay.
   */
  const ariaSummary = $derived.by(() => {
    const parts: string[] = [
      `Daily transaction activity for ${label}: active ${activeDays} of last ${days} days.`,
    ];
    if (lastActiveLabel !== null) parts.push(lastActiveLabel + '.');
    if (peak !== null && peakInWindow) {
      parts.push(`Brightest day: ${peak.txCount} transactions on ${peak.date}.`);
    }
    return parts.join(' ');
  });
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="heatmap-heading-{wallet}"
>
  <header class="flex flex-col gap-1 pb-3 sm:flex-row sm:items-baseline sm:justify-between">
    <div class="min-w-0">
      <h3 id="heatmap-heading-{wallet}" class="text-sm font-semibold tracking-tight">
        {label}
      </h3>
      <p class="text-xs text-[color:var(--color-text-muted)]">
        <code class="font-mono">{truncatedWallet}</code>
        {#if peak !== null && peakInWindow}
          <span class="ml-1 text-[color:var(--color-text-muted)]">
            · brightest day: {peak.txCount} tx on {peak.date}
          </span>
        {/if}
      </p>
    </div>
    <div class="text-xs tabular-nums text-[color:var(--color-text-muted)]">
      <span class="font-semibold text-[color:var(--color-text-default)]">{activeDays}</span>
      of last {days} days{#if lastActiveLabel}<span> · {lastActiveLabel}</span>{/if}
    </div>
  </header>

  {#if isInactive}
    <!--
      Inactive-state banner — factual, not categorical. We keep the
      grid visible (the empty grid IS the signal) but label it so a
      delegator scanning a sea of muted cells doesn't think the
      data failed to load.
    -->
    <p class="pb-2 text-xs text-[color:var(--color-text-muted)]">
      No activity in the last {days} days.
    </p>
  {/if}

  <!--
    Horizontal scroll on narrow viewports. `tabindex="0"` +
    `role="region"` make the panning region keyboard-focusable; iOS
    `overscroll-behavior-x: contain` keeps the heatmap pan from
    triggering the browser's back-swipe gesture.

    The `tabindex` on a non-interactive scroll container is the
    ARIA Authoring Practices Guide pattern for "scrollable region a
    keyboard user must reach to pan." svelte-check's a11y heuristic
    rejects this in general; we know this specific use is correct.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="snap-x overflow-x-auto overflow-y-hidden"
    style="overscroll-behavior-x: contain; touch-action: pan-x;"
    role="region"
    aria-label="Activity heatmap for {label} — scroll horizontally to pan"
    tabindex="0"
  >
    <svg
      viewBox="0 0 {totalWidth} {totalHeight}"
      width={totalWidth}
      height={totalHeight}
      class="block"
      role="img"
      aria-label={ariaSummary}
    >
      <!-- Month labels above the grid. -->
      {#each labels as l (l.weekColumn)}
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
      {#each cells as cell (cell.date)}
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

      <!-- Brightest-day star overlay — see `ariaSummary` for AT equivalent. -->
      {#if peakCell !== null && peakInWindow}
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
    </svg>
  </div>

  <!--
    Parallel `sr-only` data list. Only ACTIVE days surface (so AT
    users don't sit through 300+ "0 tx" rows). Keyed off the same
    `entries` prop so the SVG and the description list never drift.
  -->
  <div class="sr-only" aria-live="off">
    <p>Daily activity data, newest first:</p>
    {#if activeEntries.length === 0}
      <p>No transactions in the last {days} days.</p>
    {:else}
      <dl>
        {#each activeEntries as e (e.date)}
          <dt>{e.date}</dt>
          <dd>{e.txCount} {e.txCount === 1 ? 'transaction' : 'transactions'}</dd>
        {/each}
      </dl>
    {/if}
  </div>

  <!--
    Legend with numeric ranges. Visible text under each swatch
    converts the lightness-only ramp into a labelled scale so
    color-blind viewers can read intensity by number.
  -->
  <footer
    class="mt-3 flex items-center justify-end gap-1 text-[10px] text-[color:var(--color-text-muted)]"
  >
    <span>Less</span>
    {#each [0, 1, 2, 3, 4] as bucket (bucket)}
      <span class="flex flex-col items-center gap-0.5">
        <span
          class="inline-block h-2.5 w-2.5 rounded-sm"
          style="background: {cellFill(bucket as IntensityBucket, true)}"
          aria-hidden="true"
        ></span>
        <span class="tabular-nums">{BUCKET_RANGES[bucket]}</span>
      </span>
    {/each}
    <span>More</span>
  </footer>
</section>
