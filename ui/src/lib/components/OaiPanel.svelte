<!--
  OaiPanel — Operator Activity Index display.

  The OAI is a Phase 6+7 composite of two halves:
    - Governance score: 0-1, derived from peer-reaction-weighted
      GitHub SIMD discussion comments. NULL today in every real
      deployment because the SIMD-discussions ingest job is
      unshipped.
    - Wallet score: 0-1, derived from registered-wallet daily
      activity over the last 90 days.

  Honesty in the partial release. Because the governance half is
  null today, `composite` is also null (the API refuses to publish
  a 50/50 blend it can only see one side of). The sub-component
  counts (`commentCount`, `reactionsReceived`, `activeWindowCount`)
  AND `walletScore` are populated as their real values though, so
  a wallet-only delegator still has something to read.

  This panel renders all of that with intentional UI per-half
  branching:
    - When `governanceIngestActive` is false: governance side shows
      a "Discussions ingest pending — coming soon" empty-state.
      Wallet side renders normally.
    - When the validator is not claimed (caller passes
      `claimed=false`): the panel collapses entirely to a single
      claim CTA line. There IS no OAI for a non-claimed validator
      (the API returns `oai: null` on `/scoring`), so the empty-
      panel "shorter page, not sadder" principle applies.

  Per-component breakdown is mandatory: the composite ring isn't a
  thing here — instead two stacked KpiStat tiles surface each
  half's score, and a third tile shows the composite (null →
  em-dash). The governance counts are exposed below as tabular
  context so a delegator can see what's driving the score even
  before the ingest activates.

  Props:
    - `oai`: the OAI components block from /scoring (null when
      validator is unclaimed / opted-out / identity-drifted)
    - `claimed`: hint from the caller to render the empty-claim
      state cleanly. When `oai === null && claimed === true` the
      panel is still in the "claimed but ingest pending" state.
-->
<script lang="ts">
  import type { OaiComponents } from '$lib/types';
  import Button from './Button.svelte';
  import Pill from './Pill.svelte';

  interface Props {
    oai: OaiComponents | null;
    claimed: boolean;
    /** Vote pubkey, used to build the "Claim this validator" link. */
    vote: string;
  }

  let { oai, claimed, vote }: Props = $props();

  // The governance ingest is gated behind a backend job that ships
  // separately from this UI. `ingestStatus.governanceIngestActive`
  // tells us whether the comment data has actually been written to
  // the DB yet — if false, we can't honestly report a score, so
  // the half renders as a "coming soon" empty-state instead of a
  // misleading 0.
  const governanceActive = $derived(oai?.ingestStatus?.governanceIngestActive ?? false);
  const walletFeesActive = $derived(oai?.ingestStatus?.walletFeesIngestActive ?? false);

  // Format a 0-1 score as a percentage. `null` renders as an
  // em-dash so we never display a fake number. (Mirrors the
  // TierRing's central composite label policy.)
  function formatScore(score: number | null | undefined): string {
    if (score === null || score === undefined) return '—';
    return `${(score * 100).toFixed(0)}`;
  }
</script>

<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-label="Operator Activity Index"
>
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <h3 class="text-base font-semibold tracking-tight">Operator Activity Index</h3>
    {#if oai !== null}
      <Pill tone={oai.composite === null ? 'neutral' : 'brand'} size="sm">
        OAI {formatScore(oai.composite)}
      </Pill>
    {/if}
  </header>

  {#if !claimed || oai === null}
    <!--
      Unclaimed (or opted-out / identity-drifted, which the API
      collapses) → no OAI surface to render. Collapse to a single
      claim-CTA line per the "shorter page, not sadder" principle.
      The CTA is GHOST (not primary) for the same reason the
      footer claim CTA is ghost — most visitors aren't the operator.
    -->
    <p class="text-sm text-[color:var(--color-text-muted)]">
      OAI is published only for claimed validators. The operator must complete the offline Ed25519
      claim flow to surface governance + wallet activity scoring.
    </p>
    <div class="mt-3">
      <Button href="/claim/{vote}" variant="ghost" size="sm">Operator? Sign to claim</Button>
    </div>
  {:else}
    <!--
      Claimed + OAI present. Render the two halves side-by-side on
      desktop, stacked on mobile. Each half discloses its ingest
      state honestly: governance shows "coming soon" when the
      DB-level data isn't there yet; wallet shows its real score
      regardless of the wallet-fees-ingest state (since v1 only
      uses tx counts, the fees ingest doesn't gate the score).
    -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <!-- Governance half -->
      <div class="rounded-md border border-[color:var(--color-border-default)] p-3">
        <div class="flex items-baseline justify-between gap-2">
          <h4 class="text-sm font-semibold tracking-tight">Governance</h4>
          {#if !governanceActive}
            <Pill tone="warn" size="sm">Ingest pending</Pill>
          {/if}
        </div>
        {#if governanceActive}
          <p class="mt-1 text-3xl font-semibold tabular-nums">
            {formatScore(oai.components.governance.score)}
            <span class="text-base font-normal text-[color:var(--color-text-subtle)]">/ 100</span>
          </p>
        {:else}
          <p class="mt-1 text-3xl font-semibold tabular-nums text-[color:var(--color-text-subtle)]">
            —
          </p>
        {/if}
        <dl class="mt-3 grid grid-cols-3 gap-2 text-xs text-[color:var(--color-text-muted)]">
          <div>
            <dt class="uppercase tracking-wide text-[color:var(--color-text-subtle)]">Comments</dt>
            <dd class="mt-0.5 tabular-nums">{oai.components.governance.commentCount}</dd>
          </div>
          <div>
            <dt class="uppercase tracking-wide text-[color:var(--color-text-subtle)]">
              Peer reactions
            </dt>
            <dd class="mt-0.5 tabular-nums">{oai.components.governance.reactionsReceived}</dd>
          </div>
          <div>
            <dt class="uppercase tracking-wide text-[color:var(--color-text-subtle)]">
              Active SIMDs
            </dt>
            <dd class="mt-0.5 tabular-nums">{oai.components.governance.activeWindowCount}</dd>
          </div>
        </dl>
        {#if !governanceActive}
          <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
            The GitHub-discussions ingest job is unshipped; the governance score will start
            populating once it goes live. Comment / reaction counts above are accurate-but-zero
            today.
          </p>
        {/if}
      </div>

      <!-- Wallet half -->
      <div class="rounded-md border border-[color:var(--color-border-default)] p-3">
        <div class="flex items-baseline justify-between gap-2">
          <h4 class="text-sm font-semibold tracking-tight">Wallet activity</h4>
          {#if !walletFeesActive}
            <Pill tone="info" size="sm" title="Fee anchoring deferred; v1 uses tx counts only.">
              tx counts
            </Pill>
          {/if}
        </div>
        <p class="mt-1 text-3xl font-semibold tabular-nums">
          {formatScore(oai.components.walletScore)}
          <span class="text-base font-normal text-[color:var(--color-text-subtle)]">/ 100</span>
        </p>
        <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
          Derived from the 90-day active-day count across the operator's registered wallets.
          Heatmaps below show the day-by-day pattern that drives this score.
        </p>
      </div>
    </div>

    {#if oai.composite === null}
      <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
        Composite is <code>null</code> because the 50 / 50 blend can't be honestly reported with the governance
        half pending. The two sub-scores above are independently usable.
      </p>
    {/if}
  {/if}
</section>
