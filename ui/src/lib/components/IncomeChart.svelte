<!--
  Validator income-trend chart.

  Design intent (per user's design choices A/C/A/A):
    - LayerChart Svelte-native chart library
    - Validator vs. cluster overlay once backend ships per-epoch aggregates
    - Running (partial) epoch included, visually distinguished from
      closed epochs
    - Inline cluster-% context on the table column, not repeated on
      the chart itself

  Running-epoch visual treatment:
    Each metric is drawn as TWO layerchart series — the "closed" series
    covers every epoch up to and including the last `exact` one with a
    solid stroke, and the "transition" series draws ONLY the segment
    from that last closed epoch to the current (partial) epoch with a
    dashed stroke. The effect: the line reads continuously but the final
    segment visually carries the "tentative" semantic. The partial point
    itself inherits the dashed stroke's tail, so no separate open-circle
    marker is needed.

    We prefer per-series `data` arrays over splitting the main `data`
    object shape because LayerChart's Spline segments correctly against
    null gaps, but its legend/tooltip presentation conflates keys —
    keeping the "fees" / "MEV" identities single-keyed means the legend
    stays readable.

    The tooltip is an explicit override (see the `slot="tooltip"`
    below): LayerChart's default iterates EVERY visible series, so the
    `_running` internal series end up as phantom rows with the SAME
    value as their closed counterparts at the join epoch. Filtering by
    `s.internal` in a custom slot trims the duplicates cleanly.

  Visual language (kept deliberately minimal — TWO axes of meaning):
    - COLOUR identifies the metric:
        amber → validator block fees
        sky   → validator on-chain Jito tips
        slate → cluster median (reference, different scale)
    - DASH PATTERN communicates state:
        solid         → settled / final (closed epoch data)
        dashed `6 3`  → partial / running (trailing epoch only)
        dotted `2 6`  → cluster reference (separate axis of meaning,
                        drawn distinctly so it doesn't get confused
                        with the running-tail dash)

  Earlier we had MEV always dashed `4 4` "for variety", but that made
  the running-tail semantic ambiguous: readers saw dashed mev on
  closed epochs and dashed fees on the partial tail, and couldn't tell
  what "dashed" meant. Collapsing to a single dash meaning keeps the
  chart self-explanatory.

  Plotted metrics:
    `blockFeesTotalSol` (amber)    — always-present total per epoch
    `blockTipsTotalSol` (sky)      — on-chain Jito tips derived from
                                     each produced block
    cluster median block fee (slate, dotted) — appears only once the
                                     backend aggregates job has
                                     published data. Scale mismatch:
                                     cluster median is per-BLOCK while
                                     the others are per-EPOCH totals,
                                     so it mostly sits near zero on a
                                     shared Y. Kept for parity with
                                     vx.tools and will read more
                                     interesting on a future dual-axis
                                     view.

  Data gaps: `lamportsStringToSolNumber` + null checks produce `null`
  for absent metrics; LayerChart's `defined` accessor skips those,
  giving segmented lines rather than drawing through zero.
-->
<script lang="ts">
  import { LineChart, Tooltip } from 'layerchart';
  import { lamportsStringToSolNumber } from '$lib/format';
  import type { ValidatorEpochRecord } from '$lib/types';

  let { history }: { history: ValidatorEpochRecord[] } = $props();

  interface Point {
    epoch: number;
    totalFees: number | null;
    totalMev: number | null;
    clusterMedianPerBlock: number | null;
  }

  // Sort ascending so the chart reads left-to-right (oldest → newest).
  // Also ANCHOR the chart to the fees signal: skip any trailing
  // history rows that have no fees data. This drops the oldest
  // "MEV-only" epochs that the MEV ingester reached before the fee
  // ingester did — without the filter the MEV dashed line starts
  // one epoch earlier than the fees solid line and looks staggered.
  //
  // Fees are the better chart anchor because they come directly from
  // `getBlock` and are deterministic; MEV is Jito-dependent and
  // sometimes available for epochs we haven't fee-ingested yet. If
  // fees are missing for an epoch, we can't meaningfully say what
  // "income" was — so we drop the row.
  const sortedHistory = $derived(
    [...history].sort((a, b) => a.epoch - b.epoch).filter((r) => r.blockFeesTotalSol !== null),
  );

  function chartMevSol(row: ValidatorEpochRecord): number | null {
    return row.blockTipsTotalSol === null ? null : Number(row.blockTipsTotalSol);
  }

  const chartData = $derived.by<Point[]>(() =>
    sortedHistory.map((r) => ({
      epoch: r.epoch,
      totalFees: r.blockFeesTotalSol === null ? null : Number(r.blockFeesTotalSol),
      totalMev: chartMevSol(r),
      clusterMedianPerBlock: lamportsStringToSolNumber(r.cluster?.medianBlockFeeLamports ?? null),
    })),
  );

  // If the RIGHTMOST history row is running (partial fees or partial
  // slots — per-metric partials both imply the epoch is still open),
  // carve out the dashed transition segment. We only ever treat the
  // tail as partial; an intra-series partial would be anomalous.
  const transition = $derived.by(() => {
    if (chartData.length < 2) return null;
    const lastHistory = sortedHistory[sortedHistory.length - 1];
    if (!lastHistory) return null;
    if (!lastHistory.isCurrentEpoch) return null;
    const running = chartData[chartData.length - 1];
    const prev = chartData[chartData.length - 2];
    if (!running || !prev) return null;
    return { prev, running };
  });

  const closedData = $derived.by<Point[]>(() => {
    // Solid segment covers everything up to (and INCLUDING) the last
    // closed epoch. If there's no running row, that's all of chartData;
    // if there is, drop the final (partial) point so the solid series
    // ends cleanly where the dashed one picks up.
    if (transition === null) return chartData;
    return chartData.slice(0, chartData.length - 1);
  });

  const transitionData = $derived.by<Point[]>(() =>
    transition === null ? [] : [transition.prev, transition.running],
  );

  const hasFees = $derived(chartData.some((p) => p.totalFees !== null));
  const hasMev = $derived(chartData.some((p) => p.totalMev !== null));
  const hasClusterMedian = $derived(chartData.some((p) => p.clusterMedianPerBlock !== null));

  const VALIDATOR_FEE_COLOR = '#f59e0b';
  const VALIDATOR_MEV_COLOR = '#0ea5e9';
  const CLUSTER_COLOR = '#64748b';
  const TRANSITION_DASH = '6 3';
  const CLUSTER_DASH = '2 6';

  interface SeriesConfig {
    key: string;
    label: string;
    value: string;
    color: string;
    data?: Point[];
    props?: Record<string, unknown>;
    /** Hide this series from the custom legend we render in the header. */
    internal?: boolean;
  }

  const series = $derived.by<SeriesConfig[]>(() => {
    const s: SeriesConfig[] = [];
    if (hasFees) {
      s.push({
        key: 'fees',
        label: 'Block fees (total)',
        value: 'totalFees',
        color: VALIDATOR_FEE_COLOR,
        data: closedData,
      });
      if (transitionData.length === 2) {
        s.push({
          key: 'fees_running',
          label: '',
          value: 'totalFees',
          color: VALIDATOR_FEE_COLOR,
          data: transitionData,
          props: { 'stroke-dasharray': TRANSITION_DASH, opacity: 0.85 },
          internal: true,
        });
      }
    }
    if (hasMev) {
      // MEV previously rendered with an always-on `'4 4'` dash to
      // distinguish it from fees. That collides with the transition
      // semantic: the reader sees dashed mev line for CLOSED epochs,
      // then ALSO a dashed fees tail for the running epoch, and can't
      // tell whether "dashed" means "MEV" or "partial". Colour alone
      // (amber vs sky) already separates the two metrics — keep mev
      // solid for closed data so `solid = settled, dashed = running`
      // reads as one unambiguous rule across the whole chart.
      s.push({
        key: 'mev',
        label: 'MEV tips',
        value: 'totalMev',
        color: VALIDATOR_MEV_COLOR,
        data: closedData,
      });
      if (transitionData.length === 2) {
        s.push({
          key: 'mev_running',
          label: '',
          value: 'totalMev',
          color: VALIDATOR_MEV_COLOR,
          data: transitionData,
          props: { 'stroke-dasharray': TRANSITION_DASH, opacity: 0.6 },
          internal: true,
        });
      }
    }
    if (hasClusterMedian) {
      s.push({
        key: 'clusterMedian',
        label: 'Cluster median block fee',
        value: 'clusterMedianPerBlock',
        color: CLUSTER_COLOR,
        data: closedData,
        props: { 'stroke-dasharray': CLUSTER_DASH },
      });
    }
    return s;
  });

  // Custom legend: only visible series + a running-epoch swatch when
  // the dashed trailing segment is drawn. We can't easily filter the
  // LayerChart built-in legend (it derives from the raw series list),
  // so we disable it and render our own controlled copy here. The
  // swatch preview mirrors each series' own `stroke-dasharray` so the
  // legend visually matches what's on the chart.
  const legendItems = $derived.by(() => {
    const visible = series.filter((s) => !s.internal);
    const items: Array<{ label: string; color: string; dashed: boolean }> = visible.map((s) => ({
      label: s.label,
      color: s.color,
      dashed: typeof s.props?.['stroke-dasharray'] === 'string',
    }));
    if (transitionData.length === 2) {
      items.push({ label: 'Running (partial)', color: '#a1a1aa', dashed: true });
    }
    return items;
  });

  const epochRange = $derived.by(() => {
    if (chartData.length === 0) return null;
    const first = chartData[0]?.epoch;
    const last = chartData[chartData.length - 1]?.epoch;
    return first !== undefined && last !== undefined ? { first, last } : null;
  });

  const hasAnySeries = $derived(series.length > 0);
</script>

<section
  class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
  aria-labelledby="chart-title"
>
  <header class="mb-3 flex items-baseline justify-between gap-3">
    <div>
      <!--
        `<h2>` not `<h3>` so the income page's heading outline stays
        monotonic — the chart sits between the page H1 and the
        per-epoch table's H2. Skipping a level here previously
        produced an `H1 → H3 → H2 → H3` rotor sequence that AT users
        land on as an unexpected discontinuity.
      -->
      <h2 id="chart-title" class="text-sm font-semibold">Income trend</h2>
      <p class="text-xs text-[color:var(--color-text-muted)]">
        Per-epoch block fees and on-chain Jito tips in SOL. Dashed tail = running epoch.
      </p>
    </div>
    {#if epochRange !== null}
      <span class="text-xs text-[color:var(--color-text-subtle)]">
        Epoch {epochRange.first} – {epochRange.last}
      </span>
    {/if}
  </header>

  {#if !hasAnySeries}
    <p class="py-12 text-center text-sm text-[color:var(--color-text-muted)]">
      No epoch fees or MEV data to plot yet. Once the indexer finishes a fee-ingester tick for any
      recent epoch, points will appear here.
    </p>
  {:else}
    <!--
      `legend={false}` — we render a filtered legend below ourselves so
      the internal transition series (`fees_running`, `mev_running`)
      stay hidden from the swatch list.

      `role="img"` + `aria-label` — the SVG chart is opaque to assistive
      tech by default. Without this, SR users skip it entirely. The
      label references the history table below for exact values so we
      don't duplicate all N points into aria-text.
    -->
    <div
      class="h-72 w-full"
      role="img"
      aria-label={epochRange
        ? `Line chart of block fees and MEV per epoch from epoch ${epochRange.first} to ${epochRange.last}. See the history table below for exact values.`
        : 'Line chart of block fees and MEV per epoch.'}
    >
      <LineChart data={chartData} x="epoch" {series} legend={false} tooltip={{ mode: 'voronoi' }}>
        <!--
          Custom tooltip — strips the internal transition series
          (`fees_running`, `mev_running`) so the hover panel shows one
          row per metric instead of two. Also looks the value up
          against `chartData` directly (the main data array carries
          every epoch), which sidesteps LayerChart's per-series
          findRelatedData lookup and keeps the code readable.

          Svelte-4 named slot syntax (`slot="tooltip"`) is required
          because LayerChart's LineChart hasn't migrated to snippets;
          the consumer API remains slot-based even from a Svelte-5
          caller.
        -->
        <svelte:fragment slot="tooltip" let:x let:width let:padding>
          <!--
            Pin the tooltip to the top-right corner of the plot area
            instead of following the cursor. The default pointer-
            following behaviour drags the panel over the y-axis when
            the user hovers near the left of the chart — the running-
            epoch dashed tail is near the RIGHT edge, so mouse-tracking
            had the tooltip constantly crossing the axis ticks (the
            "0.64 / 0.05 appearing next to the y-axis labels" visual
            clutter we were debugging).

            `x`/`y` as numbers are absolute SVG coordinates inside the
            chart container; `padding.left/right/top` account for axis
            gutters so 8px offset means "8px inside the plot edge",
            not "8px inside the SVG including axis labels".
          -->
          <Tooltip.Root
            let:data
            x={width + padding.left - 8}
            y={padding.top + 8}
            anchor="top-right"
            xOffset={0}
            yOffset={0}
          >
            <Tooltip.Header value={x(data)} />
            <Tooltip.List>
              {#each series.filter((s) => !s.internal) as s (s.key)}
                {@const point = data as Point | null}
                {@const rawValue = point === null ? null : point[s.value as keyof Point]}
                <Tooltip.Item
                  label={s.label}
                  value={typeof rawValue === 'number' ? rawValue : null}
                  color={s.color}
                  format="decimal"
                />
              {/each}
            </Tooltip.List>
          </Tooltip.Root>
        </svelte:fragment>
      </LineChart>
    </div>
    <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--color-text-muted)]">
      {#each legendItems as item (item.label)}
        <li class="flex items-center gap-2">
          <svg width="20" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="20"
              y2="4"
              stroke={item.color}
              stroke-width="2"
              stroke-dasharray={item.dashed ? '4 3' : undefined}
            />
          </svg>
          <span>{item.label}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
