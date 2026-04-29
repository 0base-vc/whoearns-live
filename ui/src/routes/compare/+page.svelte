<!--
  /compare — side-by-side validator comparison.

  Two-column layout:
    left  = validator A (`?a=<vote-or-identity>`)
    right = validator B (`?b=<vote-or-identity>`)

  Both inputs are URL params so the page is shareable. When one or
  both inputs are missing, the page falls through to a search form
  that POSTs back to itself with the params populated.

  Per-metric grid below the heroes shows the same 5 metrics the
  leaderboard ranks on (performance, total income, skip rate,
  median fee, operator APR) with a "winner" highlight on each row.
  Stake-neutral metrics (performance, skip rate, APR) are the
  fairest direct comparison; total-income comparisons are biased by
  stake size, which we annotate.

  The compare surface is English-first because its labels are compact
  domain terms and are meant to match the leaderboard/income pages.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import Card from '$lib/components/Card.svelte';
  import EllipsisAddress from '$lib/components/EllipsisAddress.svelte';
  import VerifiedBadge from '$lib/components/VerifiedBadge.svelte';
  import Tooltip from '$lib/components/Tooltip.svelte';
  import { formatSol, shortenPubkey } from '$lib/format';
  import { SITE_NAME, SITE_URL } from '$lib/site';
  import type { CompareData, CompareSlot } from './+page';
  import type { ValidatorEpochRecord, ValidatorHistory } from '$lib/types';

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

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const a = inputA.trim();
    const b = inputB.trim();
    if (a.length === 0 && b.length === 0) return;
    const params = new URLSearchParams();
    if (a.length > 0) params.set('a', a);
    if (b.length > 0) params.set('b', b);
    void goto(`/compare?${params.toString()}`, { invalidateAll: true, keepFocus: true });
  }

  /**
   * Pull the most-recent CLOSED-epoch row for a validator. Same
   * "skip running epoch" rule as the OG image renderer — a row
   * whose status hasn't settled would let the comparison shift
   * underneath the user's scroll. Falls back to the newest row
   * available when nothing is closed yet.
   */
  function latestClosed(history: ValidatorHistory | null): ValidatorEpochRecord | null {
    if (history === null || history.items.length === 0) return null;
    const closed = history.items.find((r) => r.isFinal);
    return closed ?? history.items[0] ?? null;
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

  function rowSkipRatePct(row: ValidatorEpochRecord | null): number | null {
    if (row === null || row.slotsAssigned === null || row.slotsAssigned <= 0) return null;
    return ((row.slotsSkipped ?? 0) / row.slotsAssigned) * 100;
  }

  function rowTotalSol(row: ValidatorEpochRecord | null): number | null {
    if (row === null) return null;
    const fees = row.blockFeesTotalSol === null ? 0 : Number(row.blockFeesTotalSol);
    const mev = row.blockTipsTotalSol === null ? 0 : Number(row.blockTipsTotalSol);
    const v = (Number.isFinite(fees) ? fees : 0) + (Number.isFinite(mev) ? mev : 0);
    return v > 0 ? v : null;
  }

  function rowPerformancePerSlot(row: ValidatorEpochRecord | null): number | null {
    const total = rowTotalSol(row);
    if (total === null || row === null || row.slotsAssigned === null || row.slotsAssigned <= 0) {
      return null;
    }
    return total / row.slotsAssigned;
  }

  function rowMedianFeeSol(row: ValidatorEpochRecord | null): number | null {
    if (row === null || row.medianBlockFeeSol === null) return null;
    const v = Number(row.medianBlockFeeSol);
    return Number.isFinite(v) ? v : null;
  }

  // NOTE: Operator APR isn't shown here because activated stake isn't
  // on the per-epoch `ValidatorEpochRecord` shape — it's only on the
  // leaderboard projection. Adding it would mean an extra fetch per
  // validator (the leaderboard row) which doubles the page load for
  // marginal benefit. Use the income page for APR; this page focuses
  // on per-epoch comparable metrics.

  // Both heroes' derived data. Derived blocks here keep the template
  // tidy (the value-and-loser formatting logic is the bulk of this
  // page).
  const slotA = $derived(data.a);
  const slotB = $derived(data.b);
  const rowA = $derived(latestClosed(slotA?.history ?? null));
  const rowB = $derived(latestClosed(slotB?.history ?? null));
  const lifetimeA = $derived(lifetimeTotalSol(slotA?.history ?? null));
  const lifetimeB = $derived(lifetimeTotalSol(slotB?.history ?? null));

  // Fallback epoch — pick the larger of the two so the column header
  // ("Epoch N") makes sense when one side has more recent data.
  const headerEpoch = $derived(
    rowA !== null && rowB !== null
      ? Math.max(rowA.epoch, rowB.epoch)
      : (rowA?.epoch ?? rowB?.epoch ?? null),
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
    extract: (row: ValidatorEpochRecord | null) => number | null;
    fmt: (v: number) => string;
  };

  const METRICS: MetricRow[] = [
    {
      key: 'performance',
      label: 'Performance (◎/slot)',
      tooltip:
        'Income per scheduled block. Stake-neutral — the cleanest direct comparison between any two validators.',
      higherIsBetter: true,
      needsScheduledSlots: true,
      extract: rowPerformancePerSlot,
      fmt: (v) => `◎${v.toFixed(6)}`,
    },
    {
      key: 'total_income',
      label: 'Epoch total income (◎)',
      tooltip:
        'Block fees + on-chain Jito tips in the last closed epoch. Biased by stake size — bigger validators always win this row regardless of operator skill.',
      higherIsBetter: true,
      extract: rowTotalSol,
      fmt: (v) => `◎${formatSol(v.toString())}`,
    },
    {
      key: 'skip_rate',
      label: 'Skip rate (%)',
      tooltip: 'Fraction of scheduled blocks that did not get produced. Lower is better.',
      higherIsBetter: false,
      needsScheduledSlots: true,
      extract: rowSkipRatePct,
      fmt: (v) => `${v.toFixed(2)}%`,
    },
    {
      key: 'median_fee',
      label: 'Median block fee (◎)',
      tooltip: 'Median fee captured per produced block. Reflects priority-fee capture quality.',
      higherIsBetter: true,
      extract: rowMedianFeeSol,
      fmt: (v) => `◎${v.toFixed(6)}`,
    },
  ];

  /**
   * Decide the winner of one metric row. Returns the slot that won
   * ('a' | 'b' | 'tie' | null when one side has no data). Skip-rate
   * is "lower is better"; everything else is "higher is better".
   */
  function winnerOf(metric: MetricRow): 'a' | 'b' | 'tie' | null {
    const va = metric.extract(rowA);
    const vb = metric.extract(rowB);
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
      return `Side-by-side comparison of Solana validators ${a} and ${b}: per-epoch income, skip rate, MEV, performance per slot, and operator APR.`;
    }
    return 'Side-by-side comparison of any two Solana validators — performance, income, skip rate, MEV, and operator APR.';
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
    Paste two vote or identity pubkeys (or monikers tracked by this site) and see them side-by-side.
    The fairest comparisons are stake-neutral: performance and skip rate.
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
    <input
      type="text"
      bind:value={inputA}
      placeholder="Validator A — vote / identity / moniker"
      class="min-h-11 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 font-mono text-base sm:text-sm"
      aria-label="Validator A pubkey"
    />
    <input
      type="text"
      bind:value={inputB}
      placeholder="Validator B — vote / identity / moniker"
      class="min-h-11 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 font-mono text-base sm:text-sm"
      aria-label="Validator B pubkey"
    />
    <button
      type="submit"
      class="inline-flex min-h-11 items-center justify-center rounded-lg bg-[color:var(--color-brand-500)] px-5 py-2 text-base font-semibold text-white hover:bg-[color:var(--color-brand-600)] sm:text-sm"
    >
      Compare
    </button>
  </div>
</form>

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
          <!--
            Vote pubkey under the validator name. Elastic single-
            line via `EllipsisAddress` — full 44-char pubkey when
            the card is wide enough (desktop ~544 px slot fits
            comfortably), middle-truncates on stacked-mobile cards
            without wrapping. Copy-on-select hijacks the clipboard
            with the full pubkey.
          -->
          <p class="mt-1">
            <EllipsisAddress
              pubkey={slot.history.vote}
              class="font-mono text-xs text-[color:var(--color-text-subtle)]"
            />
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
      {#if headerEpoch !== null}
        <p class="font-mono text-xs text-[color:var(--color-text-subtle)]">
          Latest closed epoch:
          {headerEpoch}
        </p>
      {/if}
    </header>

    <div
      class="overflow-hidden rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]"
    >
      <table class="min-w-full divide-y divide-[color:var(--color-border-default)] text-sm">
        <thead
          class="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          <tr>
            <th scope="col" class="px-4 py-3 text-left">Metric</th>
            <th scope="col" class="px-4 py-3 text-right">{displayName(slotA)}</th>
            <th scope="col" class="px-4 py-3 text-right">{displayName(slotB)}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[color:var(--color-border-default)]">
          {#each METRICS as metric (metric.key)}
            {@const va = metric.extract(rowA)}
            {@const vb = metric.extract(rowB)}
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
      read, use Performance, Skip rate, or APR.
    </p>
  </section>
{:else}
  <p class="mt-10 text-sm text-[color:var(--color-text-muted)]">
    Start by entering two validators above. You can paste vote or identity pubkeys, or a moniker
    that this site already tracks.
  </p>
{/if}
