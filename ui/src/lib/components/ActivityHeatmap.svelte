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
    1. Caller fetches `/v1/claims/:vote?includeActivity=1`, whose
       `wallets.entries[].activity.entries` are the sparse rows
       (days with 0 tx are omitted).
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
    - `walletAddressShort`: the wallet's already-truncated address
      (`FXfD…PsJ5`) — the full operator-wallet pubkey is hidden by
      the API and never reaches this component. Rendered verbatim in
      the `<code>` under the label.
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
    zeroFillFeeWindow,
    zeroFillWindow,
    type HeatmapCell,
    type HeatmapMode,
    type IntensityBucket,
  } from '$lib/heatmap';

  interface Props {
    walletAddressShort: string;
    label: string;
    entries: ReadonlyArray<OperatorWalletActivityEntry>;
    endDate?: Date;
    days?: number;
    /**
     * Which signal drives the intensity colour:
     *   - `'count'` (default) — `tx_count` log-buckets. Phase 4 ship.
     *   - `'fees'` — `tx_fees_lamports` log-buckets. The hub flips to
     *     this when the OAI route returns
     *     `ingestStatus.walletFeesIngestActive: true`, signalling
     *     that the wallet-fee backfill has populated at least one
     *     row. Cells for days the backfill hasn't reached yet have
     *     `txFeesLamports === 0n` and render as empty under fees
     *     mode (same as a genuinely-zero day — the tooltip still
     *     shows the tx count so the viewer can tell the difference).
     */
    mode?: HeatmapMode;
  }

  let { walletAddressShort, label, entries, endDate, days = 365, mode = 'count' }: Props = $props();

  // Unique-per-instance id for the `aria-labelledby` heading pairing.
  // `$props.id()` — NOT a wallet pubkey — keeps any wallet address
  // out of the public DOM as an `id` attribute. The only wallet text
  // the component renders is the already-truncated `walletAddressShort`.
  // `$props.id()` must be a bare variable initializer, hence the
  // two-step (uid -> headingId).
  const uid = $props.id();
  const headingId = `heatmap-heading-${uid}`;

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
    // simulation. Bucket-1 now starts at 50%.
    //
    // 50/68/82/95 widens BOTH the bucket-1→bucket-2 step (was 15pt
    // at 50/65) AND the bucket-3→bucket-4 high-end step (was 15pt
    // at 80/95). Net result: ~18/14/13 percentage-point spacing
    // versus the prior 15/15/15. Every adjacent-bucket transition
    // stays discriminable under protan/deutan simulation while the
    // "brightest day stands out" sighted-user signal isn't
    // compressed into the very top of the ramp.
    'var(--color-heatmap-empty)',
    'color-mix(in oklab, var(--color-status-ok-fg) 50%, transparent)',
    'color-mix(in oklab, var(--color-status-ok-fg) 68%, transparent)',
    'color-mix(in oklab, var(--color-status-ok-fg) 82%, transparent)',
    'color-mix(in oklab, var(--color-status-ok-fg) 95%, transparent)',
  ];

  /**
   * Bucket numeric ranges, surfaced visibly in the legend for color-
   * blind viewers. Mode-dependent: tx-count buckets use the small
   * integer thresholds (`intensityBucket`), fee buckets use lamport
   * thresholds (`feeIntensityBucket`). The compact "k"/"M" suffixes
   * keep the legend cells from blowing out the row width.
   */
  const COUNT_BUCKET_RANGES: readonly string[] = ['0', '1–2', '3–10', '11–30', '31+'];
  const FEE_BUCKET_RANGES: readonly string[] = ['0', '≤10k', '≤100k', '≤1M', '>1M'];
  const bucketRanges = $derived(mode === 'fees' ? FEE_BUCKET_RANGES : COUNT_BUCKET_RANGES);

  const today = $derived(endDate ? utcMidnight(endDate) : utcMidnight(new Date()));
  const filled = $derived(zeroFillWindow(entries, today, days));
  // Fees map is computed even when `mode === 'count'` so the
  // tooltip's "X SOL / avg lam-per-tx" line stays available for
  // any cell that DOES have backfilled fee data. The intensity
  // binding is what the `mode` prop controls; the tooltip text is
  // always count + fees + avg.
  const feesFilled = $derived(zeroFillFeeWindow(entries, today, days));
  const cells = $derived(buildGridCells(filled, today, days, mode, feesFilled));
  const labels = $derived(monthLabels(today, days));
  const peak = $derived(brightestDay(entries));
  const activeDays = $derived(activeDayCount(entries));
  const lastActive = $derived(daysSinceMostRecentActive(entries, today));
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

  const LAMPORTS_PER_SOL = 1_000_000_000n;

  /**
   * Decimal-fixed SOL string from a lamport `bigint`. 4 decimal places
   * — enough resolution for sub-SOL daily fee totals (a busy day on a
   * typical operator wallet is ~0.001 SOL of priority fees) without
   * the precision-pretending of 9 decimals.
   *
   * `BigInt` math throughout — converting to `Number` first would
   * lose precision for high-fee days near `Number.MAX_SAFE_INTEGER`.
   */
  function formatSol(lamports: bigint): string {
    if (lamports === 0n) return '0';
    const whole = lamports / LAMPORTS_PER_SOL;
    // Carry 4 decimal places of fractional precision. Multiply
    // remainder by 10_000, integer-divide, then pad.
    const remainder = lamports - whole * LAMPORTS_PER_SOL;
    const fracPart = (remainder * 10_000n) / LAMPORTS_PER_SOL;
    if (fracPart === 0n) return whole.toString();
    return `${whole.toString()}.${fracPart.toString().padStart(4, '0').replace(/0+$/, '') || '0'}`;
  }

  /**
   * Title tooltip — date + day-of-week + tx count + (when fee data is
   * available) SOL spent + avg lamports per tx. Day-of-week comes
   * from the cached `WEEKDAY_SHORT` array, not `Intl.DateTimeFormat`,
   * because building 1113 `Intl` instances is a measurable paint cost.
   *
   * The fee line is only appended when `txFeesLamports > 0` — until
   * the backfill has reached this day the column is `0n` and we
   * don't have authoritative fee data to display.
   *
   * The "avg lam/tx" surface is the spam-detection signal the user
   * asked for: 1000 × 1-lamport spam reads as `avg 1 lam/tx`, while
   * 10 normal txs reads as `avg ~5000 lam/tx`. Same sum-of-fees
   * shape, very different daily average.
   */
  function cellTooltip(cell: HeatmapCell): string {
    if (!cell.inWindow) return `${cell.date} (out of window)`;
    const day = WEEKDAY_SHORT[cell.dayRow] ?? '';
    const txWord = cell.txCount === 1 ? 'tx' : 'txs';
    const parts = [`${cell.date} (${day})`, `${cell.txCount} ${txWord}`];
    if (cell.txFeesLamports > 0n) {
      parts.push(`${formatSol(cell.txFeesLamports)} SOL`);
      if (cell.txCount > 0) {
        const avg = cell.txFeesLamports / BigInt(cell.txCount);
        parts.push(`avg ${avg.toString()} lam/tx`);
      }
    }
    return parts.join(' · ');
  }

  /**
   * Tooltip text for the brightest-day star overlay. Prefixed with
   * "Brightest day" so a reader who hovers a randomly-marked cell
   * sees WHY the star is there, not just the day's data (which the
   * underlying cell `<title>` already provides on its own hover).
   */
  function starTooltip(cell: HeatmapCell): string {
    return `Brightest day · ${cellTooltip(cell)}`;
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
  aria-labelledby={headingId}
>
  <header class="flex flex-col gap-1 pb-3 sm:flex-row sm:items-baseline sm:justify-between">
    <div class="min-w-0">
      <h3 id={headingId} class="text-sm font-semibold tracking-tight">
        {label}
      </h3>
      <p class="text-xs text-[color:var(--color-text-muted)]">
        <code class="font-mono">{walletAddressShort}</code>
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

      <!-- Cells (visible, 12×12) -->
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
        />
      {/each}

      <!--
        Per-cell hover hit area — a transparent overlay that covers
        BOTH the cell + half of each gutter, so hovering the gap
        between cells still lands on the nearer day's tooltip
        instead of falling through to the SVG background. Native
        SVG `<title>` is OS-rendered (~500ms hover delay, no fancy
        styling), but it's the most robust cross-device option —
        custom HTML tooltips on a 53×7 grid would need fixed-
        position overlay management for the horizontal-scroll
        container, which is more risk than reward at this size.
      -->
      {#each cells as cell (`hit-${cell.date}`)}
        <rect
          x={DAY_LABEL_WIDTH + cell.weekColumn * STEP - CELL_GAP / 2}
          y={MONTH_LABEL_HEIGHT + cell.dayRow * STEP - CELL_GAP / 2}
          width={CELL_SIZE + CELL_GAP}
          height={CELL_SIZE + CELL_GAP}
          fill="transparent"
          pointer-events="all"
        >
          <title>{cellTooltip(cell)}</title>
        </rect>
      {/each}

      <!--
        Brightest-day star overlay. Sits ABOVE the hit-area layer
        so a hover on the star itself gets the star's "Brightest
        day · ..." tooltip rather than the underlying cell's plain
        tooltip. `aria-hidden` removed because the `<title>` is
        meaningful content now; the AT summary still surfaces the
        same info via `ariaSummary`.
      -->
      {#if peakCell !== null && peakInWindow}
        {@const cx = DAY_LABEL_WIDTH + peakCell.weekColumn * STEP + CELL_SIZE / 2}
        {@const cy = MONTH_LABEL_HEIGHT + peakCell.dayRow * STEP + CELL_SIZE / 2}
        <g transform="translate({cx - 4} {cy - 4})">
          <title>{starTooltip(peakCell)}</title>
          <path
            d="M4 0 L5 3 L8 3 L5.5 5 L6.5 8 L4 6 L1.5 8 L2.5 5 L0 3 L3 3 Z"
            fill="var(--color-brand-500)"
            stroke="white"
            stroke-width="0.5"
            pointer-events="all"
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
    <!--
      Unit-prefixed label. Count mode reads "Txs per day"; fees mode
      reads "Fees (lamports/day)" — both phrases name what the
      bucket numbers actually mean, so a reader doesn't have to
      infer the unit from context. The "Less … More" framing of an
      earlier revision was directional but unit-less.
    -->
    <span>{mode === 'fees' ? 'Fees (lam/day):' : 'Txs per day:'}</span>
    {#each [0, 1, 2, 3, 4] as bucket (bucket)}
      <span class="flex flex-col items-center gap-0.5">
        <span
          class="inline-block h-2.5 w-2.5 rounded-sm"
          style="background: {cellFill(bucket as IntensityBucket, true)}"
          aria-hidden="true"
        ></span>
        <span class="tabular-nums">{bucketRanges[bucket]}</span>
      </span>
    {/each}
  </footer>
</section>
