<!--
  Per-epoch compute-units chart. A sibling of `IncomeChart.svelte` —
  same epoch x-axis, same visual language (axis/tick treatment,
  voronoi tooltip, dashed running-epoch segment, sr-only data table,
  CSS-variable theming so dark mode + the global reduced-motion reset
  in `app.css` apply automatically).

  Three series:
    - This validator's `avgComputeUnitsPerProducedBlock` per epoch.
    - The `serviceAverageCu` per epoch (all tracked validators).
    - The `sameClientAverageCu` per epoch (tracked validators running
      this one's client) — `null` when the client is unknown / no
      same-client peer produced a block.

  All API fields are stringified integers in the tens of millions and
  may be `null`. Null points are dropped (the series skips the epoch —
  a gap) rather than plotted as 0, which would read as a real "zero CU"
  data point.
-->
<script lang="ts">
  import { LineChart, Tooltip } from 'layerchart';
  import type { ValidatorEpochRecord } from '$lib/types';
  import { TRUST_CLIENT_LABEL } from '$lib/tier';
  import ChartEmptyState from './ChartEmptyState.svelte';

  let { history }: { history: ValidatorEpochRecord[] } = $props();

  interface Point {
    epoch: number;
    validatorCu: number | null;
    serviceCu: number | null;
    sameClientCu: number | null;
  }

  // Mirrors IncomeChart's palette so the two charts read as a pair:
  // amber = this validator, slate = service, sky = same-client.
  const VALIDATOR_COLOR = '#f59e0b';
  const SERVICE_COLOR = '#64748b';
  const SAME_CLIENT_COLOR = '#0ea5e9';
  const RUNNING_DASH = '6 3';
  const SERVICE_DASH = '10 5';
  const SAME_CLIENT_DASH = '4 4';
  // Minimum same-client cohort to plot the line — matches IncomeChart's
  // gate so the two charts surface the same-client series together. The
  // count lives on the income benchmark (`peerBenchmark`) on each row;
  // the CU aggregate itself returns no per-cohort count.
  const PEER_BENCHMARK_MIN_VALIDATORS = 3;
  const AXIS_TEXT_FILL = 'var(--color-text-muted)';
  const AXIS_SUBTLE_FILL = 'var(--color-text-subtle)';

  /**
   * Parse a stringified-integer CU field into a finite number, or
   * `null` when the field is null/unparseable. CU values are tens of
   * millions — well inside `Number`'s safe-integer range — so a plain
   * `Number()` is precise enough for chart positioning.
   */
  function parseCu(value: string | null): number | null {
    if (value === null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function validatorCu(row: ValidatorEpochRecord): number | null {
    return parseCu(row.avgComputeUnitsPerProducedBlock);
  }

  function serviceCu(row: ValidatorEpochRecord): number | null {
    return parseCu(row.serviceAverageCu);
  }

  function sameClientCu(row: ValidatorEpochRecord): number | null {
    // Gate on the income benchmark's same-client cohort size so a
    // 1-2 validator client doesn't plot a line that's essentially this
    // validator compared against itself.
    const cohort = row.peerBenchmark?.sameClientSampleValidators ?? 0;
    if (cohort < PEER_BENCHMARK_MIN_VALIDATORS) return null;
    return parseCu(row.sameClientAverageCu);
  }

  // Keep an epoch only when it has at least one plottable CU value.
  // Epochs with neither would otherwise widen the x-axis with empty
  // space.
  const sortedHistory = $derived(
    [...history]
      .sort((a, b) => a.epoch - b.epoch)
      .filter(
        (row) => validatorCu(row) !== null || serviceCu(row) !== null || sameClientCu(row) !== null,
      ),
  );

  // Friendly client name for the same-client series label, off the
  // benchmark's `clientKind` (identical across epochs).
  const clientLabel = $derived.by<string | null>(() => {
    // Off the unfiltered `history` (not `sortedHistory`) so the client
    // name still resolves in the empty state.
    const kind =
      history.find((r) => (r.peerBenchmark?.clientKind ?? null) !== null)?.peerBenchmark
        ?.clientKind ?? null;
    if (kind === null) return null;
    return TRUST_CLIENT_LABEL[kind] ?? kind;
  });
  const sameClientSeriesLabel = $derived(
    clientLabel === null ? 'Same client' : `${clientLabel} avg`,
  );

  const chartData = $derived.by<Point[]>(() =>
    sortedHistory.map((row) => ({
      epoch: row.epoch,
      validatorCu: validatorCu(row),
      serviceCu: serviceCu(row),
      sameClientCu: sameClientCu(row),
    })),
  );

  // Running-epoch handling mirrors IncomeChart: when the newest epoch
  // is still live, its segment is drawn separately with a dashed
  // stroke so readers can tell the in-progress point apart from
  // closed-epoch history.
  const transition = $derived.by(() => {
    if (chartData.length < 2) return null;
    const lastHistory = sortedHistory[sortedHistory.length - 1];
    if (!lastHistory?.isCurrentEpoch) return null;
    const prev = chartData[chartData.length - 2];
    const running = chartData[chartData.length - 1];
    if (!prev || !running) return null;
    // Both endpoints must carry a validator value AND `prev` must be
    // the IMMEDIATELY preceding epoch: the dashed segment marks a
    // genuine adjacent closed -> running step. If the prior epoch is a
    // validator gap we draw no dashed cue rather than connect a
    // straight line across the gap epoch's x-position (which would
    // fabricate a validator value where there is none).
    if (prev.validatorCu === null || running.validatorCu === null) return null;
    return { prev, running };
  });

  const closedData = $derived.by<Point[]>(() => {
    if (transition === null) return chartData;
    return chartData.slice(0, chartData.length - 1);
  });

  const transitionData = $derived.by<Point[]>(() =>
    transition === null ? [] : [transition.prev, transition.running],
  );

  const hasValidator = $derived(chartData.some((p) => p.validatorCu !== null));
  const hasService = $derived(chartData.some((p) => p.serviceCu !== null));
  const hasSameClient = $derived(chartData.some((p) => p.sameClientCu !== null));

  // Latest cohort numbers, shown small in the empty state when this
  // validator has no produced-block line yet; newest epoch with a value
  // wins. Read from the unfiltered `history` to stay correct regardless
  // of the per-row plot filter.
  const cohortContext = $derived.by<Array<{ label: string; value: string }>>(() => {
    const newestFirst = [...history].sort((a, b) => b.epoch - a.epoch);
    const stats: Array<{ label: string; value: string }> = [];
    const serviceRow = newestFirst.find((r) => serviceCu(r) !== null);
    if (serviceRow !== undefined) {
      stats.push({ label: 'Indexed average', value: formatCu(serviceCu(serviceRow)) });
    }
    const sameClientRow = newestFirst.find((r) => sameClientCu(r) !== null);
    if (sameClientRow !== undefined) {
      stats.push({ label: sameClientSeriesLabel, value: formatCu(sameClientCu(sameClientRow)) });
    }
    return stats;
  });

  interface SeriesConfig {
    key: string;
    label: string;
    value: string;
    color: string;
    data?: Point[];
    props?: Record<string, unknown>;
    internal?: boolean;
  }

  const series = $derived.by<SeriesConfig[]>(() => {
    const s: SeriesConfig[] = [];
    if (hasValidator) {
      s.push({
        key: 'validator',
        label: 'This validator',
        value: 'validatorCu',
        color: VALIDATOR_COLOR,
        data: closedData,
      });
      if (transitionData.length === 2) {
        s.push({
          key: 'validator_running',
          label: '',
          value: 'validatorCu',
          color: VALIDATOR_COLOR,
          data: transitionData,
          props: { 'stroke-dasharray': RUNNING_DASH, opacity: 0.85 },
          internal: true,
        });
      }
    }
    if (hasService) {
      s.push({
        key: 'service_average',
        label: 'Indexed average',
        value: 'serviceCu',
        color: SERVICE_COLOR,
        data: chartData,
        props: { 'stroke-dasharray': SERVICE_DASH, opacity: 0.9 },
      });
    }
    if (hasSameClient) {
      s.push({
        key: 'same_client',
        label: sameClientSeriesLabel,
        value: 'sameClientCu',
        color: SAME_CLIENT_COLOR,
        data: chartData,
        props: { 'stroke-dasharray': SAME_CLIENT_DASH, opacity: 0.9 },
      });
    }
    return s;
  });

  const legendItems = $derived.by(() => {
    const items: Array<{ label: string; color: string; dashed: boolean }> = [];
    if (hasValidator) {
      items.push({ label: 'This validator', color: VALIDATOR_COLOR, dashed: false });
    }
    if (hasService) {
      items.push({ label: 'Indexed average', color: SERVICE_COLOR, dashed: true });
    }
    if (hasSameClient) {
      items.push({ label: sameClientSeriesLabel, color: SAME_CLIENT_COLOR, dashed: true });
    }
    return items;
  });

  const epochRange = $derived.by(() => {
    if (chartData.length === 0) return null;
    const first = chartData[0]?.epoch;
    const last = chartData[chartData.length - 1]?.epoch;
    return first !== undefined && last !== undefined ? { first, last } : null;
  });

  /**
   * Compact human-readable CU formatting for axis ticks + tooltip.
   * Tens of millions render as e.g. `31.2M`; smaller values fall back
   * to thousands-separated integers. `n/a` for missing points so the
   * tooltip and sr-only table never show a misleading `0`.
   */
  function formatCu(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'n/a';
    const n = Number(value);
    if (!Number.isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1_000_000) {
      return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n / 1_000_000)}M`;
    }
    if (Math.abs(n) >= 1_000) {
      return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n / 1_000)}K`;
    }
    return new Intl.NumberFormat('en').format(n);
  }

  /** Exact thousands-separated integer for the accessible data table. */
  function formatCuExact(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return 'not available';
    return new Intl.NumberFormat('en').format(value);
  }

  /** Signed % delta of the validator vs a comparison series. */
  function percentVs(value: number | null, baseline: number | null): number | null {
    if (value === null || baseline === null || baseline <= 0) return null;
    return value / baseline - 1;
  }

  function formatSignedPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return 'n/a';
    return new Intl.NumberFormat('en', {
      maximumFractionDigits: 1,
      signDisplay: 'always',
      style: 'percent',
    }).format(value);
  }
</script>

<section
  class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
  aria-labelledby="cu-chart-title"
>
  <header class="mb-3 flex items-baseline justify-between gap-3">
    <div>
      <h2 id="cu-chart-title" class="text-sm font-semibold">Compute units per block</h2>
      <p class="text-xs text-[color:var(--color-text-muted)]">
        Average compute units per produced block. Dashed final segment = running epoch.
      </p>
    </div>
    {#if epochRange !== null && hasValidator}
      <span class="whitespace-nowrap text-xs text-[color:var(--color-text-subtle)]">
        Epoch {epochRange.first} - {epochRange.last}
      </span>
    {/if}
  </header>

  {#if !hasValidator}
    <ChartEmptyState
      message="No produced-block compute units for this validator in this window yet. Its line appears once the indexer records blocks it produces — usually from the next epoch it's tracked."
      cohortStats={cohortContext}
    />
  {:else}
    <div
      class="h-72 w-full"
      role="img"
      aria-label={epochRange
        ? `Line chart of average compute units per produced block from epoch ${epochRange.first} to ${epochRange.last}. A hidden table below lists the chart values.`
        : 'Line chart of average compute units per produced block.'}
    >
      <LineChart
        data={chartData}
        x="epoch"
        {series}
        legend={false}
        tooltip={{ mode: 'voronoi' }}
        props={{
          xAxis: {
            tickLabelProps: {
              fill: AXIS_SUBTLE_FILL,
            },
            tickLength: 0,
          },
          yAxis: {
            format: formatCu,
            tickLabelProps: {
              fill: AXIS_TEXT_FILL,
            },
            tickLength: 0,
          },
        }}
      >
        <svelte:fragment slot="tooltip" let:x let:width let:padding>
          <Tooltip.Root
            let:data
            x={width + padding.left - 8}
            y={padding.top + 8}
            anchor="top-right"
            xOffset={0}
            yOffset={0}
          >
            {@const point = data as Point | null}
            <Tooltip.Header value={x(data)} />
            <Tooltip.List>
              {#if point?.validatorCu !== null && point?.validatorCu !== undefined}
                <Tooltip.Item
                  label="This validator"
                  value={point.validatorCu}
                  color={VALIDATOR_COLOR}
                >
                  {formatCu(point.validatorCu)}
                </Tooltip.Item>
              {/if}
              {#if point?.serviceCu !== null && point?.serviceCu !== undefined}
                <Tooltip.Item label="Indexed average" value={point.serviceCu} color={SERVICE_COLOR}>
                  {formatCu(point.serviceCu)}
                </Tooltip.Item>
              {/if}
              {#if point?.sameClientCu !== null && point?.sameClientCu !== undefined}
                <Tooltip.Item
                  label={sameClientSeriesLabel}
                  value={point.sameClientCu}
                  color={SAME_CLIENT_COLOR}
                >
                  {formatCu(point.sameClientCu)}
                </Tooltip.Item>
              {/if}
            </Tooltip.List>
            {#if point !== null && (point.serviceCu !== null || point.sameClientCu !== null)}
              <div
                class="mt-2 space-y-1 border-t border-[color:var(--color-border-subtle)] pt-2 text-xs text-[color:var(--color-text-muted)]"
              >
                {#if point.serviceCu !== null}
                  <div>
                    % vs indexed avg: {formatSignedPercent(
                      percentVs(point.validatorCu, point.serviceCu),
                    )}
                  </div>
                {/if}
                {#if point.sameClientCu !== null}
                  <div>
                    % vs {sameClientSeriesLabel}: {formatSignedPercent(
                      percentVs(point.validatorCu, point.sameClientCu),
                    )}
                  </div>
                {/if}
              </div>
            {/if}
          </Tooltip.Root>
        </svelte:fragment>
      </LineChart>
    </div>
    <table class="sr-only">
      <caption> Chart values for average compute units per produced block by epoch. </caption>
      <thead>
        <tr>
          <th scope="col">Epoch</th>
          <th scope="col">This validator compute units per block</th>
          <th scope="col">Indexed average compute units per block</th>
          <th scope="col">{sameClientSeriesLabel} compute units per block</th>
        </tr>
      </thead>
      <tbody>
        {#each chartData as point (point.epoch)}
          <tr>
            <th scope="row">{point.epoch}</th>
            <td>{formatCuExact(point.validatorCu)}</td>
            <td>{formatCuExact(point.serviceCu)}</td>
            <td>{formatCuExact(point.sameClientCu)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
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
    {#if hasSameClient}
      <p class="mt-1 text-[11px] text-[color:var(--color-text-subtle)]">
        The same-client line groups peers by their current client, applied across past epochs.
      </p>
    {/if}
  {/if}
</section>
