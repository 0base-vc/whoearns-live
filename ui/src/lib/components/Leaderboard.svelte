<!--
  Homepage cluster leaderboard — sortable table.

  Design philosophy:
    - Single table surface on desktop; columns double as sort handles.
      Clicking a header re-fetches with that column's sort mode and
      renders an ↓/↑ arrow on the active column. Standard web pattern
      — zero learning curve.
    - Default sort is `performance` (income per assigned slot), NOT
      `total_income`. Performance is the stake-neutral + commission-
      neutral skill metric — it answers "who actually runs their
      validator well" rather than "who has the most stake". See
      `src/storage/repositories/stats.repo.ts` LeaderboardSort docs
      for the full derivation.
    - Rows with small sample size (< `SMALL_SAMPLE_THRESHOLD` assigned
      slots — currently 4) are rendered at reduced opacity with a
      `limited sample` tooltip. Below that bar a validator effectively
      wasn't scheduled for the epoch, so their per-slot numbers are
      pure noise. Transparency > false precision — we mark rather than
      hide.
    - Header carries a two-line epoch indicator on the right:
      `Ranked: closed epoch N` (the data below) + `Running N+1 [bar] X%`
      (the epoch currently in-flight). Tells visitors at a glance the
      table shows settled numbers, not live ticks.
    - Mobile (< md): table collapses into stacked cards. Same data,
      vertical layout; sort switcher becomes a dropdown.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchCurrentEpoch, fetchLeaderboard } from '$lib/api';
  import { formatSolFixed, shortenPubkey } from '$lib/format';
  import type { CurrentEpoch, Leaderboard, LeaderboardItem, LeaderboardSort } from '$lib/types';
  import Tooltip from './Tooltip.svelte';
  import VerifiedBadge from './VerifiedBadge.svelte';

  interface Props {
    /** How many rows to show. Server caps at 500. */
    limit?: number;
  }
  let { limit = 25 }: Props = $props();

  /**
   * Sample-size threshold below which we dim the row + attach a
   * "limited sample" tooltip. 4 is a minimal floor — below it a
   * validator effectively wasn't scheduled for the epoch, so their
   * per-slot numbers are noise. Keeping the bar low means most watched
   * validators render at full opacity while still filtering the truly
   * no-sample rows.
   */
  const SMALL_SAMPLE_THRESHOLD = 4;

  let data = $state<Leaderboard | null>(null);
  /**
   * Running-epoch snapshot from `/v1/epoch/current`. Drives the
   * progress bar in the header so visitors see at a glance that the
   * leaderboard below shows the PREVIOUS (closed) epoch, while epoch
   * N+1 is mid-flight. Loaded in parallel with the leaderboard on
   * mount — one-shot fetch, no polling (slotsElapsed changes at
   * ~2.5 slots/sec so a single paint is fine for a dashboard page).
   */
  let currentEpoch = $state<CurrentEpoch | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /**
   * Default `performance`. See the block comment at the top of this
   * file for the rationale.
   */
  let sort = $state<LeaderboardSort>('performance');

  /**
   * Column metadata lives in one place. Each entry drives:
   *   - the header label + sort arrow
   *   - the cell renderer (via `key` → `primaryCell(item, key)`)
   *   - the mobile-card layout (same keys, different container)
   *   - the sort-by-click handler
   *
   * `alignRight` controls text alignment; numeric columns align
   * right so decimal points line up visually in tabular-nums.
   */
  const COLUMNS: Array<{
    key: LeaderboardSort;
    label: string;
    tooltip: string;
    alignRight: boolean;
  }> = [
    {
      key: 'performance',
      label: 'Performance',
      tooltip:
        'Income earned per scheduled block. Stake-neutral so a 100k-SOL validator and a 10M-SOL one can be compared on equal footing — it tells you who actually runs their node well.',
      alignRight: true,
    },
    {
      key: 'total_income',
      label: 'Total income',
      tooltip:
        'Block fees + on-chain Jito tips earned this epoch. Bigger validators rank higher here simply because they get scheduled for more blocks.',
      alignRight: true,
    },
    {
      key: 'skip_rate',
      label: 'Skip rate',
      tooltip:
        'Percentage of scheduled blocks the validator failed to produce. Lower is better — anything consistently above ~5% usually means an unhealthy node.',
      alignRight: true,
    },
    {
      key: 'median_fee',
      label: 'Median fee',
      tooltip:
        'Typical fee earned per block (median, not mean — so one fat block does not skew it). Higher means the validator captured priority fees from busy blocks.',
      alignRight: true,
    },
    {
      key: 'income_per_stake',
      label: 'APR',
      tooltip:
        'Annualised operator yield = (block fees + on-chain Jito tips) ÷ activated stake × ~182 epochs/year. This is the OPERATOR side — delegators receive this minus the validator commission.',
      alignRight: true,
    },
  ];

  const activeCol = $derived(COLUMNS.find((c) => c.key === sort) ?? COLUMNS[0]!);

  async function load(mode: LeaderboardSort) {
    loading = true;
    error = null;
    try {
      data = await fetchLeaderboard({ limit, sort: mode });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  /**
   * Current-epoch fetch is best-effort — failures don't block or
   * taint the leaderboard (the table is the PRIMARY content, the
   * progress bar is decorative context). We swallow errors silently
   * and the bar just doesn't render.
   */
  async function loadCurrentEpoch(): Promise<void> {
    try {
      currentEpoch = await fetchCurrentEpoch();
    } catch {
      // Leave `currentEpoch` null; header degrades gracefully.
    }
  }

  onMount(() => {
    void load(sort);
    void loadCurrentEpoch();
  });

  /**
   * Progress percentage of the running epoch — 0-100. Null when the
   * epoch watcher hasn't ticked yet (`slotsElapsed === null`) or when
   * `/v1/epoch/current` already returned a closed record (boundary
   * transition). Both null and the closed-case hide the progress bar.
   */
  const runningEpochProgress = $derived.by<{ epoch: number; percent: number } | null>(() => {
    if (currentEpoch === null) return null;
    if (currentEpoch.isClosed) return null;
    if (currentEpoch.slotsElapsed === null) return null;
    if (currentEpoch.slotCount <= 0) return null;
    const percent = Math.min(100, (currentEpoch.slotsElapsed / currentEpoch.slotCount) * 100);
    return { epoch: currentEpoch.epoch, percent };
  });

  function handleSortClick(mode: LeaderboardSort): void {
    if (sort !== mode) {
      sort = mode;
      void load(mode);
    }
  }

  function isSmallSample(item: LeaderboardItem): boolean {
    return item.slotsAssigned < SMALL_SAMPLE_THRESHOLD;
  }

  /**
   * Render helpers use `== null` (loose equality) to catch BOTH `null`
   * and `undefined`. The two cases can occur:
   *   - `null`: server has the field but no value for this row (e.g.
   *     pre-migration-0006 rows have `activatedStakeLamports = null`).
   *   - `undefined`: older server builds that don't ship the new field
   *     at all — happens during rolling deploys where the UI bundle
   *     outpaces the backend. Treating both as "no data" (`—`) keeps
   *     the UI resilient during the cross-over window.
   */
  function skipRateText(item: LeaderboardItem): string {
    if (item.skipRate == null) return '—';
    return `${(item.skipRate * 100).toFixed(2)}%`;
  }

  /**
   * Nominal Solana epoch = 432,000 slots × 400ms = 172,800s = 2 days.
   * Real epochs drift longer with skip rate (~2.5 days typical) but
   * annualizing against the PROTOCOL nominal keeps the APR stable
   * across clusters where skip rate differs — and it's the convention
   * most Solana dashboards use. Exact real-world annualization would
   * require computing from epoch-close-time deltas on the server side;
   * the ~20% noise floor that introduces isn't worth the complexity.
   */
  const EPOCHS_PER_YEAR = 365 / 2;

  function aprText(item: LeaderboardItem): string {
    if (item.incomePerStake == null) return '—';
    // Annualize: the API returns `income/stake` for ONE epoch; the
    // "APR" label demands yearly. Column-level tooltip spells this
    // out for readers who squint at small numbers (operator-side
    // yield is typically 0.5-2%, not the 6-8% delegator staking APR).
    const annualizedFraction = item.incomePerStake * EPOCHS_PER_YEAR;
    return `${(annualizedFraction * 100).toFixed(3)}%`;
  }

  // Per-column decimal counts. These were picked so trailing-zero
  // padding lines the decimal points up across rows without losing
  // meaningful digits on the smallest values:
  //   - per-block / per-slot metrics (perf, median fee): 6 dp
  //   - per-epoch totals (total income): 3 dp
  // If a new sort column gets added, extend `DECIMALS_BY_KEY` below
  // rather than reintroducing `formatSol` — fixed precision is the
  // whole point here.
  const DECIMALS_PER_SLOT_COLS = 6;
  const DECIMALS_EPOCH_TOTAL = 3;

  function perfText(item: LeaderboardItem): string {
    if (item.performanceSolPerSlot == null) return '—';
    return `◎${formatSolFixed(item.performanceSolPerSlot, DECIMALS_PER_SLOT_COLS)}`;
  }

  function medianFeeText(item: LeaderboardItem): string {
    if (item.medianFeeSol == null) return '—';
    return `◎${formatSolFixed(item.medianFeeSol, DECIMALS_PER_SLOT_COLS)}`;
  }

  function totalIncomeText(item: LeaderboardItem): string {
    if (item.totalIncomeSol == null) return '—';
    return `◎${formatSolFixed(item.totalIncomeSol, DECIMALS_EPOCH_TOTAL)}`;
  }

  /** Dispatch a column-key → rendered cell text. Used by BOTH the
   *  desktop table body and the mobile card stats. */
  function cellText(item: LeaderboardItem, key: LeaderboardSort): string {
    switch (key) {
      case 'performance':
        return perfText(item);
      case 'total_income':
        return totalIncomeText(item);
      case 'skip_rate':
        return skipRateText(item);
      case 'median_fee':
        return medianFeeText(item);
      case 'income_per_stake':
        return aprText(item);
      default:
        return '—';
    }
  }
</script>

<section
  aria-labelledby="leaderboard-title"
  class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]"
>
  <!-- Header: title + epoch pill + (mobile-only) sort dropdown. -->
  <header class="flex flex-col gap-3 border-b border-[color:var(--color-border-default)] px-5 py-4">
    <!--
      Header layout. On mobile (`< sm`) the title/subtitle and the
      epoch pill stack vertically — squeezing the 216 px-wide pill
      next to a min-width column on a 375 px viewport collapsed the
      title into a 57 px-wide single-letter-per-line column. Above
      `sm`, the original side-by-side layout returns since there's
      enough horizontal room. The pill's `items-end` flips to
      `items-start` on mobile so the closed/running labels left-align
      with the rest of the card content instead of right-aligning
      to a phantom edge.
    -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between">
      <div class="min-w-0">
        <!--
          Heading carries ONLY the primary label now — the epoch pill
          on the right spells out which epoch is being ranked vs. which
          is running, so duplicating "— last closed epoch" here would
          be noise.
        -->
        <h2 id="leaderboard-title" class="text-base font-semibold">
          <span class="text-[color:var(--color-brand-500)]">Top validators</span>
        </h2>
        <p class="text-xs text-[color:var(--color-text-subtle)]">
          Ranked by <span class="font-semibold">{activeCol.label.toLowerCase()}</span> — click a
          column header to re-sort. Rows with &lt; {SMALL_SAMPLE_THRESHOLD} assigned slots are dimmed
          (limited sample).
        </p>
      </div>
      <!--
        Header pill — two-line epoch indicator.
          Line 1: which CLOSED epoch is being ranked (the leaderboard data)
          Line 2: which epoch is currently RUNNING + progress bar
        The two together tell visitors at a glance that the ranking is
        "done/final" while the next epoch is mid-flight — no "is this
        live?" confusion. If the current-epoch fetch failed we just
        fall back to the single closed-epoch label.
      -->
      {#if data && data.epoch > 0}
        <div class="flex shrink-0 flex-col items-start gap-1 text-xs sm:items-end">
          <span class="inline-flex items-center text-[color:var(--color-text-subtle)]">
            Ranked: closed epoch
            <span class="ml-1 font-mono font-semibold text-[color:var(--color-text-default)]"
              >{data.epoch}</span
            >
            <Tooltip
              align="right"
              label="About epochs"
              content="Solana groups blocks into 'epochs' that last about 2 days. The leaderboard ranks the most recently CLOSED epoch — those numbers are final. The next epoch is already running below."
            />
          </span>
          {#if runningEpochProgress !== null}
            <div class="flex items-center gap-2">
              <span class="inline-flex items-center text-[color:var(--color-text-subtle)]">
                Running <span class="ml-1 font-mono">{runningEpochProgress.epoch}</span>
                <Tooltip
                  align="right"
                  placement="top"
                  label="About the running epoch"
                  content="The epoch currently in flight. The leaderboard does NOT include it yet — its numbers are still growing as validators produce blocks."
                />
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
              <span
                class="font-mono tabular-nums text-[color:var(--color-text-subtle)]"
                aria-hidden="true"
              >
                {runningEpochProgress.percent.toFixed(0)}%
              </span>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!--
      Mobile-only sort switcher. On md+, column headers handle
      sorting directly. The `md:hidden` keeps the dropdown from
      duplicating the headers on desktop.

      Tap target + iOS auto-zoom: select elements need both ≥ 44px
      tall (WCAG) AND ≥ 16px font-size on mobile (Safari zooms in
      whenever a user focuses an input with smaller text, breaking
      sticky-header layouts and forcing a manual zoom-out). `text-base`
      below `md` gets us 16px; `min-h-11 px-3 py-2` rebuilds the
      hit-area without changing the visible chevron position.
    -->
    <label class="flex items-center gap-2 text-sm md:hidden">
      <span class="text-[color:var(--color-text-subtle)]">Sort by</span>
      <select
        bind:value={sort}
        onchange={() => void load(sort)}
        class="min-h-11 rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 text-base"
        aria-label="Sort validators by"
      >
        {#each COLUMNS as col (col.key)}
          <option value={col.key}>{col.label}</option>
        {/each}
      </select>
    </label>
  </header>

  {#if loading && data === null}
    <!-- Cold-boot skeleton. Runs only on first load; subsequent
         sort-switches keep stale rows visible and just aria-busy. -->
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
      Couldn't load the leaderboard — {error}. Try refreshing.
    </p>
  {:else if data === null || data.items.length === 0}
    <div class="px-5 py-10 text-center text-sm text-[color:var(--color-text-muted)]">
      {#if sort === 'income_per_stake'}
        <p>
          No APR data yet for this epoch. Per-stake ranking uses activated-stake snapshots that
          begin collecting from the stake-snapshot migration forward — check back after a few more
          closed epochs.
        </p>
        <button
          type="button"
          class="mt-3 text-xs font-medium text-[color:var(--color-brand-500)] underline"
          onclick={() => handleSortClick('performance')}
        >
          Switch to Performance →
        </button>
      {:else}
        <p>
          No closed-epoch data yet. The indexer publishes a leaderboard once the first watched epoch
          settles.
        </p>
      {/if}
    </div>
  {:else}
    <!--
      ─────────────────────────────────────────────────────
      Desktop: full sortable table. `hidden md:block` hides
      this on mobile, which falls back to the card list below.
      ─────────────────────────────────────────────────────
    -->
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
                <!--
                  Header is two visually adjacent controls:
                    1) the sort button (clicking the label re-sorts)
                    2) the Tooltip trigger (clicking `(i)` shows help)
                  Splitting them keeps each interaction explicit — a
                  single combined button would force users to remember
                  "click here for sort, hover here for help" which
                  breaks down on touch.
                -->
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
                    {:else}
                      <svg
                        aria-hidden="true"
                        class="h-3 w-3 opacity-40"
                        viewBox="0 0 12 12"
                        fill="currentColor"
                      >
                        <path d="M6 2.5 L3 5.5 L9 5.5 Z" />
                        <path d="M6 9.5 L3 6.5 L9 6.5 Z" />
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
            <!--
              Dim via inline style rather than `class:opacity-50={small}`.
              Tailwind v4's scanner occasionally misses classes only
              referenced through Svelte's class directive (observed on
              the live preview — dimming silently did nothing). Inline
              style sidesteps the scanner entirely and is bulletproof.
            -->
            <tr
              class="transition-colors hover:bg-[color:var(--color-surface-muted)]"
              style:opacity={small ? '0.5' : undefined}
              title={small
                ? `Only ${item.slotsAssigned} blocks were scheduled for this validator this epoch — too few for the per-block metrics to be meaningful.`
                : undefined}
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
                  <!--
                    Moniker line — on-chain validator-info `name`. When
                    absent we hide the line entirely so the pubkey
                    slides up into its place. Truncated so a validator
                    that registered a novel for their name doesn't
                    blow out the column width.
                  -->
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
                  {item.slotsProduced}/{item.slotsAssigned} produced
                  <Tooltip
                    label="About produced/assigned blocks"
                    content="Solana schedules ~4 leader slots per validator per rotation. 'Assigned' is how many were scheduled this epoch; 'produced' is how many actually got blocks (the rest were skipped)."
                  />
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

    <!--
      ─────────────────────────────────────────────────────
      Mobile: stacked cards. `md:hidden` keeps this hidden
      once the viewport can fit the table. Sort switcher
      lives in the header dropdown above.
      ─────────────────────────────────────────────────────
    -->
    <ol
      class="divide-y divide-[color:var(--color-border-default)] md:hidden"
      aria-busy={loading}
      class:opacity-60={loading}
    >
      {#each data.items as item (item.vote)}
        {@const small = isSmallSample(item)}
        <li
          style:opacity={small ? '0.5' : undefined}
          title={small
            ? `Limited sample: only ${item.slotsAssigned} assigned slots this epoch.`
            : undefined}
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
                <!--
                  No Tooltip in mobile cards: the wrapping `<a>` makes
                  any nested `<button>` invalid HTML (interactive
                  nested inside interactive) and clicks bubble to the
                  anchor anyway — the tooltip would never open. Desk-
                  top users get the explanation via the column header
                  Tooltip; mobile users get the inline numeric label
                  below, which is self-explanatory enough that the
                  trade-off is acceptable.
                -->
                <div
                  class="mt-0.5 inline-flex items-center text-[11px] text-[color:var(--color-text-subtle)]"
                >
                  {item.slotsProduced}/{item.slotsAssigned} produced · skip {skipRateText(item)}
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
        Showing top {data.items.length} of cluster. Want more? The public API returns up to 500 rows at
        <code>/v1/leaderboard?limit=500&amp;sort={sort}</code>.
      </footer>
    {/if}
  {/if}
</section>
