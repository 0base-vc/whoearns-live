<!--
  /compare — side-by-side validator comparison.

  Two-column layout:
    left  = validator A (`?a=<vote-or-identity>`)
    right = validator B (`?b=<vote-or-identity>`)

  Both inputs are URL params so the page is shareable. When one or
  both inputs are missing, the page falls through to a search form
  that POSTs back to itself with the params populated.

  Per-metric grid below the heroes shows comparable metrics from the
  selected leaderboard window. Stake-neutral metrics (income per slot
  and skip rate) are the fairest direct comparison; total-income
  comparisons are biased by stake size, which we annotate.

  The compare surface is English-first because its labels are compact
  domain terms and are meant to match the leaderboard/income pages.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import AddressDisplay from '$lib/components/AddressDisplay.svelte';
  import Card from '$lib/components/Card.svelte';
  import ValidatorSearchCombobox from '$lib/components/ValidatorSearchCombobox.svelte';
  import VerifiedBadge from '$lib/components/VerifiedBadge.svelte';
  import Tooltip from '$lib/components/Tooltip.svelte';
  import { formatSol, shortenPubkey } from '$lib/format';
  import { SITE_NAME, SITE_URL } from '$lib/site';
  import type { CompareData, CompareSlot } from './+page';
  import type { LeaderboardWindow, ValidatorEpochRecord, ValidatorHistory } from '$lib/types';

  let { data }: { data: CompareData } = $props();

  // Form state for the input box. Starts populated with whatever
  // was in the URL so a half-filled compare URL doesn't reset to
  // empty when the user refines one side. svelte-ignore the
  // initial-value capture warning — that's exactly what we want
  // here (the input field becomes the source of truth from then
  // onward, and re-navigating reloads `data` via SvelteKit's
  // invalidate).
  // svelte-ignore state_referenced_locally
  let inputA = $state(data.a?.input ?? '');
  // svelte-ignore state_referenced_locally
  let inputB = $state(data.b?.input ?? '');
  let formError = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  let windowMode = $state<LeaderboardWindow>(data.window);

  const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const WINDOW_OPTIONS: Array<{ key: LeaderboardWindow; label: string }> = [
    { key: 'live_trend', label: 'Live trend' },
    { key: 'current_only', label: 'Current only' },
    { key: 'stable_trend', label: 'Stable trend' },
    { key: 'final_epoch', label: 'Final epoch' },
  ];

  $effect(() => {
    windowMode = data.window;
  });

  function navigateCompare(a: string, b: string, nextWindow: LeaderboardWindow): void {
    const params = new URLSearchParams();
    if (a.length > 0) params.set('a', a);
    if (b.length > 0) params.set('b', b);
    params.set('window', nextWindow);
    void goto(`/compare?${params.toString()}`, { invalidateAll: true, keepFocus: true });
  }

  function resolvedInputOrCurrentVote(input: string, slot: CompareSlot | null | undefined): string {
    const trimmed = input.trim();
    if (PUBKEY_RE.test(trimmed)) return trimmed;
    return slot?.history?.vote ?? '';
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const a = inputA.trim();
    const b = inputB.trim();
    if (a.length === 0 && b.length === 0) return;
    if ((a.length > 0 && !PUBKEY_RE.test(a)) || (b.length > 0 && !PUBKEY_RE.test(b))) {
      formError = 'Select a validator from results or paste a vote / identity pubkey.';
      return;
    }
    formError = null;
    navigateCompare(a, b, windowMode);
  }

  function updateWindow(next: LeaderboardWindow): void {
    windowMode = next;
    const params = new URLSearchParams();
    const a = resolvedInputOrCurrentVote(inputA, slotA);
    const b = resolvedInputOrCurrentVote(inputB, slotB);
    if (a.length > 0) params.set('a', a);
    if (b.length > 0) params.set('b', b);
    params.set('window', next);
    void goto(`/compare?${params.toString()}`, { invalidateAll: true, keepFocus: true });
  }

  function selectValidator(side: 'a' | 'b', vote: string): void {
    if (side === 'a') inputA = vote;
    else inputB = vote;
    formError = null;
    const a = side === 'a' ? vote : inputA.trim();
    const b = side === 'b' ? vote : inputB.trim();
    navigateCompare(PUBKEY_RE.test(a) ? a : '', PUBKEY_RE.test(b) ? b : '', windowMode);
  }

  function lifetimeTotalSol(history: ValidatorHistory | null): number | null {
    if (history === null || history.items.length === 0) return null;
    let total = 0;
    for (const r of history.items) {
      const fees = r.blockFeesTotalSol === null ? 0 : Number(r.blockFeesTotalSol);
      const mev = r.blockTipsTotalSol === null ? 0 : Number(r.blockTipsTotalSol);
      total += (Number.isFinite(fees) ? fees : 0) + (Number.isFinite(mev) ? mev : 0);
    }
    return total;
  }

  // NOTE: Operator APR isn't shown here because activated stake isn't
  // on the per-epoch `ValidatorEpochRecord` shape — it's only on the
  // leaderboard projection. Adding it would mean an extra fetch per
  // validator (the leaderboard row) which doubles the page load for
  // marginal benefit. Use the income page for APR; this page focuses
  // on per-epoch comparable metrics.

  type WindowStats = {
    label: string;
    slots: number;
    totalSol: number | null;
    skipRatePct: number | null;
  };

  function pickedRows(history: ValidatorHistory | null): ValidatorEpochRecord[] {
    if (history === null) return [];
    const current = history.items.find((r) => r.isCurrentEpoch);
    const closed = history.items.filter((r) => r.isFinal);
    if (windowMode === 'current_only') return current ? [current] : [];
    if (windowMode === 'stable_trend')
      return [...(current ? [current] : []), ...closed.slice(0, 2)];
    if (windowMode === 'final_epoch') return closed.slice(0, 1);
    return [...(current ? [current] : []), ...closed.slice(0, 1)];
  }

  function rowWindowSlots(row: ValidatorEpochRecord): number {
    if (row.isCurrentEpoch) return row.slotsElapsedAssigned ?? 0;
    return row.slotsAssigned ?? 0;
  }

  function windowStats(history: ValidatorHistory | null): WindowStats | null {
    const rows = pickedRows(history);
    if (rows.length === 0) return null;
    let slots = 0;
    let skipped = 0;
    let total = 0;
    for (const row of rows) {
      slots += rowWindowSlots(row);
      skipped += row.slotsSkipped ?? 0;
      const value = row.totalIncomeSol === null ? 0 : Number(row.totalIncomeSol);
      total += Number.isFinite(value) ? value : 0;
    }
    return {
      label: rows.map((row) => row.epoch).join(' + '),
      slots,
      totalSol: total > 0 ? total : null,
      skipRatePct: slots > 0 ? (skipped / slots) * 100 : null,
    };
  }

  // Both heroes' derived data. Derived blocks here keep the template
  // tidy (the value-and-loser formatting logic is the bulk of this
  // page).
  const slotA = $derived(data.a);
  const slotB = $derived(data.b);
  const statsA = $derived(windowStats(slotA?.history ?? null));
  const statsB = $derived(windowStats(slotB?.history ?? null));
  const lifetimeA = $derived(lifetimeTotalSol(slotA?.history ?? null));
  const lifetimeB = $derived(lifetimeTotalSol(slotB?.history ?? null));

  // Fallback epoch — pick the larger of the two so the column header
  // ("Epoch N") makes sense when one side has more recent data.
  const headerLabel = $derived(statsA?.label ?? statsB?.label ?? null);
  const activeWindowLabel = $derived(
    WINDOW_OPTIONS.find((option) => option.key === windowMode)?.label ?? 'Live trend',
  );

  /**
   * Per-row metric definitions. Each entry knows how to extract the
   * value from a row, how to format it, and which direction is
   * "better" (lower for skip-rate, higher for everything else).
   *
   * Co-locating extract + format + direction here means the
   * comparison-table template stays a flat .map() over this array
   * with no per-metric branching logic. Adding a new metric is one
   * appended object, not three template edits.
   */
  type MetricRow = {
    key: string;
    label: string;
    tooltip: string;
    higherIsBetter: boolean;
    /** When true, only compute when slotsAssigned >= floor on both. */
    needsScheduledSlots?: boolean;
    extract: (row: WindowStats | null) => number | null;
    fmt: (v: number) => string;
  };

  function statTotalSol(row: WindowStats | null): number | null {
    return row?.totalSol ?? null;
  }

  function statIncomePerSlot(row: WindowStats | null): number | null {
    if (row === null || row.totalSol === null || row.slots <= 0) return null;
    return row.totalSol / row.slots;
  }

  function statSkipRatePct(row: WindowStats | null): number | null {
    return row?.skipRatePct ?? null;
  }

  const METRICS: MetricRow[] = [
    {
      key: 'income_per_slot',
      label: 'Income / slot (◎)',
      tooltip:
        'Income per window leader slot. Current slots use elapsed assigned slots; closed epochs use assigned slots.',
      higherIsBetter: true,
      needsScheduledSlots: true,
      extract: statIncomePerSlot,
      fmt: (v) => `◎${v.toFixed(6)}`,
    },
    {
      key: 'total_income',
      label: 'Window total income (◎)',
      tooltip:
        'Block fees + on-chain Jito tips in the selected comparison window. Biased by stake size.',
      higherIsBetter: true,
      extract: statTotalSol,
      fmt: (v) => `◎${formatSol(v.toString())}`,
    },
    {
      key: 'skip_rate',
      label: 'Skip rate (%)',
      tooltip: 'Fraction of scheduled blocks that did not get produced. Lower is better.',
      higherIsBetter: false,
      needsScheduledSlots: true,
      extract: statSkipRatePct,
      fmt: (v) => `${v.toFixed(2)}%`,
    },
  ];

  /**
   * Decide the winner of one metric row. Returns the slot that won
   * ('a' | 'b' | 'tie' | null when one side has no data). Skip-rate
   * is "lower is better"; everything else is "higher is better".
   */
  function winnerOf(metric: MetricRow): 'a' | 'b' | 'tie' | null {
    const va = metric.extract(statsA);
    const vb = metric.extract(statsB);
    if (va === null || vb === null) return null;
    if (va === vb) return 'tie';
    if (metric.higherIsBetter) return va > vb ? 'a' : 'b';
    return va < vb ? 'a' : 'b';
  }

  function displayName(slot: CompareSlot | null): string {
    if (slot === null) return '—';
    if (slot.history === null) return slot.input;
    return slot.history.name ?? shortenPubkey(slot.history.vote, 6, 6);
  }

  // Page-level metadata. Title surfaces both inputs when present so
  // shared links read well in browser tabs and chat unfurls.
  const pageTitle = $derived.by(() => {
    if (slotA?.history && slotB?.history) {
      return `${displayName(slotA)} vs ${displayName(slotB)} — Solana validator compare | ${SITE_NAME}`;
    }
    return `Compare Solana validators — ${SITE_NAME}`;
  });
  const pageDescription = $derived.by(() => {
    if (slotA?.history && slotB?.history) {
      const a = displayName(slotA);
      const b = displayName(slotB);
      return `Side-by-side comparison of Solana validators ${a} and ${b}: live-trend income per slot, total income, and skip rate.`;
    }
    return 'Side-by-side comparison of any two Solana validators — search by name or paste vote / identity pubkeys.';
  });
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={pageDescription} />
  <link rel="canonical" href={`${SITE_URL}/compare`} />
</svelte:head>

<section class="relative">
  <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
    Compare
  </p>
  <h1 class="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">Compare two validators</h1>
  <p class="mt-4 max-w-2xl text-base text-[color:var(--color-text-muted)]">
    Search by validator name, or paste vote / identity pubkeys. The fairest comparisons are
    stake-neutral: income per slot and skip rate.
  </p>
</section>

<form onsubmit={submit} class="mt-8">
  <!--
    Inputs use `text-base` (16 px) on mobile to dodge iOS Safari's
    auto-zoom-on-focus, then drop to `text-sm` on tablet+. The submit
    button mirrors so the form row keeps its baseline alignment, and
    `min-h-11` on all three controls hits the WCAG 2.5.5 tap-target
    floor.
  -->
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
    <ValidatorSearchCombobox
      id="compare-validator-a"
      label="Validator A"
      placeholder="Validator A — search name or paste pubkey"
      bind:value={inputA}
      onSelect={(item) => selectValidator('a', item.vote)}
    />
    <ValidatorSearchCombobox
      id="compare-validator-b"
      label="Validator B"
      placeholder="Validator B — search name or paste pubkey"
      bind:value={inputB}
      onSelect={(item) => selectValidator('b', item.vote)}
    />
    <button
      type="submit"
      class="inline-flex min-h-11 items-center justify-center rounded-lg bg-[color:var(--color-brand-500)] px-5 py-2 text-base font-semibold text-white hover:bg-[color:var(--color-brand-600)] sm:self-end sm:text-sm"
    >
      Compare
    </button>
  </div>
  {#if formError !== null}
    <p class="mt-2 text-xs text-[color:var(--color-status-warn-fg)]">{formError}</p>
  {/if}
</form>

<div
  class="mt-5 inline-flex flex-wrap gap-1 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-1"
>
  {#each WINDOW_OPTIONS as option (option.key)}
    <button
      type="button"
      class="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
      class:bg-[color:var(--color-brand-500)]={windowMode === option.key}
      class:text-white={windowMode === option.key}
      class:text-[color:var(--color-text-muted)]={windowMode !== option.key}
      class:hover:text-[color:var(--color-text-default)]={windowMode !== option.key}
      onclick={() => updateWindow(option.key)}
      aria-pressed={windowMode === option.key}
    >
      {option.label}
    </button>
  {/each}
</div>

{#if slotA && slotB}
  <!-- ─────────── Heroes side by side ─────────── -->
  <div class="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
    {#each [slotA, slotB] as slot, i (i)}
      <Card tone="raised">
        <p
          class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
        >
          {i === 0 ? 'Validator A' : 'Validator B'}
        </p>
        {#if slot.history}
          <h2 class="mt-2 inline-flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <a
              href={`/income/${slot.history.vote}`}
              class="hover:text-[color:var(--color-brand-500)] hover:underline"
            >
              {slot.history.name ?? shortenPubkey(slot.history.vote, 8, 8)}
            </a>
            {#if slot.history.claimed}
              <VerifiedBadge size={16} />
            {/if}
          </h2>
          <!-- Vote pubkey under the validator name with an explicit compact copy target. -->
          <p class="mt-1 text-[color:var(--color-text-subtle)]">
            <AddressDisplay pubkey={slot.history.vote} head={8} tail={8} />
          </p>
          <p class="mt-4 text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]">
            Total income (last {slot.history.items.length} epochs)
          </p>
          <p class="mt-1 text-3xl font-semibold tracking-tight text-[color:var(--color-brand-500)]">
            {#if (i === 0 ? lifetimeA : lifetimeB) !== null}
              ◎{formatSol((i === 0 ? lifetimeA : lifetimeB)!.toString())}
            {:else}
              <span class="text-[color:var(--color-text-subtle)]">—</span>
            {/if}
          </p>
        {:else}
          <h2 class="mt-2 text-2xl font-semibold tracking-tight">{slot.input}</h2>
          <p class="mt-3 text-sm text-[color:var(--color-status-warn-fg)]">
            Not found: {slot.errorMessage ?? 'unknown error'}
          </p>
        {/if}
      </Card>
    {/each}
  </div>

  <!-- ─────────── Per-metric grid ─────────── -->
  <section class="mt-10">
    <header class="mb-4 flex items-baseline justify-between">
      <h2 class="text-lg font-semibold">Per-metric comparison</h2>
      {#if headerLabel !== null}
        <p class="font-mono text-xs text-[color:var(--color-text-subtle)]">
          {activeWindowLabel}: epochs {headerLabel}
        </p>
      {/if}
    </header>

    <div class="grid gap-3 md:hidden">
      {#each METRICS as metric (metric.key)}
        {@const va = metric.extract(statsA)}
        {@const vb = metric.extract(statsB)}
        {@const winner = winnerOf(metric)}
        <article
          class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
        >
          <h3 class="inline-flex items-center text-sm font-semibold">
            {metric.label}
            <Tooltip label={`About ${metric.label}`} content={metric.tooltip} />
          </h3>
          <dl class="mt-3 grid grid-cols-2 gap-2">
            <div
              class={winner === 'a'
                ? 'rounded-lg bg-[color:var(--color-status-ok-bg)] p-3'
                : 'rounded-lg bg-[color:var(--color-surface-muted)] p-3'}
            >
              <dt class="truncate text-xs text-[color:var(--color-text-muted)]">
                {displayName(slotA)}
              </dt>
              <dd class="mt-1 font-mono text-sm font-semibold tabular-nums">
                {va !== null ? metric.fmt(va) : '—'}
              </dd>
            </div>
            <div
              class={winner === 'b'
                ? 'rounded-lg bg-[color:var(--color-status-ok-bg)] p-3'
                : 'rounded-lg bg-[color:var(--color-surface-muted)] p-3'}
            >
              <dt class="truncate text-xs text-[color:var(--color-text-muted)]">
                {displayName(slotB)}
              </dt>
              <dd class="mt-1 font-mono text-sm font-semibold tabular-nums">
                {vb !== null ? metric.fmt(vb) : '—'}
              </dd>
            </div>
          </dl>
        </article>
      {/each}
    </div>

    <div
      class="hidden overflow-hidden rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] md:block"
    >
      <table class="min-w-full divide-y divide-[color:var(--color-border-default)] text-sm">
        <thead
          class="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          <tr>
            <th scope="col" class="px-4 py-3 text-left">Metric</th>
            <th scope="col" class="max-w-56 truncate px-4 py-3 text-right">{displayName(slotA)}</th>
            <th scope="col" class="max-w-56 truncate px-4 py-3 text-right">{displayName(slotB)}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[color:var(--color-border-default)]">
          {#each METRICS as metric (metric.key)}
            {@const va = metric.extract(statsA)}
            {@const vb = metric.extract(statsB)}
            {@const winner = winnerOf(metric)}
            <tr>
              <th scope="row" class="px-4 py-3 text-left font-medium">
                <span class="inline-flex items-center">
                  {metric.label}
                  <Tooltip label={`About ${metric.label}`} content={metric.tooltip} />
                </span>
              </th>
              <td
                class="px-4 py-3 text-right font-mono tabular-nums"
                class:bg-[color:var(--color-status-ok-bg)]={winner === 'a'}
                class:font-semibold={winner === 'a'}
              >
                {va !== null ? metric.fmt(va) : '—'}
              </td>
              <td
                class="px-4 py-3 text-right font-mono tabular-nums"
                class:bg-[color:var(--color-status-ok-bg)]={winner === 'b'}
                class:font-semibold={winner === 'b'}
              >
                {vb !== null ? metric.fmt(vb) : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="mt-3 text-xs text-[color:var(--color-text-subtle)]">
      Highlighted cell wins the row. Total income is biased by stake size — for a stake-neutral
      read, use Income / slot or Skip rate.
    </p>
  </section>
{:else}
  <p class="mt-10 text-sm text-[color:var(--color-text-muted)]">
    Start by entering two validators above. You can paste vote or identity pubkeys.
  </p>
{/if}
