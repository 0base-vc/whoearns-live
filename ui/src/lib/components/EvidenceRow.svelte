<!--
  EvidenceRow — the expandable evidence panel that sits underneath
  one row of the Node Tier card's sub-component breakdown table.

  The hub's tier card surfaces 3 sub-components (Reliability / Economic
  percentile / CU subscore) with score + weight + contribution. Users
  reading the one-line hint asked for the RAW INPUTS that fed the
  number — which leader slots were skipped, which cohort the
  percentile was ranked against, the formula with values substituted
  in, and the descriptive levers that move the figure. This component
  renders all three zones inside a `tone="raised"` Card so the
  evidence reads as one cohesive panel inside the expanded `<tr>`.

  Voice rule: every string here is DESCRIPTIVE of what was measured,
  never prescriptive. "Moved by: median per-slot income across the
  window" — not "Improve your per-slot income". Delegators and
  operators both read this page; pushing imperative advice would
  shift the page from "what the score IS" to "what the operator
  SHOULD do", which is a different surface.

  Layout:
    - Inputs zone: 2-3 KpiStat tiles (sm) with the raw numbers
    - Formula zone: one line, plain language with the actual values
      substituted in (e.g. PERCENT_RANK(…) = 1.0)
    - Levers zone: bulleted descriptive lines naming the inputs that
      drive the figure
-->
<script lang="ts">
  import Card from './Card.svelte';
  import KpiStat from './KpiStat.svelte';
  import type { CuEvidence, EconomicEvidence, ReliabilityEvidence } from '$lib/types';
  import {
    formatComputeUnits,
    formatFractionAsPercent,
    formatLamports,
    shortenPubkey,
  } from '$lib/format';

  /**
   * `kind` discriminates which evidence shape `evidence` is. Each
   * branch renders a different inputs grid + formula + lever copy
   * tailored to the sub-component it describes.
   */
  type EvidenceProps =
    | { kind: 'reliability'; evidence: ReliabilityEvidence }
    | { kind: 'economic'; evidence: EconomicEvidence }
    | { kind: 'cu'; evidence: CuEvidence };

  interface Props extends Pick<EvidenceProps, 'kind' | 'evidence'> {
    /**
     * The scoring window the evidence was measured over — the
     * EvidenceRow weaves it into the prose ("across 5 closed epochs",
     * "ranked against 19 indexed peers") so the row reads as a
     * stand-alone sentence even when collapsed back into a card.
     */
    window?: {
      epochs: number;
      economicCohortSize: number;
      cohortAsOfEpoch?: { fromEpoch: number; toEpoch: number } | null;
    };
    /**
     * The component's score — surfaced in the formula line so the
     * row reads "PERCENT_RANK = {score}" with the actual value
     * rather than the literal "{score}" placeholder. Optional for
     * the reliability branch (where the score is derived from
     * `wilsonSkipRateUpper`); required in practice for economic /
     * CU where the percentile arrives pre-computed.
     */
    score?: number | null;
  }

  let { kind, evidence, window, score = null }: Props = $props();

  // ── Reliability branch derivations ──
  // Sum per-epoch counts client-side (instead of expecting the
  // backend to surface a window total) so the prose reads off the
  // same numbers the per-epoch table would render — if the backend
  // ever drops a row from `perEpoch`, the displayed total reflects
  // the actual evidence rather than diverging.
  const reliabilityTotals = $derived.by(() => {
    if (kind !== 'reliability') return null;
    const rows = (evidence as ReliabilityEvidence).perEpoch;
    let totalAssigned = 0;
    let totalSkipped = 0;
    for (const row of rows) {
      totalAssigned += row.slotsAssigned;
      totalSkipped += row.slotsSkipped;
    }
    return { totalAssigned, totalSkipped };
  });

  // Reliability score derives directly from the Wilson upper bound —
  // surfaced here so the EvidenceRow can render the score from the
  // SAME number the formula prints (avoids drift between the parent
  // table and the evidence panel).
  const reliabilityScore = $derived.by(() => {
    if (kind !== 'reliability') return null;
    return 1 - (evidence as ReliabilityEvidence).wilsonSkipRateUpper;
  });

  // ── Economic branch derivations ──
  const economicRankLabel = $derived.by(() => {
    if (kind !== 'economic') return null;
    const ev = evidence as EconomicEvidence;
    return `${ev.rank.position} of ${ev.rank.of}`;
  });

  // Cohort disclosure (J) — the exact vote pubkeys the percentile was
  // ranked against. `undefined` on older payloads (cohort not
  // disclosed) → null here so the template skips the affordance
  // entirely rather than rendering an empty `<details>`. An empty
  // array is treated the same as absent (nothing to reproduce).
  const cohortVotes = $derived.by<string[] | null>(() => {
    if (kind !== 'economic') return null;
    const votes = (evidence as EconomicEvidence).cohortVotes;
    if (votes === undefined || votes.length === 0) return null;
    return votes;
  });

  // Ordinal suffix for the rank ("1st", "2nd", "3rd", "11th") so the
  // headline reads as a sentence ("ranked 1st of 19 indexed
  // validators") rather than a bare integer. English-only — the
  // evidence copy on this surface is English throughout.
  function ordinal(n: number): string {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1:
        return `${n}st`;
      case 2:
        return `${n}nd`;
      case 3:
        return `${n}rd`;
      default:
        return `${n}th`;
    }
  }

  // ── CU branch derivations ──
  // The CU branch carries no per-epoch table (backend only ships
  // window-aggregate avg CU per block), so the inputs grid is just
  // the two figures. Keep the formula calculation reactive so any
  // future schema bump that adds richer evidence doesn't have to
  // re-derive at the call site.
</script>

<Card tone="raised">
  {#if kind === 'reliability'}
    {@const rel = evidence as ReliabilityEvidence}
    {@const totals = reliabilityTotals ?? { totalAssigned: 0, totalSkipped: 0 }}
    <!--
      Inputs grid — three tiles fit a mobile column comfortably; on
      desktop they line up in a row. `grid-cols-1 sm:grid-cols-3`
      reads naturally at every breakpoint without an extra wrapper.
    -->
    <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <KpiStat label="Leader slots assigned" size="sm" title="Sum across the scoring window.">
        <span class="tabular-nums">{totals.totalAssigned.toLocaleString()}</span>
      </KpiStat>
      <KpiStat label="Slots skipped" size="sm" title="Slots where the validator failed to produce.">
        <span class="tabular-nums">{totals.totalSkipped.toLocaleString()}</span>
      </KpiStat>
      <KpiStat
        label="Wilson 95% upper"
        size="sm"
        title="Conservative upper bound on the true skip rate."
      >
        <span class="tabular-nums">{formatFractionAsPercent(rel.wilsonSkipRateUpper)}</span>
      </KpiStat>
    </dl>

    <!--
      Formula line — one sentence, the values substituted in so a
      reader who knows the math can sanity-check the score without
      cross-referencing docs.
    -->
    <p class="mt-4 text-sm text-[color:var(--color-text-muted)]">
      Across {window?.epochs ?? rel.perEpoch.length} closed epochs this validator was assigned
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{totals.totalAssigned.toLocaleString()}</span
      >
      leader slots and skipped
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{totals.totalSkipped.toLocaleString()}</span
      >. Wilson 95% upper bound on skip rate =
      <span class="tabular-nums">{formatFractionAsPercent(rel.wilsonSkipRateUpper)}</span>;
      reliability = 1 − wilson upper =
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{formatFractionAsPercent(reliabilityScore)}</span
      >. The
      <span class="tabular-nums">{formatFractionAsPercent(rel.skipRateFloor, 0)}</span>
      Wilson-upper hard cap to kindling is
      <span
        class={rel.floorEngaged
          ? 'font-semibold text-[color:var(--color-status-warn-fg)]'
          : 'text-[color:var(--color-text-default)]'}
      >
        {rel.floorEngaged ? 'engaged' : 'not engaged'}</span
      >.
    </p>

    <!--
      Levers — descriptive, NOT prescriptive. Each bullet names an
      input that moves the score. No verbs like "improve" / "raise"
      / "increase" — the page is reporting what was measured, not
      coaching the operator on how to climb.
    -->
    <ul
      class="mt-3 list-disc space-y-1 pl-5 text-xs text-[color:var(--color-text-muted)]"
      aria-label="Inputs that move this score"
    >
      <li>Moved by: per-epoch leader-slot count (more slots tighten the Wilson interval).</li>
      <li>Moved by: per-epoch skipped-slot count across the window.</li>
      <li>
        Moved by: the {formatFractionAsPercent(rel.skipRateFloor, 0)} Wilson-upper hard cap, which clamps
        the tier to Kindling regardless of the economic half.
      </li>
    </ul>

    {#if rel.perEpoch.length > 0}
      <!--
        Per-epoch evidence table — every row that fed the Wilson
        bound. `min-w-full` + `overflow-x-auto` lets a wide window
        scroll horizontally on small screens rather than wrap into
        unreadable two-line cells.
      -->
      <div class="mt-4 overflow-x-auto">
        <table class="min-w-full text-xs" aria-label="Per-epoch slots assigned and skipped">
          <thead class="text-[10px] uppercase tracking-wider text-[color:var(--color-text-subtle)]">
            <tr class="border-b border-[color:var(--color-border-default)]">
              <th scope="col" class="py-1.5 pr-3 text-left font-medium">Epoch</th>
              <th scope="col" class="px-2 py-1.5 text-right font-medium">Assigned</th>
              <th scope="col" class="pl-2 py-1.5 text-right font-medium">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {#each rel.perEpoch as row (row.epoch)}
              <tr>
                <td class="py-1 pr-3 tabular-nums">{row.epoch}</td>
                <td class="px-2 py-1 text-right tabular-nums"
                  >{row.slotsAssigned.toLocaleString()}</td
                >
                <td class="pl-2 py-1 text-right tabular-nums"
                  >{row.slotsSkipped.toLocaleString()}</td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else if kind === 'economic'}
    {@const eco = evidence as EconomicEvidence}
    <dl class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <KpiStat
        label="Validator median / slot"
        size="sm"
        title="Median per-leader-slot income across the window."
      >
        <span class="tabular-nums">{formatLamports(eco.validatorMedianLamportsPerSlot)}</span>
      </KpiStat>
      <KpiStat
        label="Cohort median / slot"
        size="sm"
        title="Median per-leader-slot income across the indexed cohort."
      >
        <span class="tabular-nums">{formatLamports(eco.cohortMedianLamportsPerSlot)}</span>
      </KpiStat>
      <KpiStat
        label="Rank in indexed cohort"
        size="sm"
        title="Position in the sorted cohort of validators WhoEarns indexes — not the whole Solana cluster."
      >
        <span class="tabular-nums">{economicRankLabel ?? '—'}</span>
      </KpiStat>
    </dl>

    <p class="mt-4 text-sm text-[color:var(--color-text-muted)]">
      Median per-leader-slot income across the window:
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{formatLamports(eco.validatorMedianLamportsPerSlot)}</span
      >. Cohort median across
      <span class="tabular-nums"
        >{(window?.economicCohortSize ?? eco.rank.of).toLocaleString()}</span
      >
      indexed validators in the same window:
      <span class="tabular-nums">{formatLamports(eco.cohortMedianLamportsPerSlot)}</span> (P25 =
      <span class="tabular-nums">{formatLamports(eco.cohortP25LamportsPerSlot)}</span>, P75 =
      <span class="tabular-nums">{formatLamports(eco.cohortP75LamportsPerSlot)}</span>).
      PERCENT_RANK =
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{score === null ? '—' : score.toFixed(4)}</span
      >
      — ranked
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{ordinal(eco.rank.position)}</span
      >
      of
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{eco.rank.of}</span
      > indexed validators.
    </p>

    {#if eco.incomeBreakdown}
      <!--
        Income decomposition — base fees, priority fees, Jito tips —
        a delegator wanting to see whether per-slot income leans on
        MEV or on plain user-paid fees has the breakdown right next
        to the percentile that ranks it. Hidden when the backend
        skipped the breakdown (older payloads / non-producers).
      -->
      <dl class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <KpiStat label="Base fees" size="sm" title="Window total — 5,000 lam × signatures.">
          <span class="tabular-nums">{formatLamports(eco.incomeBreakdown.baseFeesLamports)}</span>
        </KpiStat>
        <KpiStat
          label="Priority fees"
          size="sm"
          title="Window total — user-paid priority on top of base."
        >
          <span class="tabular-nums"
            >{formatLamports(eco.incomeBreakdown.priorityFeesLamports)}</span
          >
        </KpiStat>
        <KpiStat label="Jito tips" size="sm" title="Window total — MEV-tip take.">
          <span class="tabular-nums">{formatLamports(eco.incomeBreakdown.jitoTipsLamports)}</span>
        </KpiStat>
      </dl>
    {/if}

    <ul
      class="mt-3 list-disc space-y-1 pl-5 text-xs text-[color:var(--color-text-muted)]"
      aria-label="Inputs that move this score"
    >
      <li>Moved by: median per-slot income across the window.</li>
      <li>Moved by: the indexed-validator cohort that anchors the percentile.</li>
      <li>
        Moved by: composition of income — base fees, priority fees, and Jito tips per produced
        block.
      </li>
    </ul>

    <p class="mt-3 text-xs">
      <!--
        Anchor link to the full income history strip on the same
        page. `href="#income-strip"` jumps without smooth-scroll
        disorientation; the destination's `id` is set on the
        IncomeSummaryStrip wrapper.
      -->
      <a
        href="#income-strip"
        class="inline-flex min-h-11 items-center text-[color:var(--color-brand-500)] hover:underline"
      >
        See full income history ↓
      </a>
    </p>

    {#if cohortVotes !== null}
      <!--
        Cohort disclosure (J). The exact peer set the percentile was
        ranked against, so the rank is independently reproducible — a
        delegator can pull each peer's per-slot income and re-derive
        the percentile themselves. Collapsed by default (`<details>`)
        because the list runs ~19-200 long; the summary carries the
        count so the affordance is honest before expansion. Descriptive
        label only — no editorialising on who's "better".

        Each pubkey links to that validator's hub (`/v/<vote>`). The
        list is `max-h` + `overflow-y-auto` so a 200-deep cohort
        scrolls inside the panel instead of stretching the card.
      -->
      <details class="mt-3 text-xs">
        <summary
          class="inline-flex min-h-11 cursor-pointer items-center text-[color:var(--color-brand-500)] hover:underline"
        >
          View cohort ({cohortVotes.length})
        </summary>
        <div class="mt-2">
          <p class="text-[color:var(--color-text-muted)]">
            Ranked against these {cohortVotes.length} indexed validators:
          </p>
          <ul
            class="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-2"
          >
            {#each cohortVotes as voteKey (voteKey)}
              <li>
                <a
                  href={`/v/${voteKey}`}
                  class="font-mono text-[color:var(--color-text-default)] hover:text-[color:var(--color-brand-500)] hover:underline"
                >
                  {shortenPubkey(voteKey, 8, 6)}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      </details>
    {/if}

    {#if eco.perEpoch.length > 0}
      <div class="mt-3 overflow-x-auto">
        <table class="min-w-full text-xs" aria-label="Per-epoch lamports per leader slot">
          <thead class="text-[10px] uppercase tracking-wider text-[color:var(--color-text-subtle)]">
            <tr class="border-b border-[color:var(--color-border-default)]">
              <th scope="col" class="py-1.5 pr-3 text-left font-medium">Epoch</th>
              <th scope="col" class="pl-2 py-1.5 text-right font-medium">Per-slot income</th>
            </tr>
          </thead>
          <tbody>
            {#each eco.perEpoch as row (row.epoch)}
              <tr>
                <td class="py-1 pr-3 tabular-nums">{row.epoch}</td>
                <td class="pl-2 py-1 text-right tabular-nums"
                  >{formatLamports(row.lamportsPerSlot)}</td
                >
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if window?.cohortAsOfEpoch}
      <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
        Cohort sampled across epochs
        <span class="tabular-nums">{window.cohortAsOfEpoch.fromEpoch}</span>–<span
          class="tabular-nums">{window.cohortAsOfEpoch.toEpoch}</span
        >.
      </p>
    {/if}
  {:else}
    {@const cu = evidence as CuEvidence}
    <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <KpiStat
        label="Validator avg CU / block"
        size="sm"
        title="Average compute units per produced block across the window."
      >
        <span class="tabular-nums">{formatComputeUnits(cu.validatorAvgCuPerBlock)}</span>
      </KpiStat>
      <KpiStat
        label="Cohort median CU / block"
        size="sm"
        title="Median across the same indexed cohort as the economic percentile."
      >
        <span class="tabular-nums">{formatComputeUnits(cu.cohortMedianCuPerBlock)}</span>
      </KpiStat>
    </dl>

    <p class="mt-4 text-sm text-[color:var(--color-text-muted)]">
      Average compute units per produced block across the window:
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{formatComputeUnits(cu.validatorAvgCuPerBlock)}</span
      >. Cohort median across the same
      <span class="tabular-nums">{(window?.economicCohortSize ?? 0).toLocaleString()}</span>
      validators:
      <span class="tabular-nums">{formatComputeUnits(cu.cohortMedianCuPerBlock)}</span>.
      PERCENT_RANK =
      <span class="tabular-nums font-medium text-[color:var(--color-text-default)]"
        >{score === null ? '—' : score.toFixed(4)}</span
      >. CU never forces kindling; only the income side does.
    </p>

    <ul
      class="mt-3 list-disc space-y-1 pl-5 text-xs text-[color:var(--color-text-muted)]"
      aria-label="Inputs that move this score"
    >
      <li>Moved by: average compute units packed per produced block.</li>
      <li>Moved by: cohort median CU per block across indexed peers.</li>
      <li>
        Moved by: number of produced blocks in the window (a non-producer falls back to the economic
        percentile).
      </li>
    </ul>
  {/if}
</Card>
