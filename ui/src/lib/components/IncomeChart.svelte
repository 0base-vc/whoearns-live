<script lang="ts">
  import { LineChart, Tooltip } from 'layerchart';
  import type { ValidatorEpochRecord } from '$lib/types';
  import { labelForClientKind } from '$lib/tier';
  import ChartEmptyState from './ChartEmptyState.svelte';

  let { history }: { history: ValidatorEpochRecord[] } = $props();

  interface Point {
    epoch: number;
    validatorIncomePerSlot: number | null;
    peerAvgIncomePerSlot: number | null;
    peerSampleValidators: number | null;
    sameClientIncomePerSlot: number | null;
    sameClientSampleValidators: number | null;
  }

  const VALIDATOR_COLOR = '#f59e0b';
  const PEER_COLOR = '#64748b';
  const SAME_CLIENT_COLOR = '#0ea5e9';
  const RUNNING_DASH = '6 3';
  const PEER_DASH = '10 5';
  const SAME_CLIENT_DASH = '4 4';
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

  // Indexed-cohort MEAN per-leader-slot income (was a median). Gated on
  // a minimum sample so a thin epoch doesn't plot a noisy point.
  function peerAvgIncomePerSlot(row: ValidatorEpochRecord): number | null {
    const benchmark = row.peerBenchmark;
    if (benchmark === null || benchmark.sampleValidators < PEER_BENCHMARK_MIN_VALIDATORS) {
      return null;
    }
    const income = Number(benchmark.avgIncomeSolPerSlot);
    return Number.isFinite(income) ? income : null;
  }

  // Same-client cohort MEAN — the subset of the indexed sample running
  // this validator's client. `null` (no line) when the client is
  // unknown, no same-client peer had income, or the cohort is below the
  // minimum sample.
  function sameClientIncomePerSlot(row: ValidatorEpochRecord): number | null {
    const benchmark = row.peerBenchmark;
    if (
      benchmark === null ||
      benchmark.sameClientAvgIncomeSolPerSlot === null ||
      benchmark.sameClientSampleValidators < PEER_BENCHMARK_MIN_VALIDATORS
    ) {
      return null;
    }
    const income = Number(benchmark.sameClientAvgIncomeSolPerSlot);
    return Number.isFinite(income) ? income : null;
  }

  const sortedHistory = $derived(
    [...history]
      .sort((a, b) => a.epoch - b.epoch)
      .filter((row) => validatorIncomePerSlot(row) !== null),
  );

  // Friendly client name for the same-client series label, taken from
  // the benchmark's `clientKind` (identical across epochs). `null` →
  // the same-client series doesn't render.
  const clientLabel = $derived.by<string | null>(() => {
    // Off the unfiltered `history` (not `sortedHistory`) so the client
    // name is still resolved for the empty state, where the own-income
    // filter would otherwise leave no rows to read `clientKind` from.
    const kind =
      history.find((r) => (r.peerBenchmark?.clientKind ?? null) !== null)?.peerBenchmark
        ?.clientKind ?? null;
    if (kind === null) return null;
    return labelForClientKind(kind);
  });
  const sameClientSeriesLabel = $derived(
    clientLabel === null ? 'Same client' : `${clientLabel} avg`,
  );

  const chartData = $derived.by<Point[]>(() =>
    sortedHistory.map((row) => {
      const peerAvg = peerAvgIncomePerSlot(row);
      const sameClient = sameClientIncomePerSlot(row);
      return {
        epoch: row.epoch,
        validatorIncomePerSlot: validatorIncomePerSlot(row),
        peerAvgIncomePerSlot: peerAvg,
        peerSampleValidators:
          peerAvg === null ? null : (row.peerBenchmark?.sampleValidators ?? null),
        sameClientIncomePerSlot: sameClient,
        sameClientSampleValidators:
          sameClient === null ? null : (row.peerBenchmark?.sameClientSampleValidators ?? null),
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
  const hasPeerAvg = $derived(chartData.some((p) => p.peerAvgIncomePerSlot !== null));
  const hasSameClient = $derived(chartData.some((p) => p.sameClientIncomePerSlot !== null));

  // Latest cohort numbers, shown small in the empty state when this
  // validator has no own line yet. Read from the unfiltered `history`
  // (the own-income filter behind `sortedHistory` drops the very rows
  // the benchmark lives on); newest epoch with a value wins.
  const cohortContext = $derived.by<Array<{ label: string; value: string }>>(() => {
    const newestFirst = [...history].sort((a, b) => b.epoch - a.epoch);
    const stats: Array<{ label: string; value: string }> = [];
    const peerRow = newestFirst.find((r) => peerAvgIncomePerSlot(r) !== null);
    if (peerRow !== undefined) {
      stats.push({
        label: 'Indexed average',
        value: `${formatIncomePerSlot(peerAvgIncomePerSlot(peerRow))} SOL/slot`,
      });
    }
    const sameClientRow = newestFirst.find((r) => sameClientIncomePerSlot(r) !== null);
    if (sameClientRow !== undefined) {
      stats.push({
        label: sameClientSeriesLabel,
        value: `${formatIncomePerSlot(sameClientIncomePerSlot(sameClientRow))} SOL/slot`,
      });
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
    if (hasPeerAvg) {
      s.push({
        key: 'peer_avg',
        label: 'Indexed average',
        value: 'peerAvgIncomePerSlot',
        color: PEER_COLOR,
        data: chartData,
        props: { 'stroke-dasharray': PEER_DASH, opacity: 0.9 },
      });
    }
    if (hasSameClient) {
      s.push({
        key: 'same_client',
        label: sameClientSeriesLabel,
        value: 'sameClientIncomePerSlot',
        color: SAME_CLIENT_COLOR,
        data: chartData,
        props: { 'stroke-dasharray': SAME_CLIENT_DASH, opacity: 0.9 },
      });
    }
    return s;
  });

  const legendItems = $derived.by(() => {
    const items: Array<{ label: string; color: string; dashed: boolean }> = [
      { label: 'This validator', color: VALIDATOR_COLOR, dashed: false },
    ];
    if (hasPeerAvg) {
      items.push({ label: 'Indexed average', color: PEER_COLOR, dashed: true });
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

  function percentVs(value: number | null, baseline: number | null): number | null {
    if (value === null || baseline === null || baseline <= 0) return null;
    return value / baseline - 1;
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
    {#if epochRange !== null && hasValidator}
      <span class="whitespace-nowrap text-xs text-[color:var(--color-text-subtle)]">
        Epoch {epochRange.first} - {epochRange.last}
      </span>
    {/if}
  </header>

  {#if !hasValidator}
    <ChartEmptyState
      message="No leader-slot income for this validator in this window yet. Its line appears once the indexer records blocks it produces — usually from the next epoch it's tracked."
      cohortStats={cohortContext}
    />
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
              {#if point?.peerAvgIncomePerSlot !== null && point?.peerAvgIncomePerSlot !== undefined}
                <Tooltip.Item
                  label="Indexed average"
                  value={point.peerAvgIncomePerSlot}
                  color={PEER_COLOR}
                >
                  {formatIncomePerSlot(point.peerAvgIncomePerSlot)}
                </Tooltip.Item>
              {/if}
              {#if point?.sameClientIncomePerSlot !== null && point?.sameClientIncomePerSlot !== undefined}
                <Tooltip.Item
                  label={sameClientSeriesLabel}
                  value={point.sameClientIncomePerSlot}
                  color={SAME_CLIENT_COLOR}
                >
                  {formatIncomePerSlot(point.sameClientIncomePerSlot)}
                </Tooltip.Item>
              {/if}
            </Tooltip.List>
            {#if point !== null && (point.peerAvgIncomePerSlot !== null || point.sameClientIncomePerSlot !== null)}
              <div
                class="mt-2 space-y-1 border-t border-[color:var(--color-border-subtle)] pt-2 text-xs text-[color:var(--color-text-muted)]"
              >
                {#if point.peerAvgIncomePerSlot !== null}
                  <div>
                    % vs indexed avg: {formatSignedPercent(
                      percentVs(point.validatorIncomePerSlot, point.peerAvgIncomePerSlot),
                    )}
                    {#if point.peerSampleValidators !== null}(n={point.peerSampleValidators}){/if}
                  </div>
                {/if}
                {#if point.sameClientIncomePerSlot !== null}
                  <div>
                    % vs {sameClientSeriesLabel}: {formatSignedPercent(
                      percentVs(point.validatorIncomePerSlot, point.sameClientIncomePerSlot),
                    )}
                    {#if point.sameClientSampleValidators !== null}(n={point.sameClientSampleValidators}){/if}
                  </div>
                {/if}
              </div>
            {/if}
          </Tooltip.Root>
        </svelte:fragment>
      </LineChart>
    </div>
    <!--
      Accessible data table. Wrapped in an `sr-only` DIV rather than putting
      `sr-only` on the <table> itself: `width:1px` is ignored by a
      `table-layout:auto` table (it grows to its `whitespace-nowrap` content,
      ~1000px+), which then escapes the viewport and creates a huge horizontal
      scroll on mobile. A normal block div honours `width:1px;overflow:hidden`
      and clips the table.
    -->
    <div class="sr-only">
      <table>
        <caption> Chart values for income per leader slot by epoch. </caption>
        <thead>
          <tr>
            <th scope="col">Epoch</th>
            <th scope="col">This validator SOL per leader slot</th>
            <th scope="col">Indexed average SOL per leader slot</th>
            <th scope="col">Indexed validator sample size</th>
            <th scope="col">{sameClientSeriesLabel} SOL per leader slot</th>
            <th scope="col">Same-client sample size</th>
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
                {point.peerAvgIncomePerSlot === null
                  ? 'not available'
                  : formatIncomePerSlot(point.peerAvgIncomePerSlot)}
              </td>
              <td>{point.peerSampleValidators ?? 'not available'}</td>
              <td>
                {point.sameClientIncomePerSlot === null
                  ? 'not available'
                  : formatIncomePerSlot(point.sameClientIncomePerSlot)}
              </td>
              <td>{point.sameClientSampleValidators ?? 'not available'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
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
    {#if hasSameClient}
      <p class="mt-1 text-[11px] text-[color:var(--color-text-subtle)]">
        The same-client line groups peers by their current client, applied across past epochs.
      </p>
    {/if}
  {/if}
</section>
