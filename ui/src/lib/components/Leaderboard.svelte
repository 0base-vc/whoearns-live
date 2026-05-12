<!--
  Homepage cluster leaderboard.

  The default view is `live_trend`: current epoch income so far plus
  the latest closed epoch. That fits the product promise better than a
  purely closed-epoch table while still smoothing out tiny current-only
  samples. Visitors can switch to current-only, stable-trend, or the
  latest final epoch without leaving the page.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchCurrentEpoch, fetchLeaderboard } from '$lib/api';
  import { formatSolFixed, shortenPubkey } from '$lib/format';
  import type {
    CurrentEpoch,
    Leaderboard,
    LeaderboardItem,
    LeaderboardSort,
    LeaderboardWindow,
  } from '$lib/types';
  import Tooltip from './Tooltip.svelte';
  import VerifiedBadge from './VerifiedBadge.svelte';

  interface Props {
    /** How many rows to show. Server caps at 500. */
    limit?: number;
  }
  let { limit = 25 }: Props = $props();

  const DECIMALS_PER_SLOT = 6;
  const DECIMALS_TOTAL = 3;

  const WINDOW_OPTIONS: Array<{ key: LeaderboardWindow; label: string; detail: string }> = [
    {
      key: 'live_trend',
      label: 'Live trend',
      detail: 'Current epoch so far + latest final epoch',
    },
    {
      key: 'current_only',
      label: 'Current only',
      detail: 'Only elapsed slots in the running epoch',
    },
    {
      key: 'stable_trend',
      label: 'Stable trend',
      detail: 'Current epoch so far + two final epochs',
    },
    {
      key: 'final_epoch',
      label: 'Final epoch',
      detail: 'Latest closed epoch only',
    },
  ];

  const COLUMNS: Array<{
    key: LeaderboardSort;
    label: string;
    tooltip: string;
    alignRight: boolean;
  }> = [
    {
      key: 'income_per_slot',
      label: 'Income / slot',
      tooltip:
        'Block fees + on-chain Jito tips divided by leader slots in the selected window. Current epochs use elapsed assigned slots.',
      alignRight: true,
    },
    {
      key: 'total_income',
      label: 'Total income',
      tooltip:
        'Block fees + on-chain Jito tips in the selected window. Larger validators tend to rank higher because they receive more leader slots.',
      alignRight: true,
    },
    {
      key: 'mev_tips',
      label: 'MEV tips',
      tooltip: 'On-chain Jito tips observed in produced blocks for the selected window.',
      alignRight: true,
    },
    {
      key: 'fees',
      label: 'Block fees',
      tooltip: 'Base fees + priority fees earned by produced blocks in the selected window.',
      alignRight: true,
    },
    {
      key: 'skip_rate',
      label: 'Skip rate',
      tooltip: 'Share of scheduled leader slots that were skipped. Lower is better.',
      alignRight: true,
    },
  ];

  let data = $state<Leaderboard | null>(null);
  let currentEpoch = $state<CurrentEpoch | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let sort = $state<LeaderboardSort>('income_per_slot');
  let window = $state<LeaderboardWindow>('live_trend');

  const activeCol = $derived(COLUMNS.find((c) => c.key === sort) ?? COLUMNS[0]!);
  const activeWindow = $derived(
    WINDOW_OPTIONS.find((option) => option.key === window) ?? WINDOW_OPTIONS[0]!,
  );

  async function load(nextSort: LeaderboardSort = sort, nextWindow: LeaderboardWindow = window) {
    loading = true;
    error = null;
    try {
      data = await fetchLeaderboard({ limit, sort: nextSort, window: nextWindow });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function loadCurrentEpoch(): Promise<void> {
    try {
      currentEpoch = await fetchCurrentEpoch();
    } catch {
      currentEpoch = null;
    }
  }

  onMount(() => {
    void load();
    void loadCurrentEpoch();
  });

  const runningEpochProgress = $derived.by<{ epoch: number; percent: number } | null>(() => {
    if (currentEpoch === null) return null;
    if (currentEpoch.isClosed) return null;
    if (currentEpoch.slotsElapsed === null) return null;
    if (currentEpoch.slotCount <= 0) return null;
    const percent = Math.min(100, (currentEpoch.slotsElapsed / currentEpoch.slotCount) * 100);
    return { epoch: currentEpoch.epoch, percent };
  });

  function handleSortClick(next: LeaderboardSort): void {
    sort = next;
    void load(next, window);
  }

  function handleWindowClick(next: LeaderboardWindow): void {
    window = next;
    void load(sort, next);
  }

  function isSmallSample(item: LeaderboardItem): boolean {
    return item.sampleStatus === 'low';
  }

  function skipRateText(item: LeaderboardItem): string {
    if (item.skipRate == null) return '-';
    return `${(item.skipRate * 100).toFixed(2)}%`;
  }

  function incomePerSlotText(item: LeaderboardItem): string {
    if (item.incomeSolPerSlot == null) return '-';
    return `◎${formatSolFixed(item.incomeSolPerSlot, DECIMALS_PER_SLOT)}`;
  }

  function totalIncomeText(item: LeaderboardItem): string {
    if (item.windowIncomeSol == null) return '-';
    return `◎${formatSolFixed(item.windowIncomeSol, DECIMALS_TOTAL)}`;
  }

  function mevTipsText(item: LeaderboardItem): string {
    if (item.blockTipsTotalSol == null) return '-';
    return `◎${formatSolFixed(item.blockTipsTotalSol, DECIMALS_TOTAL)}`;
  }

  function blockFeesText(item: LeaderboardItem): string {
    if (item.blockFeesTotalSol == null) return '-';
    return `◎${formatSolFixed(item.blockFeesTotalSol, DECIMALS_TOTAL)}`;
  }

  function cellText(item: LeaderboardItem, key: LeaderboardSort): string {
    switch (key) {
      case 'income_per_slot':
        return incomePerSlotText(item);
      case 'total_income':
        return totalIncomeText(item);
      case 'mev_tips':
        return mevTipsText(item);
      case 'fees':
        return blockFeesText(item);
      case 'skip_rate':
        return skipRateText(item);
      default:
        return '-';
    }
  }

  function windowSummary(leaderboard: Leaderboard): string {
    const parts: string[] = [];
    if (leaderboard.currentEpoch !== null) parts.push(`current ${leaderboard.currentEpoch}`);
    if (leaderboard.closedEpochsIncluded.length > 0) {
      parts.push(`final ${leaderboard.closedEpochsIncluded.join(' + ')}`);
    }
    return parts.length > 0 ? parts.join(' / ') : 'waiting for slot data';
  }
</script>

<section
  aria-labelledby="leaderboard-title"
  class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]"
>
  <header class="flex flex-col gap-4 border-b border-[color:var(--color-border-default)] px-5 py-4">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <h2 id="leaderboard-title" class="text-base font-semibold">
          <span class="text-[color:var(--color-brand-500)]">Top validators</span>
        </h2>
        <p class="text-xs text-[color:var(--color-text-subtle)]">
          Ranked by <span class="font-semibold">{activeCol.label.toLowerCase()}</span> across
          <span class="font-semibold">{activeWindow.label.toLowerCase()}</span>. Low-sample rows are
          dimmed.
        </p>
      </div>

      {#if data}
        <div class="flex shrink-0 flex-col items-start gap-1 text-xs lg:items-end">
          <span class="inline-flex items-center text-[color:var(--color-text-subtle)]">
            Window:
            <span class="ml-1 font-mono font-semibold text-[color:var(--color-text-default)]">
              {windowSummary(data)}
            </span>
            <Tooltip
              align="right"
              label="About leaderboard windows"
              content={activeWindow.detail}
            />
          </span>
          {#if data.safeUpperSlot !== null}
            <span class="font-mono text-[color:var(--color-text-subtle)]">
              as of slot {data.safeUpperSlot}
            </span>
          {/if}
          {#if runningEpochProgress !== null}
            <div class="flex items-center gap-2">
              <span class="text-[color:var(--color-text-subtle)]">
                epoch <span class="font-mono">{runningEpochProgress.epoch}</span>
              </span>
              <div
                class="h-1.5 w-24 overflow-hidden rounded-full bg-[color:var(--color-surface-muted)]"
                role="progressbar"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={Math.round(runningEpochProgress.percent)}
                aria-label={`Epoch ${runningEpochProgress.epoch} progress`}
              >
                <div
                  class="h-full bg-[color:var(--color-brand-500)] transition-all"
                  style:width={`${runningEpochProgress.percent.toFixed(2)}%`}
                ></div>
              </div>
              <span class="font-mono tabular-nums text-[color:var(--color-text-subtle)]">
                {runningEpochProgress.percent.toFixed(0)}%
              </span>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
      <div
        class="inline-flex w-fit flex-wrap gap-1 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-1"
      >
        {#each WINDOW_OPTIONS as option (option.key)}
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            class:bg-[color:var(--color-brand-500)]={window === option.key}
            class:text-white={window === option.key}
            class:text-[color:var(--color-text-muted)]={window !== option.key}
            class:hover:text-[color:var(--color-text-default)]={window !== option.key}
            onclick={() => handleWindowClick(option.key)}
            aria-pressed={window === option.key}
          >
            {option.label}
          </button>
        {/each}
      </div>

      <label class="flex items-center gap-2 text-sm md:hidden">
        <span class="text-[color:var(--color-text-subtle)]">Sort by</span>
        <select
          bind:value={sort}
          onchange={() => void load(sort, window)}
          class="min-h-11 rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 text-base"
          aria-label="Sort validators by"
        >
          {#each COLUMNS as col (col.key)}
            <option value={col.key}>{col.label}</option>
          {/each}
        </select>
      </label>
    </div>
  </header>

  {#if loading && data === null}
    <ul class="divide-y divide-[color:var(--color-border-default)]" aria-busy="true">
      {#each { length: 8 } as _, i (i)}
        <li class="flex items-center gap-4 px-5 py-3">
          <span class="h-4 w-6 animate-pulse rounded bg-[color:var(--color-surface-muted)]"></span>
          <span class="h-4 flex-1 animate-pulse rounded bg-[color:var(--color-surface-muted)]"
          ></span>
          <span class="h-4 w-20 animate-pulse rounded bg-[color:var(--color-surface-muted)]"></span>
        </li>
      {/each}
    </ul>
  {:else if error !== null}
    <p class="px-5 py-8 text-center text-sm text-[color:var(--color-text-muted)]">
      Couldn't load the leaderboard - {error}. Try refreshing.
    </p>
  {:else if data === null || data.items.length === 0}
    <div class="px-5 py-10 text-center text-sm text-[color:var(--color-text-muted)]">
      No leaderboard data for this window yet.
    </div>
  {:else}
    <div class="hidden overflow-x-auto md:block" aria-busy={loading} class:opacity-60={loading}>
      <table class="min-w-full divide-y divide-[color:var(--color-border-default)] text-sm">
        <thead
          class="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          <tr>
            <th scope="col" class="px-4 py-2.5 text-left">#</th>
            <th scope="col" class="px-4 py-2.5 text-left">Validator</th>
            {#each COLUMNS as col (col.key)}
              <th
                scope="col"
                aria-sort={sort === col.key ? 'descending' : 'none'}
                class="px-4 py-2.5"
                class:text-right={col.alignRight}
                class:text-left={!col.alignRight}
              >
                <span class="inline-flex items-center gap-1" class:justify-end={col.alignRight}>
                  <button
                    type="button"
                    onclick={() => handleSortClick(col.key)}
                    class="inline-flex items-center gap-1 font-semibold transition-colors"
                    class:text-[color:var(--color-brand-500)]={sort === col.key}
                    class:hover:text-[color:var(--color-text-default)]={sort !== col.key}
                  >
                    {col.label}
                    {#if sort === col.key}
                      <svg
                        aria-hidden="true"
                        class="h-3 w-3"
                        viewBox="0 0 12 12"
                        fill="currentColor"
                      >
                        <path d="M6 9.5 L2 4.5 L10 4.5 Z" />
                      </svg>
                    {/if}
                  </button>
                  <Tooltip
                    content={col.tooltip}
                    placement="bottom"
                    align={col.alignRight ? 'right' : 'left'}
                    label={`About ${col.label.toLowerCase()}`}
                  />
                </span>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody class="divide-y divide-[color:var(--color-border-default)]">
          {#each data.items as item (item.vote)}
            {@const small = isSmallSample(item)}
            <tr
              class="transition-colors hover:bg-[color:var(--color-surface-muted)]"
              style:opacity={small ? '0.5' : undefined}
              title={small ? `Limited sample: ${item.windowSlots} window slots.` : undefined}
            >
              <td class="px-4 py-2.5 text-left">
                <span class="font-mono text-xs font-semibold text-[color:var(--color-text-subtle)]">
                  {item.rank}
                </span>
              </td>
              <td class="max-w-xs px-4 py-2.5">
                <a
                  href={`/income/${item.vote}`}
                  class="group/row block hover:text-[color:var(--color-brand-500)]"
                  aria-label={item.name ? `${item.name} (${item.vote})` : item.vote}
                >
                  {#if item.name}
                    <span
                      class="flex min-w-0 items-center gap-1 text-sm font-semibold text-[color:var(--color-text-default)] group-hover/row:text-[color:var(--color-brand-500)]"
                    >
                      <span class="truncate">{item.name}</span>
                      {#if item.claimed}
                        <VerifiedBadge />
                      {/if}
                    </span>
                    <span
                      class="block truncate font-mono text-[10px] text-[color:var(--color-text-subtle)]"
                    >
                      {shortenPubkey(item.vote, 8, 6)}
                    </span>
                  {:else}
                    <span
                      class="flex min-w-0 items-center gap-1 truncate font-mono text-xs font-medium"
                    >
                      <span class="truncate">{shortenPubkey(item.vote, 8, 6)}</span>
                      {#if item.claimed}
                        <VerifiedBadge />
                      {/if}
                    </span>
                  {/if}
                </a>
                <span
                  class="mt-0.5 inline-flex items-center text-[10px] text-[color:var(--color-text-subtle)]"
                >
                  {item.windowSlots} window slots · skip {skipRateText(item)}
                </span>
              </td>
              {#each COLUMNS as col (col.key)}
                <td
                  class="px-4 py-2.5 font-mono tabular-nums"
                  class:text-right={col.alignRight}
                  class:font-semibold={sort === col.key}
                  class:text-[color:var(--color-brand-500)]={sort === col.key}
                >
                  {cellText(item, col.key)}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <ol
      class="divide-y divide-[color:var(--color-border-default)] md:hidden"
      aria-busy={loading}
      class:opacity-60={loading}
    >
      {#each data.items as item (item.vote)}
        {@const small = isSmallSample(item)}
        <li
          style:opacity={small ? '0.5' : undefined}
          title={small ? `Limited sample: ${item.windowSlots} window slots.` : undefined}
        >
          <a
            href={`/income/${item.vote}`}
            class="group block px-5 py-3 transition-colors hover:bg-[color:var(--color-surface-muted)]"
          >
            <div class="flex items-center gap-3">
              <span
                class="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-[color:var(--color-text-subtle)] group-hover:text-[color:var(--color-brand-500)]"
              >
                {item.rank}
              </span>
              <div class="min-w-0 flex-1">
                {#if item.name}
                  <div
                    class="flex min-w-0 items-center gap-1 text-sm font-semibold"
                    aria-label={`${item.name} (${item.vote})`}
                  >
                    <span class="truncate">{item.name}</span>
                    {#if item.claimed}
                      <VerifiedBadge />
                    {/if}
                  </div>
                  <div class="truncate font-mono text-[10px] text-[color:var(--color-text-subtle)]">
                    {shortenPubkey(item.vote, 8, 6)}
                  </div>
                {:else}
                  <div
                    class="flex min-w-0 items-center gap-1 truncate font-mono text-sm font-medium"
                    aria-label={item.vote}
                  >
                    <span class="truncate">{shortenPubkey(item.vote, 8, 6)}</span>
                    {#if item.claimed}
                      <VerifiedBadge />
                    {/if}
                  </div>
                {/if}
                <div
                  class="mt-0.5 inline-flex items-center text-[11px] text-[color:var(--color-text-subtle)]"
                >
                  {item.windowSlots} window slots · skip {skipRateText(item)}
                </div>
              </div>
              <div class="shrink-0 text-right">
                <div class="text-sm font-semibold tabular-nums text-[color:var(--color-brand-500)]">
                  {cellText(item, sort)}
                </div>
                <div class="text-[11px] text-[color:var(--color-text-subtle)]">
                  {activeCol.label.toLowerCase()}
                </div>
              </div>
            </div>
          </a>
        </li>
      {/each}
    </ol>

    {#if data.items.length >= limit}
      <footer
        class="border-t border-[color:var(--color-border-default)] px-5 py-3 text-xs text-[color:var(--color-text-subtle)]"
      >
        Showing top {data.items.length}. The public API returns up to 500 rows at
        <code>/v1/leaderboard?window={window}&amp;limit=500&amp;sort={sort}</code>.
      </footer>
    {/if}
  {/if}
</section>
