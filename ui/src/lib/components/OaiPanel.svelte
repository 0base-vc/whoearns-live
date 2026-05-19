<!--
  OaiPanel — Operator Activity Index display.

  The OAI is a Phase 6+7 composite of two halves:
    - Governance score: 0-1, derived from peer-reaction-weighted
      GitHub SIMD discussion comments. NULL today in every real
      deployment because the SIMD-discussions data feed isn't
      live yet.
    - Wallet score: 0-1, derived from registered-wallet daily
      activity over the last 90 days.

  Honesty in the partial release. Because the governance half is
  null today, `composite` is also null (the API refuses to publish
  a 50/50 blend it can only see one side of). The sub-component
  counts (`commentCount`, `reactionsReceived`, `activeWindowCount`)
  AND `walletScore` are populated as their real values though, so
  a wallet-only delegator still has something to read.

  Per-component breakdown is mandatory: three tiles in row — the
  governance half, the wallet half, AND the composite tile sitting
  between them so a delegator never sees a composite number without
  its parts in the same eyeline. When governance is pending the
  composite tile spells out WHY there is no composite ("waiting on
  the governance half"), and the headline pill is dropped — the
  PM-brief mandate is that the composite is louder than its parts
  only when the parts agree on what it should be.

  Props:
    - `oai`: the OAI components block from /scoring (null when
      validator is unclaimed / opted-out / identity-drifted)
    - `claimed`: hint from the caller to render the empty-claim
      state cleanly. When `oai === null && claimed === true` the
      panel is still in the "claimed but ingest pending" state.
-->
<script lang="ts">
  import type { OaiComponents } from '$lib/types';
  import Pill from './Pill.svelte';

  interface Props {
    oai: OaiComponents | null;
    claimed: boolean;
  }

  let { oai, claimed }: Props = $props();

  // The governance ingest is gated behind a backend job that ships
  // separately from this UI. `ingestStatus.governanceIngestActive`
  // tells us whether the comment data has actually been written to
  // the DB yet — if false, we can't honestly report a score, so the
  // half renders as a "coming soon" empty-state instead of a fake 0.
  const governanceActive = $derived(oai?.ingestStatus?.governanceIngestActive ?? false);
  const walletFeesActive = $derived(oai?.ingestStatus?.walletFeesIngestActive ?? false);

  /**
   * Format a 0-1 score as a 0-100 integer string. `null` renders as
   * an em-dash so we never display a fake number — same policy as
   * `TierRing`'s composite label.
   */
  function formatScore(score: number | null | undefined): string {
    if (score === null || score === undefined) return '—';
    return `${(score * 100).toFixed(0)}`;
  }
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4 lg:max-w-[calc((100%/12)*8)]"
  aria-labelledby="oai-heading"
>
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <!-- h2 — peer of the other hub sections (Wallet activity, Audit, SIMD). -->
    <h2 id="oai-heading" class="text-base font-semibold tracking-tight">Operator Activity Index</h2>
    <!--
      Pill renders ONLY when the composite is a real number — never
      "OAI —". Per the per-component breakdown mandate, a half-shown
      composite shouldn't be louder than its parts.
    -->
    {#if oai !== null && oai.composite !== null}
      <Pill tone="brand" size="sm">OAI {formatScore(oai.composite)}</Pill>
    {/if}
  </header>

  {#if !claimed || oai === null}
    <!--
      Unclaimed (or opted-out / identity-drifted, which the API
      collapses) → no OAI surface. Collapse to a single explanatory
      line per "shorter page, not sadder." The action footer at
      the bottom of the hub carries the canonical operator CTA;
      duplicating it here was the earlier brand-voice mistake
      — a delegator scrolling past saw "Sign to claim" twice on
      the same page.
    -->
    <p class="text-sm text-[color:var(--color-text-muted)]">
      This validator hasn't been claimed by its operator, so wallet and governance activity aren't
      linked here yet. The operator can claim by signing one offline message — see the action footer
      at the bottom of the page.
    </p>
  {:else}
    <!--
      Claimed + OAI present. Three tiles in a single row on desktop,
      stacked on mobile. Composite tile is the middle so a viewer
      reads left → centre → right as governance / blend / wallet.
    -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <!-- Governance half -->
      <div class="rounded-md border border-[color:var(--color-border-default)] p-3">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold tracking-tight">Governance</h3>
          {#if !governanceActive}
            <Pill tone="warn" size="sm">Ingest pending</Pill>
          {/if}
        </div>
        {#if governanceActive}
          <p class="mt-1 text-3xl font-semibold tabular-nums">
            {formatScore(oai.components.governance.score)}
            <span class="text-base font-normal text-[color:var(--color-text-muted)]">/ 100</span>
          </p>
        {:else}
          <!--
            Em-dash with an accessible label so screen readers say
            "pending" rather than literally "dash" — the visual
            stays minimal but the semantic isn't a number.
          -->
          <p
            class="mt-1 text-3xl font-semibold tabular-nums text-[color:var(--color-text-subtle)]"
            aria-label="Governance score pending — feed not yet active"
          >
            <span aria-hidden="true">—</span>
          </p>
        {/if}
        <dl class="mt-3 grid grid-cols-3 gap-2 text-xs text-[color:var(--color-text-muted)]">
          <div>
            <dt class="uppercase tracking-wide text-[color:var(--color-text-muted)]">Comments</dt>
            <dd class="mt-0.5 tabular-nums">{oai.components.governance.commentCount}</dd>
          </div>
          <div>
            <dt class="uppercase tracking-wide text-[color:var(--color-text-muted)]">
              Peer reactions
            </dt>
            <dd class="mt-0.5 tabular-nums">{oai.components.governance.reactionsReceived}</dd>
          </div>
          <div>
            <dt class="uppercase tracking-wide text-[color:var(--color-text-muted)]">
              Active SIMDs
            </dt>
            <dd class="mt-0.5 tabular-nums">{oai.components.governance.activeWindowCount}</dd>
          </div>
        </dl>
        {#if !governanceActive}
          <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
            The governance discussions feed isn't reading SIMD comments yet — this score will start
            populating when the feed turns on. The numbers above are the real counts (currently
            zero); they'll move once the data feed is live.
          </p>
        {/if}
      </div>

      <!-- Composite tile (per-component-breakdown mandate: composite lives next to its parts) -->
      <div class="rounded-md border border-[color:var(--color-border-default)] p-3">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold tracking-tight">Composite</h3>
        </div>
        {#if oai.composite !== null}
          <!--
            Composite renders as a bare 0-100 number — the
            "/ 100" suffix is reserved for the two sub-tiles so
            the eyeline reads as "Governance N/100, Composite N
            (the blend), Wallet N/100." Duplicating the suffix
            here was the earlier brand-voice mistake; the
            sub-tile suffixes already establish the scale.
          -->
          <p class="mt-1 text-3xl font-semibold tabular-nums text-[color:var(--color-brand-500)]">
            {formatScore(oai.composite)}
          </p>
          <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
            Equal-weight blend of the governance and wallet halves above.
          </p>
        {:else}
          <p
            class="mt-1 text-3xl font-semibold tabular-nums text-[color:var(--color-text-subtle)]"
            aria-label="Composite pending — waiting on the governance half"
          >
            <span aria-hidden="true">—</span>
          </p>
          <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
            There's no overall index number while one half is pending. The two halves above are
            independently readable.
          </p>
        {/if}
      </div>

      <!-- Wallet half -->
      <div class="rounded-md border border-[color:var(--color-border-default)] p-3">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold tracking-tight">Wallet activity</h3>
          {#if !walletFeesActive}
            <Pill tone="info" size="sm" title="Fee anchoring deferred; v1 uses tx counts only.">
              Tx counts only
            </Pill>
          {/if}
        </div>
        <p class="mt-1 text-3xl font-semibold tabular-nums">
          {formatScore(oai.components.walletScore)}
          <span class="text-base font-normal text-[color:var(--color-text-muted)]">/ 100</span>
        </p>
        <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
          Derived from the 90-day active-day count across the operator's registered wallets. The
          heatmaps above the panel show the day-by-day pattern that drives this score.
        </p>
      </div>
    </div>
  {/if}
</section>
