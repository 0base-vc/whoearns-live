<!--
  Per-epoch compute-units chart. A sibling of `IncomeChart.svelte` —
  same epoch x-axis, same visual language (axis/tick treatment,
  voronoi tooltip, dashed running-epoch segment, sr-only data table,
  CSS-variable theming so dark mode + the global reduced-motion reset
  in `app.css` apply automatically).

  Two series:
    - This validator's `avgComputeUnitsPerProducedBlock` per epoch.
    - The service-wide `serviceAverageCu` per epoch.

  Both API fields are stringified integers in the tens of millions and
  may be `null`. Null points are dropped (the series skips the epoch —
  a gap) rather than plotted as 0, which would read as a real "zero CU"
  data point.
-->
<script lang="ts">
  import { LineChart, Tooltip } from 'layerchart';
  import type { ValidatorEpochRecord } from '$lib/types';

  let { history }: { history: ValidatorEpochRecord[] } = $props();

  interface Point {
    epoch: number;
    validatorCu: number | null;
    serviceCu: number | null;
  }

  // Mirrors IncomeChart's palette so the two charts read as a pair:
  // amber = this validator, slate = the comparison series.
  const VALIDATOR_COLOR = '#f59e0b';
  const SERVICE_COLOR = '#64748b';
  const RUNNING_DASH = '6 3';
  const SERVICE_DASH = '10 5';
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

  // Keep an epoch only when it has at least one plottable CU value.
  // Epochs with neither would otherwise widen the x-axis with empty
  // space.
  const sortedHistory = $derived(
    [...history]
      .sort((a, b) => a.epoch - b.epoch)
      .filter((row) => validatorCu(row) !== null || serviceCu(row) !== null),
  );

  const chartData = $derived.by<Point[]>(() =>
    sortedHistory.map((row) => ({
      epoch: row.epoch,
      validatorCu: validatorCu(row),
      serviceCu: serviceCu(row),
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
        label: 'Service average',
        value: 'serviceCu',
        color: SERVICE_COLOR,
        data: chartData,
        props: { 'stroke-dasharray': SERVICE_DASH, opacity: 0.9 },
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
      items.push({ label: 'Service average', color: SERVICE_COLOR, dashed: true });
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

  /** Validator CU as a signed % delta vs the service average. */
  function percentVsService(point: Point | null): number | null {
    if (
      point === null ||
      point.validatorCu === null ||
      point.serviceCu === null ||
      point.serviceCu <= 0
    ) {
      return null;
    }
    return point.validatorCu / point.serviceCu - 1;
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
    {#if epochRange !== null}
      <span class="whitespace-nowrap text-xs text-[color:var(--color-text-subtle)]">
        Epoch {epochRange.first} - {epochRange.last}
      </span>
    {/if}
  </header>

  {#if !hasAnySeries}
    <p class="py-12 text-center text-sm text-[color:var(--color-text-muted)]">
      No compute-unit data to plot yet. Once the indexer processes produced blocks, points will
      appear here.
    </p>
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
                <Tooltip.Item label="Service average" value={point.serviceCu} color={SERVICE_COLOR}>
                  {formatCu(point.serviceCu)}
                </Tooltip.Item>
              {/if}
            </Tooltip.List>
            {#if percentVsService(point ?? null) !== null}
              <div
                class="mt-2 space-y-1 border-t border-[color:var(--color-border-subtle)] pt-2 text-xs text-[color:var(--color-text-muted)]"
              >
                <div>% vs service: {formatSignedPercent(percentVsService(point ?? null))}</div>
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
          <th scope="col">Service average compute units per block</th>
        </tr>
      </thead>
      <tbody>
        {#each chartData as point (point.epoch)}
          <tr>
            <th scope="row">{point.epoch}</th>
            <td>{formatCuExact(point.validatorCu)}</td>
            <td>{formatCuExact(point.serviceCu)}</td>
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
  {/if}
</section>
