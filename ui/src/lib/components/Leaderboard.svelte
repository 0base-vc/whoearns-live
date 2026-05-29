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
    LeaderboardBracket,
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
      key: 'decade_epoch',
      label: 'Decade',
      detail: 'Latest complete 10-epoch block',
    },
    {
      key: 'final_epoch',
      label: 'Final epoch',
      detail: 'Latest closed epoch only',
    },
  ];

  // Bracket filter (I). The four non-client brackets render as a
  // segmented control; "By client" is a fifth segment that reveals a
  // sub-dropdown of the 14 canonical client kinds. `key` is the value
  // sent on `?bracket=` (the client segment carries no key — it just
  // toggles the dropdown). Default `all` keeps first-load behavior
  // byte-identical to the pre-bracket leaderboard.
  const BRACKET_OPTIONS: Array<{ key: LeaderboardBracket; label: string; detail: string }> = [
    { key: 'all', label: 'All', detail: 'Every indexed validator, unfiltered.' },
    {
      key: 'stake_lt_100k',
      label: 'Small (<100k)',
      detail: 'Validators with under 100,000 SOL activated stake.',
    },
    {
      key: 'stake_lt_500k',
      label: 'Small (<500k)',
      detail: 'Validators with under 500,000 SOL activated stake.',
    },
    {
      key: 'newcomer',
      label: 'Newcomers',
      detail: 'Validators new to the indexed set.',
    },
  ];

  // The 14 canonical client kinds the backend accepts as
  // `?bracket=client:<kind>`. Sentence-case labels for the dropdown;
  // the lowercased enum rides on the wire. Mirrors the `ClientKind`
  // union in `$lib/types` (minus `unknown` / `solana_labs`, which
  // aren't bracketable cohorts).
  const CLIENT_BRACKET_KINDS: Array<{ kind: string; label: string }> = [
    { kind: 'agave', label: 'Agave' },
    { kind: 'jito_solana', label: 'Jito-Solana' },
    { kind: 'firedancer', label: 'Firedancer' },
    { kind: 'frankendancer', label: 'Frankendancer' },
    { kind: 'paladin', label: 'Paladin' },
    { kind: 'sig', label: 'Sig' },
    { kind: 'agave_bam', label: 'Agave (BAM)' },
    { kind: 'rakurai', label: 'Rakurai' },
    { kind: 'harmonic_firedancer', label: 'Harmonic Firedancer' },
    { kind: 'harmonic_agave', label: 'Harmonic Agave' },
    { kind: 'harmonic_frankendancer', label: 'Harmonic Frankendancer' },
    { kind: 'firebam', label: 'FireBAM' },
    { kind: 'raiku', label: 'Raiku' },
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
      key: 'compute_units',
      label: 'CU',
      tooltip:
        'Average compute units consumed per produced block across the selected window — a block-density signal distinct from income.',
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
  // Bracket filter (I). `all` on first load so behavior is unchanged.
  let bracket = $state<LeaderboardBracket>('all');
  // Selected client kind for the `client:<kind>` bracket. Held
  // separately from `bracket` so the dropdown remembers the last pick
  // when the user toggles the "By client" segment off and back on.
  let clientKind = $state<string>(CLIENT_BRACKET_KINDS[0]!.kind);
  // Whether the "By client" segment is active (drives the sub-dropdown
  // + means the effective bracket is `client:<clientKind>`).
  let clientBracketActive = $state(false);

  const activeCol = $derived(COLUMNS.find((c) => c.key === sort) ?? COLUMNS[0]!);
  const activeWindow = $derived(
    WINDOW_OPTIONS.find((option) => option.key === window) ?? WINDOW_OPTIONS[0]!,
  );

  // The bracket value actually sent to the API — the segmented
  // `bracket` state, OR `client:<kind>` when the client segment is on.
  const effectiveBracket = $derived<LeaderboardBracket>(
    clientBracketActive ? (`client:${clientKind}` as LeaderboardBracket) : bracket,
  );

  // Validators in the selected bracket, independent of `limit`. Falls
  // back to `count` (rows returned) for pre-bracket API responses that
  // don't carry `bracketCount`.
  const bracketCount = $derived<number | null>(
    data === null ? null : (data.bracketCount ?? data.count),
  );

  // Whether the current view is filtered to a non-`all` bracket — gates
  // the "{n} validators in this bracket" line so the default view
  // (every validator) doesn't show a redundant count.
  const isFiltered = $derived(effectiveBracket !== 'all');

  async function load(
    nextSort: LeaderboardSort = sort,
    nextWindow: LeaderboardWindow = window,
    nextBracket: LeaderboardBracket = effectiveBracket,
  ) {
    loading = true;
    error = null;
    try {
      data = await fetchLeaderboard({
        limit,
        sort: nextSort,
        window: nextWindow,
        bracket: nextBracket,
      });
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

  // Select one of the four non-client bracket segments. Turns off the
  // client segment so the two selectors are mutually exclusive.
  function handleBracketClick(next: LeaderboardBracket): void {
    clientBracketActive = false;
    bracket = next;
    void load(sort, window, next);
  }

  // Toggle the "By client" segment. Switching it ON loads the remembered
  // `client:<clientKind>`; switching it OFF returns to the last
  // non-client `bracket` (defaults to `all`).
  function handleClientSegmentClick(): void {
    clientBracketActive = true;
    void load(sort, window, `client:${clientKind}` as LeaderboardBracket);
  }

  // The client dropdown changed — refetch with the new kind. Only
  // meaningful while the client segment is active (the dropdown is
  // hidden otherwise), but guard anyway so a stray change is a no-op
  // on the wire when the segment is off.
  function handleClientKindChange(): void {
    if (!clientBracketActive) return;
    void load(sort, window, `client:${clientKind}` as LeaderboardBracket);
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

  /**
   * Human-readable compute units for the active window. CU values are
   * stringified integers in the tens of millions, so the default
   * rendering is a one-decimal "M" suffix (e.g. `31.2M`); smaller
   * magnitudes fall back to a "K" suffix or a thousands-separated
   * integer. Returns "—" when the row has no CU data for the window
   * (matches the table's existing null placeholder).
   */
  function windowedCuText(item: LeaderboardItem): string {
    if (item.windowedCu == null) return '—';
    const n = Number(item.windowedCu);
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) {
      return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n / 1_000_000)}M`;
    }
    if (Math.abs(n) >= 1_000) {
      return `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(n / 1_000)}K`;
    }
    return new Intl.NumberFormat('en').format(n);
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
      case 'compute_units':
        return windowedCuText(item);
      case 'skip_rate':
        return skipRateText(item);
      default:
        return '-';
    }
  }

  function hasDecadeRank(item: LeaderboardItem): boolean {
    return (
      typeof item.decadeEpochStart === 'number' &&
      typeof item.decadeEpochEnd === 'number' &&
      (item.decadeRank === 1 || item.decadeRank === 2 || item.decadeRank === 3)
    );
  }

  function decadeRankText(item: LeaderboardItem): string {
    return hasDecadeRank(item) ? `#${item.decadeRank}` : '';
  }

  function decadeRankLabel(item: LeaderboardItem): string {
    if (!hasDecadeRank(item)) return '';
    return `Decade ranker · Epochs ${item.decadeEpochStart}-${item.decadeEpochEnd} #${item.decadeRank} by income / slot`;
  }

  function decadeRankClass(item: LeaderboardItem): string {
    return hasDecadeRank(item) ? `rank-${item.decadeRank}` : '';
  }

  function windowSummary(leaderboard: Leaderboard): string {
    if (leaderboard.window === 'decade_epoch' && leaderboard.closedEpochsIncluded.length > 0) {
      const epochs = leaderboard.closedEpochsIncluded;
      const min = Math.min(...epochs);
      const max = Math.max(...epochs);
      return `epochs ${min}-${max}`;
    }
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
          <span class="font-semibold">{activeWindow.label.toLowerCase()}</span>.
        </p>
        <!--
          Bracket population (I). Renders only for a non-`all` bracket
          so the unfiltered default doesn't show a redundant "N
          validators" line. `bracketCount` is the size of the WHOLE
          bracket (not the `limit`-capped rows shown), so a delegator
          knows whether they're seeing the top slice of 12 or of 1,200.
          `aria-live` announces the new count when the bracket changes.
        -->
        {#if isFiltered && bracketCount !== null}
          <p class="mt-0.5 text-xs text-[color:var(--color-text-subtle)]" aria-live="polite">
            <span class="font-semibold tabular-nums text-[color:var(--color-text-default)]">
              {bracketCount.toLocaleString()}
            </span>
            {bracketCount === 1 ? 'validator' : 'validators'} in this bracket.
          </p>
        {/if}
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

    <!--
      Bracket selector (I). A segmented control over the four
      non-client brackets plus a "By client" toggle that reveals the
      client-kind dropdown. `flex-wrap` collapses the segments onto
      multiple lines on a narrow viewport rather than overflowing —
      the mobile card layout below already handles the rows, so the
      selector just needs to stay readable. `role="group"` names the
      cluster for AT.
    -->
    <div
      class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
      role="group"
      aria-label="Filter validators by bracket"
    >
      <span class="text-xs text-[color:var(--color-text-subtle)]">Bracket</span>
      <div
        class="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-1"
      >
        {#each BRACKET_OPTIONS as option (option.key)}
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            class:bg-[color:var(--color-brand-500)]={!clientBracketActive && bracket === option.key}
            class:text-white={!clientBracketActive && bracket === option.key}
            class:text-[color:var(--color-text-muted)]={clientBracketActive ||
              bracket !== option.key}
            class:hover:text-[color:var(--color-text-default)]={clientBracketActive ||
              bracket !== option.key}
            onclick={() => handleBracketClick(option.key)}
            aria-pressed={!clientBracketActive && bracket === option.key}
            title={option.detail}
          >
            {option.label}
          </button>
        {/each}
        <!--
          "By client" segment — turns the bracket into a
          `client:<kind>` filter and reveals the dropdown to its right.
          Pressed-state styling mirrors the four segments above so the
          control reads as one mutually-exclusive group.
        -->
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          class:bg-[color:var(--color-brand-500)]={clientBracketActive}
          class:text-white={clientBracketActive}
          class:text-[color:var(--color-text-muted)]={!clientBracketActive}
          class:hover:text-[color:var(--color-text-default)]={!clientBracketActive}
          onclick={handleClientSegmentClick}
          aria-pressed={clientBracketActive}
          title="Filter to a single Solana client kind."
        >
          By client
        </button>
      </div>

      <!--
        Client-kind dropdown — only shown when the "By client" segment
        is active. `min-h-11` keeps the WCAG 2.5.5 touch target on
        mobile; the base font-size avoids iOS zoom-on-focus.
      -->
      {#if clientBracketActive}
        <label class="flex items-center gap-2 text-xs">
          <span class="sr-only">Client kind</span>
          <select
            bind:value={clientKind}
            onchange={handleClientKindChange}
            class="min-h-11 rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-1.5 text-sm"
            aria-label="Filter by client kind"
          >
            {#each CLIENT_BRACKET_KINDS as ck (ck.kind)}
              <option value={ck.kind}>{ck.label}</option>
            {/each}
          </select>
        </label>
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
            <tr class="transition-colors hover:bg-[color:var(--color-surface-muted)]">
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
                      {#if hasDecadeRank(item)}
                        <span
                          class={`decade-rank-badge ${decadeRankClass(item)}`}
                          aria-label={decadeRankLabel(item)}
                          title={decadeRankLabel(item)}
                        >
                          {decadeRankText(item)}
                        </span>
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
                      {#if hasDecadeRank(item)}
                        <span
                          class={`decade-rank-badge ${decadeRankClass(item)}`}
                          aria-label={decadeRankLabel(item)}
                          title={decadeRankLabel(item)}
                        >
                          {decadeRankText(item)}
                        </span>
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
        <li>
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
                    {#if hasDecadeRank(item)}
                      <span
                        class={`decade-rank-badge ${decadeRankClass(item)}`}
                        aria-label={decadeRankLabel(item)}
                        title={decadeRankLabel(item)}
                      >
                        {decadeRankText(item)}
                      </span>
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
                    {#if hasDecadeRank(item)}
                      <span
                        class={`decade-rank-badge ${decadeRankClass(item)}`}
                        aria-label={decadeRankLabel(item)}
                        title={decadeRankLabel(item)}
                      >
                        {decadeRankText(item)}
                      </span>
                    {/if}
                  </div>
                {/if}
                <div
                  class="mt-0.5 inline-flex items-center text-[11px] text-[color:var(--color-text-subtle)]"
                >
                  {item.windowSlots} window slots · skip {skipRateText(item)} · CU {windowedCuText(
                    item,
                  )}
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
        <code
          >/v1/leaderboard?window={window}&amp;limit=500&amp;sort={sort}{isFiltered
            ? `&bracket=${effectiveBracket}`
            : ''}</code
        >.
      </footer>
    {/if}
  {/if}
</section>

<style>
  .decade-rank-badge {
    display: inline-flex;
    height: 1rem;
    flex-shrink: 0;
    align-items: center;
    border-radius: 9999px;
    border: 1px solid;
    padding: 0 0.3rem;
    font-size: 0.625rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0;
  }

  .decade-rank-badge.rank-1 {
    border-color: color-mix(in oklab, #f59e0b 55%, transparent);
    background: color-mix(in oklab, #f59e0b 20%, transparent);
    color: #d97706;
  }

  .decade-rank-badge.rank-2 {
    border-color: color-mix(in oklab, #94a3b8 58%, transparent);
    background: color-mix(in oklab, #94a3b8 22%, transparent);
    color: #64748b;
  }

  .decade-rank-badge.rank-3 {
    border-color: color-mix(in oklab, #c2410c 50%, transparent);
    background: color-mix(in oklab, #c2410c 18%, transparent);
    color: #c2410c;
  }

  :global(.dark) .decade-rank-badge.rank-1 {
    color: #fbbf24;
  }

  :global(.dark) .decade-rank-badge.rank-2 {
    color: #cbd5e1;
  }

  :global(.dark) .decade-rank-badge.rank-3 {
    color: #fb923c;
  }
</style>
