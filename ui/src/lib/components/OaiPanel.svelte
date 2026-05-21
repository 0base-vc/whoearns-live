<!--
  OaiPanel — Operator Activity Index display.

  The OAI is a Phase 6+7 composite of two halves:
    - Governance score: 0-100, derived from peer-reaction-weighted
      GitHub SIMD discussion comments. NULL today in every real
      deployment because the SIMD-discussions data feed isn't
      live yet.
    - Wallet score: 0-100, derived from registered-wallet daily
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
  import Card from './Card.svelte';
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
   * Format an OAI score for display. The `/scoring` OAI scores —
   * `walletScore`, `governance.score`, `composite` — are ALREADY
   * 0-100 integers (`OaiResult` in `src/types/domain/oai.ts`:
   * `walletScore` is `Math.round(100 * saturate(...))`). An earlier
   * revision multiplied by 100 again here, assuming a 0-1 input —
   * that rendered a real walletScore of 17 as "1700 / 100". This
   * only guards the null case (em-dash, never a fake number — same
   * policy as `TierRing`'s composite label) and rounds defensively.
   */
  function formatScore(score: number | null | undefined): string {
    if (score === null || score === undefined) return '—';
    return `${Math.round(score)}`;
  }
</script>

<!--
  Section shell routes through `Card` (tone="panel") so radius +
  padding match every other hub section — earlier this hand-rolled
  `rounded-lg p-4`, drifting from the `rounded-xl p-5` Card shell.
-->
<Card tone="panel" ariaLabelledby="oai-heading">
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <!--
      h2 — `text-lg`, the standard hub section-heading size. The
      "Operator Activity Index (OAI)" name is the canonical one used
      by `/claim/[vote]`, `seo.route.ts`, `docs/openapi.yaml`, and the
      `/v1/validators/{id}/operator-activity-index` route.
    -->
    <h2 id="oai-heading" class="text-lg font-semibold tracking-tight">
      Operator Activity Index (OAI)
    </h2>
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
    <!-- Unclaimed / opted-out / identity-drifted → no OAI surface. -->
    <p class="text-sm text-[color:var(--color-text-muted)]">
      Not claimed yet — wallet and governance activity appear once an operator claims this
      validator.
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
            <Pill tone="warn" size="sm">Data pending</Pill>
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
        <!--
          One row per label-value pair — sentence-case (not
          uppercase): a small uppercase label nested inside a tile
          inside a panel is a third level of "shouty". The
          `tabular-nums` value carries the emphasis.
        -->
        <dl class="mt-3 space-y-1.5 text-xs text-[color:var(--color-text-muted)]">
          <div class="flex items-baseline justify-between gap-2">
            <dt>SIMD comments</dt>
            <dd class="tabular-nums">{oai.components.governance.commentCount}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt>Reactions</dt>
            <dd class="tabular-nums">{oai.components.governance.reactionsReceived}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt>SIMDs engaged</dt>
            <dd class="tabular-nums">{oai.components.governance.activeWindowCount}</dd>
          </div>
        </dl>
        {#if !governanceActive}
          <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
            The SIMD-discussions feed isn't live yet.
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
            Equal-weight blend of the two halves.
          </p>
        {:else}
          <p
            class="mt-1 text-3xl font-semibold tabular-nums text-[color:var(--color-text-subtle)]"
            aria-label="Composite pending — waiting on the governance half"
          >
            <span aria-hidden="true">—</span>
          </p>
          <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
            No blend until both halves are in.
          </p>
        {/if}
      </div>

      <!-- Wallet half -->
      <div class="rounded-md border border-[color:var(--color-border-default)] p-3">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="text-sm font-semibold tracking-tight">Wallet activity</h3>
          {#if !walletFeesActive}
            <!--
              Pill copy is "Counts, not fees" so it ADDS information
              to the heading "Wallet activity" instead of tautologously
              echoing it ("Wallet activity · Activity only"). Explains
              what the score is derived from in 3 words.
            -->
            <Pill
              tone="info"
              size="sm"
              title="Counts active days, not fees. Per-day fee weighting ships in a later version."
            >
              Counts, not fees
            </Pill>
          {/if}
        </div>
        <p class="mt-1 text-3xl font-semibold tabular-nums">
          {formatScore(oai.components.walletScore)}
          <span class="text-base font-normal text-[color:var(--color-text-muted)]">/ 100</span>
        </p>
        <p class="mt-3 text-xs text-[color:var(--color-text-muted)]">
          90-day active-day count across registered wallets.
        </p>
      </div>
    </div>
  {/if}
</Card>
