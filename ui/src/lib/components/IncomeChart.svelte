<script lang="ts">
  import { LineChart, Tooltip } from 'layerchart';
  import type { ValidatorEpochRecord } from '$lib/types';

  let { history }: { history: ValidatorEpochRecord[] } = $props();

  interface Point {
    epoch: number;
    validatorIncomePerSlot: number | null;
    peerMedianIncomePerSlot: number | null;
    peerSampleValidators: number | null;
  }

  const VALIDATOR_COLOR = '#f59e0b';
  const PEER_COLOR = '#64748b';
  const RUNNING_DASH = '6 3';
  const PEER_DASH = '10 5';
  const PEER_BENCHMARK_MIN_VALIDATORS = 3;
  const INCOME_PER_SLOT_DECIMALS = 4;
  const AXIS_TEXT_FILL = 'var(--color-text-muted)';
  const AXIS_SUBTLE_FILL = 'var(--color-text-subtle)';

  function denominatorFor(row: ValidatorEpochRecord): number | null {
    const slots = row.isCurrentEpoch ? row.slotsElapsedAssigned : row.slotsAssigned;
    return slots !== null && slots > 0 ? slots : null;
  }

  function validatorIncomePerSlot(row: ValidatorEpochRecord): number | null {
    const denominator = denominatorFor(row);
    if (denominator === null || row.totalIncomeSol === null) return null;
    const income = Number(row.totalIncomeSol);
    if (!Number.isFinite(income)) return null;
    return income / denominator;
  }

  function peerMedianIncomePerSlot(row: ValidatorEpochRecord): number | null {
    const benchmark = row.peerBenchmark;
    if (benchmark === null || benchmark.sampleValidators < PEER_BENCHMARK_MIN_VALIDATORS) {
      return null;
    }
    const income = Number(benchmark.medianIncomeSolPerSlot);
    return Number.isFinite(income) ? income : null;
  }

  const sortedHistory = $derived(
    [...history]
      .sort((a, b) => a.epoch - b.epoch)
      .filter((row) => validatorIncomePerSlot(row) !== null),
  );

  const chartData = $derived.by<Point[]>(() =>
    sortedHistory.map((row) => {
      const peerMedian = peerMedianIncomePerSlot(row);
      return {
        epoch: row.epoch,
        validatorIncomePerSlot: validatorIncomePerSlot(row),
        peerMedianIncomePerSlot: peerMedian,
        peerSampleValidators:
          peerMedian === null ? null : (row.peerBenchmark?.sampleValidators ?? null),
      };
    }),
  );

  const transition = $derived.by(() => {
    if (chartData.length < 2) return null;
    const lastHistory = sortedHistory[sortedHistory.length - 1];
    if (!lastHistory?.isCurrentEpoch) return null;
    const prev = chartData[chartData.length - 2];
    const running = chartData[chartData.length - 1];
    if (!prev || !running) return null;
    return { prev, running };
  });

  const closedData = $derived.by<Point[]>(() => {
    if (transition === null) return chartData;
    return chartData.slice(0, chartData.length - 1);
  });

  const transitionData = $derived.by<Point[]>(() =>
    transition === null ? [] : [transition.prev, transition.running],
  );

  const hasValidator = $derived(chartData.some((p) => p.validatorIncomePerSlot !== null));
  const hasPeerMedian = $derived(chartData.some((p) => p.peerMedianIncomePerSlot !== null));

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
        value: 'validatorIncomePerSlot',
        color: VALIDATOR_COLOR,
        data: closedData,
      });
      if (transitionData.length === 2) {
        s.push({
          key: 'validator_running',
          label: '',
          value: 'validatorIncomePerSlot',
          color: VALIDATOR_COLOR,
          data: transitionData,
          props: { 'stroke-dasharray': RUNNING_DASH, opacity: 0.85 },
          internal: true,
        });
      }
    }
    if (hasPeerMedian) {
      s.push({
        key: 'peer_median',
        label: 'Indexed median',
        value: 'peerMedianIncomePerSlot',
        color: PEER_COLOR,
        data: chartData,
        props: { 'stroke-dasharray': PEER_DASH, opacity: 0.9 },
      });
    }
    return s;
  });

  const legendItems = $derived.by(() => {
    const items: Array<{ label: string; color: string; dashed: boolean }> = [
      { label: 'This validator', color: VALIDATOR_COLOR, dashed: false },
    ];
    if (hasPeerMedian) {
      items.push({ label: 'Indexed median', color: PEER_COLOR, dashed: true });
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

  function percentVsMedian(point: Point | null): number | null {
    if (
      point === null ||
      point.validatorIncomePerSlot === null ||
      point.peerMedianIncomePerSlot === null ||
      point.peerMedianIncomePerSlot <= 0
    ) {
      return null;
    }
    return point.validatorIncomePerSlot / point.peerMedianIncomePerSlot - 1;
  }

  function formatSignedPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return 'n/a';
    const formatted = new Intl.NumberFormat('en', {
      maximumFractionDigits: 1,
      signDisplay: 'always',
      style: 'percent',
    }).format(value);
    return formatted;
  }

  function formatIncomePerSlot(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'n/a';
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(INCOME_PER_SLOT_DECIMALS) : 'n/a';
  }
</script>

<section
  class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
  aria-labelledby="chart-title"
>
  <header class="mb-3 flex items-baseline justify-between gap-3">
    <div>
      <h2 id="chart-title" class="text-sm font-semibold">Income per leader slot</h2>
      <p class="text-xs text-[color:var(--color-text-muted)]">
        Total income normalized by scheduled leader slots. Dashed final segment = running epoch.
      </p>
    </div>
    {#if epochRange !== null}
      <span class="text-xs text-[color:var(--color-text-subtle)]">
        Epoch {epochRange.first} - {epochRange.last}
      </span>
    {/if}
  </header>

  {#if !hasAnySeries}
    <p class="py-12 text-center text-sm text-[color:var(--color-text-muted)]">
      No epoch income data to plot yet. Once the indexer processes leader-slot income, points will
      appear here.
    </p>
  {:else}
    <div
      class="h-72 w-full"
      role="img"
      aria-label={epochRange
        ? `Line chart of total income per leader slot from epoch ${epochRange.first} to ${epochRange.last}. A hidden table below lists the chart values.`
        : 'Line chart of total income per leader slot.'}
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
            format: formatIncomePerSlot,
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
              <Tooltip.Item
                label="This validator"
                value={point?.validatorIncomePerSlot ?? null}
                color={VALIDATOR_COLOR}
              >
                {formatIncomePerSlot(point?.validatorIncomePerSlot)}
              </Tooltip.Item>
              {#if point?.peerMedianIncomePerSlot !== null && point?.peerMedianIncomePerSlot !== undefined}
                <Tooltip.Item
                  label="Indexed median"
                  value={point.peerMedianIncomePerSlot}
                  color={PEER_COLOR}
                >
                  {formatIncomePerSlot(point.peerMedianIncomePerSlot)}
                </Tooltip.Item>
              {/if}
            </Tooltip.List>
            {#if point?.peerMedianIncomePerSlot !== null && point?.peerMedianIncomePerSlot !== undefined}
              <div
                class="mt-2 space-y-1 border-t border-[color:var(--color-border-subtle)] pt-2 text-xs text-[color:var(--color-text-muted)]"
              >
                <div>% vs median: {formatSignedPercent(percentVsMedian(point))}</div>
                {#if point.peerSampleValidators !== null}
                  <div>n={point.peerSampleValidators}</div>
                {/if}
              </div>
            {/if}
          </Tooltip.Root>
        </svelte:fragment>
      </LineChart>
    </div>
    <table class="sr-only">
      <caption> Chart values for income per leader slot by epoch. </caption>
      <thead>
        <tr>
          <th scope="col">Epoch</th>
          <th scope="col">This validator SOL per leader slot</th>
          <th scope="col">Indexed median SOL per leader slot</th>
          <th scope="col">Indexed validator sample size</th>
        </tr>
      </thead>
      <tbody>
        {#each chartData as point (point.epoch)}
          <tr>
            <th scope="row">{point.epoch}</th>
            <td>
              {point.validatorIncomePerSlot === null
                ? 'not available'
                : formatIncomePerSlot(point.validatorIncomePerSlot)}
            </td>
            <td>
              {point.peerMedianIncomePerSlot === null
                ? 'not available'
                : formatIncomePerSlot(point.peerMedianIncomePerSlot)}
            </td>
            <td>{point.peerSampleValidators ?? 'not available'}</td>
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
