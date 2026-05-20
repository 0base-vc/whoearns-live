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

<!--
  Full-width section. Earlier revision self-clamped to `col-8`
  (`lg:max-w-[calc((100%/12)*8)]`) under the assumption a sibling
  card would occupy the right `col-4` — but the hub's grid never
  added that sibling, so the clamp produced a visible empty band
  to the right. The OAI is a peer of Wallet-activity / Audit /
  SIMD, all of which render full-width; matching that rhythm.
-->
<section
  class="rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4"
  aria-labelledby="oai-heading"
>
  <header class="flex items-baseline justify-between gap-2 pb-3">
    <!--
      h2 — peer of the other hub sections (Wallet activity, Audit,
      SIMD). The earlier rename to "Operator engagement" was a
      partial relabel that left the same product as
      "Operator Activity Index" in `/claim/[vote]`, `seo.route.ts`,
      `docs/openapi.yaml`, `docs/api.md`, and the URL itself
      (`/v1/validators/{id}/operator-activity-index`). Half-renames
      are worse than no rename: a delegator reads the hub, clicks
      claim, and sees a different name for the same thing. Reverted
      to the canonical "Operator Activity Index (OAI)" name with the
      acronym appended so the score-tile labels below ("Governance",
      "Wallet activity") still read as the breakdown shape.
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
          Vertical stack instead of `grid-cols-3 gap-2`. With the
          tile already 1/3 of a now-full-width panel, the inner
          3-col grid was crushing each cell to ~60-70px and the
          uppercase 14-char labels ("PEER REACTIONS") collided
          into "COMMENTSPEER REACTIONSSIMDS" on the live page.
          One row per label-value pair scales legibly at any
          breakpoint and keeps the same vertical footprint.
        -->
        <dl class="mt-3 space-y-1.5 text-xs text-[color:var(--color-text-muted)]">
          <div class="flex items-baseline justify-between gap-2">
            <dt class="uppercase tracking-wide">SIMD comments</dt>
            <dd class="tabular-nums">{oai.components.governance.commentCount}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="uppercase tracking-wide">Reactions</dt>
            <dd class="tabular-nums">{oai.components.governance.reactionsReceived}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="uppercase tracking-wide">SIMDs engaged</dt>
            <dd class="tabular-nums">{oai.components.governance.activeWindowCount}</dd>
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
          Derived from the 90-day active-day count across the operator's registered wallets. The
          heatmaps above the panel show the day-by-day pattern that drives this score.
        </p>
      </div>
    </div>
  {/if}
</section>
