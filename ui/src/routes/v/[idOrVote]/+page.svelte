<!--
  Validator Hub `/v/[idOrVote]` — PR 1 + PR 2 + PR 3 complete.

  PR 1 shipped:
   - Identity hero with moniker / icon / verified+claim chip / share widget
   - Tier card with TierRing (composite radial + reliability/economic bars)
   - Tenure + Client badges stack
   - Freshness line ("Last refreshed N ago")
   - Action footer (claim CTA OR soft "Manage profile" hint via `?owner=1` / sessionStorage)

  PR 2 added:
   - OAI panel (governance + wallet + composite tile; honest pending state)
   - Wallet activity heatmap per registered operator wallet (53×7 grid,
     log-bucketed intensity, brightest-day star, today outline)
   - Claim audit timeline (latest 5 inline + lazy `<details>` for older,
     identity-rotation `role="alert"` warning)
   - CSR fan-out with AbortController + per-surface failure tiles +
     `afterNavigate` reset for param-only navigation

  PR 3 adds:
   - Income summary strip (lifetime / 30d / 7d KPI + 16-epoch sparkline
     + deep-link to `/income/[id]` for the full epoch table)
   - SIMD curations section (count=0 hidden; AI-summary cards)
   - Sticky mobile header (IntersectionObserver-driven; moniker + tier
     pill + claim CTA when hero scrolls past)
   - Canonical URL is now `/v/[id]`; the income page keeps a back-
     breadcrumb so operators drilling down can hop back

  Plan reference: `/Users/jjangg96/.claude/plans/adaptive-nibbling-ocean.md`.

  Design principles honoured:
   - Per-component breakdown is mandatory: TierRing always shows the
     two sub-component bars next to the composite; OaiPanel surfaces
     governance + wallet halves alongside the composite tile.
   - No half-shown scores: `composite: null` paints the ring as a faint
     stroke + em-dash, never a fake "0".
   - Cold-start = "shorter page, not sadder": identity, tier, tenure,
     client, share widget all work without claim/OAI/wallet/audit data.
   - Visitor-safe: no trusted-owner state. `?owner=1` and
     sessionStorage are SOFT UI hints only — every byte is safe for
     any visitor.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { onDestroy, onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';

  import Card from '$lib/components/Card.svelte';
  import Button from '$lib/components/Button.svelte';
  import Pill from '$lib/components/Pill.svelte';
  import VerifiedBadge from '$lib/components/VerifiedBadge.svelte';
  import EllipsisAddress from '$lib/components/EllipsisAddress.svelte';
  import TierBadge from '$lib/components/TierBadge.svelte';
  import TierRing from '$lib/components/TierRing.svelte';
  import TenureBadge from '$lib/components/TenureBadge.svelte';
  import ClientBadge from '$lib/components/ClientBadge.svelte';
  import ShareWidget from '$lib/components/ShareWidget.svelte';
  import OaiPanel from '$lib/components/OaiPanel.svelte';
  import ActivityHeatmap from '$lib/components/ActivityHeatmap.svelte';
  import AuditLogList from '$lib/components/AuditLogList.svelte';
  import IncomeSummaryStrip from '$lib/components/IncomeSummaryStrip.svelte';
  import SimdProposalCard from '$lib/components/SimdProposalCard.svelte';
  import StickyHubHeader from '$lib/components/StickyHubHeader.svelte';

  import {
    TIER_LABEL,
    isReliabilityFloorTriggered,
    skipRate,
    trustSummary,
    unratedReason,
  } from '$lib/tier';
  import { formatTimestamp, lamportsStringToSolNumber } from '$lib/format';
  import { SITE_URL } from '$lib/site';
  import { safeOperatorUrl } from '$lib/url-safety';
  import {
    fetchClaimAudit,
    fetchClaimStatus,
    fetchOperatorWalletActivity,
    fetchSimdProposals,
  } from '$lib/api';
  import type {
    ClaimAuditEvent,
    ClaimStatus,
    OperatorWalletActivityResponse,
    SimdProposalListItem,
  } from '$lib/types';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const scoring = $derived(data.scoring);
  const history = $derived(data.history);

  // Operator narrative — short note authored by the validator's
  // operator (claim flow stores it on `profile.narrativeOverride`).
  // The income page already renders this; the hub now mirrors it
  // because PR3's canonical flip moved the SEO surface here. A
  // missing narrative leaves the section absent — no placeholder.
  const operatorNarrative = $derived.by<string | null>(() => {
    const override = history?.profile?.narrativeOverride;
    if (override !== null && override !== undefined && override.trim().length > 0) {
      return override.trim();
    }
    return null;
  });

  // Identity rendering — falls back to a truncated vote pubkey when
  // the validator hasn't published a moniker via validator-info.
  const moniker = $derived(history?.name ?? null);
  const shortVote = $derived(`${scoring.vote.slice(0, 4)}…${scoring.vote.slice(-4)}`);
  const heroTitle = $derived(moniker ?? shortVote);

  // Icon-load fallback — when the on-chain `icon_url` 404s or is
  // blocked by `referrerpolicy`, the initial-letter chip kicks in.
  // Use `Array.from(...)` so Korean / non-BMP graphemes don't split.
  const initialForFallback = $derived(
    moniker ? (Array.from(moniker)[0] ?? '?').toUpperCase() : shortVote.slice(0, 1).toUpperCase(),
  );
  let iconLoadFailed = $state(false);
  // `safeOperatorUrl` lifted to `$lib/url-safety.ts` so the hub and
  // the income page share one canonical gate (icon + website URLs).
  // See the helper's docstring for the full rejection list.
  const safeIconUrl = $derived(safeOperatorUrl(history?.iconUrl));

  // Soft owner hint — sessionStorage flag set after a successful claim
  // flow + the `?owner=1` query param. NEITHER is a trusted owner
  // boundary; we only use them to surface a "Manage profile" CTA.
  // Every byte rendered on this page must be safe for ANY visitor.
  //
  // sessionStorage rather than localStorage so the hint clears when
  // the browser/tab closes — a shared computer can't surface a
  // misleading "Manage profile" CTA to a subsequent user just because
  // someone earlier completed the claim flow.
  let isOwnerHint = $state(false);

  // CSR-deferred panel data — claim status + audit + per-wallet
  // activity. None of these block the initial paint; the hero +
  // tier card + tenure/client render from the SSR `/scoring`
  // payload, then these fill in as their fetches resolve.
  //
  // Three failure dimensions, each tracked separately so the UI can
  // tell "loaded successfully but empty" apart from "fetch failed":
  //   - loading: request in-flight (skeleton)
  //   - failed:  request rejected (error tile + retry hint)
  //   - data:    fulfilled value (the real render)
  // Mirroring this shape across all three surfaces is what closes the
  // "audit-empty-OR-broken renders the same" silent-failure class.
  let claimStatus = $state<ClaimStatus | null>(null);
  let claimStatusLoading = $state(true);
  let claimStatusFailed = $state(false);
  let auditEvents = $state<ClaimAuditEvent[]>([]);
  let auditLoading = $state(true);
  let auditFailed = $state(false);
  let walletActivity = $state<Map<string, OperatorWalletActivityResponse>>(new Map());
  // Per-wallet failure tracking — when one wallet's activity request
  // rejects (5xx, network), we render an error tile for THAT wallet
  // instead of silently dropping its heatmap. Other wallets still
  // render their own state independently.
  let walletActivityFailed = $state<Set<string>>(new Set());
  let walletActivityLoading = $state(true);
  // SIMD proposals — fetched as a CSR (the homepage hits the same
  // endpoint, so an SSR fetch here would double-charge per-IP
  // budget for the common 'visit homepage → click hub link' flow).
  // Section is hidden when `simdItems` is empty: the AI-curation
  // job ships separately, so an unshipped feed is the common case
  // today.
  let simdItems = $state<ReadonlyArray<SimdProposalListItem>>([]);
  let simdLoading = $state(true);
  // Hero sentinel for the sticky mobile header — set on a 1×1 div
  // at the bottom of the hero card via `bind:this`. IntersectionObserver
  // watches it; once it scrolls out of view, the header appears.
  let heroSentinel = $state<HTMLElement | null>(null);

  // Active AbortController for the current vote's CSR fan-out. Held
  // outside `onMount` so `afterNavigate` (param-only nav) can abort
  // the prior page's in-flight requests before kicking off the new
  // wave. Without this the previous validator's wallet activity
  // could land AFTER the new validator's, poisoning the panel.
  let fanOutCtrl: AbortController | null = null;
  // The vote pubkey the current fan-out was kicked off for. Used
  // by `afterNavigate` to skip needless re-fans when the user
  // anchor-jumps inside the same `/v/[vote]` page (every same-page
  // nav re-fired the entire wave previously — 6-15 wasted requests
  // per leaderboard-browse churn).
  let lastFanOutVote: string | null = null;

  /** Reset every CSR-deferred state slot — used on first mount AND every param-only nav. */
  function resetCsrState(): void {
    claimStatus = null;
    claimStatusLoading = true;
    claimStatusFailed = false;
    auditEvents = [];
    auditLoading = true;
    auditFailed = false;
    walletActivity = new Map();
    walletActivityFailed = new Set();
    walletActivityLoading = true;
    simdItems = [];
    simdLoading = true;
  }

  /**
   * Drive the two-wave CSR fan-out for `vote`. Each request honours
   * the shared `signal`; if the user navigates away before it
   * completes, the controller aborts and the resulting rejection
   * (with `name: 'AbortError'`) is intentionally ignored so we
   * don't paint a stale error tile after teardown.
   */
  async function loadCsrPanels(vote: string, signal: AbortSignal): Promise<void> {
    // Wave 1 — claim status + audit log. Independent; allSettled so a
    // failed audit doesn't mask the wallet section. Wave 2 fans out
    // as SOON as Wave 1's claim half resolves (not after the
    // allSettled join), so a slow audit doesn't serialize the
    // heatmaps behind it.
    const claimPromise = fetchClaimStatus(vote, { signal }).then(
      (v) => ({ ok: true as const, value: v }),
      (err: unknown) => ({ ok: false as const, error: err }),
    );
    const auditPromise = fetchClaimAudit(vote, { signal }).then(
      (v) => ({ ok: true as const, value: v }),
      (err: unknown) => ({ ok: false as const, error: err }),
    );
    // SIMD proposals are validator-independent — same response on every
    // hub page — but kept inside this fan-out so it gets the same
    // AbortController teardown semantics + can fire in parallel with
    // claim+audit. A `count: 0` response (the unshipped-feed common
    // case today) hides the section entirely.
    const simdPromise = fetchSimdProposals({ limit: 6 }, { signal }).then(
      (v) => ({ ok: true as const, value: v }),
      (err: unknown) => ({ ok: false as const, error: err }),
    );

    // Start Wave 2 as soon as the wallet list lands.
    const walletWavePromise = claimPromise.then(async (claim) => {
      if (signal.aborted) return;
      const wallets = claim.ok ? claim.value.wallets.entries : [];
      if (wallets.length === 0) {
        walletActivityLoading = false;
        return;
      }
      const settled = await Promise.allSettled(
        wallets.map((w) => fetchOperatorWalletActivity(w.wallet, 365, { signal })),
      );
      if (signal.aborted) return;
      const nextMap = new Map<string, OperatorWalletActivityResponse>();
      const nextFailed = new Set<string>();
      settled.forEach((r, i) => {
        const wallet = wallets[i];
        if (wallet === undefined) return;
        if (r.status === 'fulfilled') nextMap.set(wallet.wallet, r.value);
        else if (!isAbortError(r.reason)) nextFailed.add(wallet.wallet);
      });
      walletActivity = nextMap;
      walletActivityFailed = nextFailed;
      walletActivityLoading = false;
    });

    const [claim, audit, simd] = await Promise.all([claimPromise, auditPromise, simdPromise]);
    if (signal.aborted) return;

    if (claim.ok) {
      claimStatus = claim.value;
    } else if (!isAbortError(claim.error)) {
      claimStatusFailed = true;
    }
    claimStatusLoading = false;

    if (audit.ok) {
      auditEvents = audit.value.events;
    } else if (!isAbortError(audit.error)) {
      auditFailed = true;
    }
    auditLoading = false;

    // SIMD failure is silent — the section is hidden when the list is
    // empty anyway, and the curator job being down doesn't change a
    // delegator's trust signal. No error tile here.
    if (simd.ok) simdItems = simd.value.items;
    simdLoading = false;

    // If Wave 1's claim rejected we still need to flip Wave 2's
    // loading flag — the walletWavePromise's short-circuit on
    // `wallets.length === 0` does it, but only when claim resolved
    // with an empty entries list. On a Wave 1 rejection wallets is
    // []  (same path).
    await walletWavePromise;
  }

  /** True when an unknown error is the rejection from a deliberate AbortController.abort(). */
  function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
  }

  /**
   * Re-run the soft owner hint detection. Called on first mount AND
   * on every param-only nav — a delegator hopping from /v/A to /v/B
   * needs B's owner hint, not A's.
   */
  function refreshOwnerHint(vote: string): void {
    isOwnerHint = false;
    try {
      const url = new URL(page.url.href);
      if (url.searchParams.get('owner') === '1') {
        isOwnerHint = true;
        return;
      }
      const key = `whoearns:owned:${vote}`;
      if (sessionStorage.getItem(key) === '1') {
        isOwnerHint = true;
      }
    } catch {
      // Private mode / SSR — hint stays off. Any boundary that
      // actually needs auth should use the claim flow's offline
      // signing, not this UI hint.
    }
  }

  onMount(() => {
    refreshOwnerHint(scoring.vote);
    fanOutCtrl = new AbortController();
    lastFanOutVote = scoring.vote;
    void loadCsrPanels(scoring.vote, fanOutCtrl.signal);
  });

  // SvelteKit reuses the same component instance across param-only
  // navigation (`/v/A` → `/v/B`), so `onMount` only fires on first
  // mount. Without a reset hook the previous validator's wallet
  // pubkeys + audit timeline would persist on the new page. The
  // `afterNavigate` callback runs after every successful nav AND
  // skips the first-mount case (delivered by `onMount` above).
  //
  // The same-vote guard skips a same-page anchor click (e.g. share
  // widget's URL replace, browser back to the same vote) — `nav`
  // fires on every successful navigation regardless of param
  // change, so without the equality check we re-fired the entire
  // fan-out for every in-page anchor jump.
  afterNavigate((nav) => {
    // Skip first mount — onMount already kicked things off.
    if (nav.from === null) return;
    // Skip same-vote navs (anchor jumps, identical URL). The
    // `scoring.vote` is the param the SSR load resolved; it stays
    // canonical across vote↔identity route lookups.
    if (lastFanOutVote === scoring.vote) return;
    fanOutCtrl?.abort();
    fanOutCtrl = new AbortController();
    lastFanOutVote = scoring.vote;
    resetCsrState();
    refreshOwnerHint(scoring.vote);
    void loadCsrPanels(scoring.vote, fanOutCtrl.signal);
  });

  // Cleanup on unmount — aborts any in-flight fetch so we don't
  // burn the per-IP rate-limit budget on a tab the user closed.
  onDestroy(() => {
    fanOutCtrl?.abort();
    fanOutCtrl = null;
  });

  // Tier card — derive everything from the scoring response. The
  // unrated-reason resolver explains WHICH gate fired so the pill
  // tooltip is honest.
  const tier = $derived(scoring.tier);
  const tierWindow = $derived(scoring.tier.window);
  const tierComponents = $derived(scoring.tier.components);
  const reliabilityFloor = $derived(
    isReliabilityFloorTriggered({
      slotsAssigned: tierWindow.slotsAssigned,
      slotsSkipped: tierWindow.slotsSkipped,
    }),
  );
  const tierLabel = $derived(TIER_LABEL[tier.tier]);
  const isUnrated = $derived(tier.tier === 'unrated');

  /**
   * True when the SSR history payload has zero closed-epoch rows
   * with any income data. Matches `IncomeSummaryStrip`'s internal
   * `isColdStart` derivation; surfaced here so the parent can
   * decide whether to render the strip at all (we skip when
   * unrated + no income, to avoid duplicating the tier card's
   * "this validator is brand-new" message).
   */
  const historyIsColdStart = $derived.by<boolean>(() => {
    if (history === null) return true;
    for (const row of history.items) {
      if (row.isFinal !== true) continue;
      if (row.blockFeesTotalLamports !== null) return false;
      if (row.blockTipsTotalLamports !== null) return false;
    }
    return true;
  });
  const reason = $derived(isUnrated ? unratedReason(scoring.tier) : null);

  // Skip rate for the trust summary line — point estimate, not Wilson
  // upper (the hub's hero summary is for-humans context, not the
  // pessimistic floor that drives the tier).
  const skipRateValue = $derived(skipRate(tierWindow));

  // Income last 30d — SSR-aggregated LAMPORTS total. Convert to SOL
  // via `lamportsStringToSolNumber` before formatting. Earlier
  // revision passed the lamports string directly to `formatSolFixed`
  // (which assumes SOL input) — that inflated the trust-summary
  // line by 10⁹×. The bug was latent since PR1 because the hub
  // wasn't the canonical surface; PR3's canonical flip surfaced it.
  const incomeLast30dSol = $derived.by(() => {
    if (data.incomeLast30dLamports === null) return null;
    const sol = lamportsStringToSolNumber(data.incomeLast30dLamports);
    return sol === null ? null : sol.toFixed(3);
  });

  // Trust summary one-liner under the hero title. When fields are
  // missing the resolver renders em-dashes — never fake values.
  const trustLine = $derived(
    trustSummary({
      tierLabel,
      tenureBadge: scoring.tenure.badge,
      clientKind: scoring.client.kind,
      clientVersion: scoring.client.version,
      skipRate: skipRateValue,
      incomeLast30dSol: incomeLast30dSol,
    }),
  );

  // Freshness — oldest of the two relevant timestamps so the line
  // honestly reports the WORST-case staleness. `formatTimestamp`
  // emits "3 min ago"-style relative copy.
  const freshnessIso = $derived.by(() => {
    const fees = tierWindow.incomeFreshness;
    const client = scoring.client.updatedAt;
    if (fees === null && client === null) return null;
    if (fees === null) return client;
    if (client === null) return fees;
    return Date.parse(fees) <= Date.parse(client) ? fees : client;
  });
  const freshnessLabel = $derived(formatTimestamp(freshnessIso));

  // Claim state — drives the verified badge + footer CTA + audit
  // panel visibility. We prefer the `/v1/claims/:vote` response
  // (`claimStatus.claimed`) because it's the AUTHORITATIVE claim
  // boolean: opted-out and identity-drifted claims are still claimed
  // (their `oai` is null but their audit log + claim history must
  // still surface for delegators). Until Wave 1 lands we fall back
  // to the `/scoring.oai !== null` proxy — the SSR knows that much.
  //
  // Why two signals: SCORING is SSR (fast, but reductively gates on
  // OAI eligibility), claimStatus is CSR (truthful, but arrives a
  // tick later). The hub paints with the SSR proxy first and
  // upgrades to the truth as soon as the CSR fetch resolves.
  const isClaimed = $derived(claimStatus !== null ? claimStatus.claimed : scoring.oai !== null);

  // External website — operator-supplied, treat untrusted. HTTPS
  // only (was previously http: OR https:, but mixed content on a
  // delegator-trust surface is the wrong default; a delegator
  // clicking through to an http:// site sees a browser security
  // warning, which is the opposite of what we want on a tier page).
  // Same posture as `safeIconUrl` — HTTPS + real-domain shape only.
  const safeWebsiteUrl = $derived(safeOperatorUrl(history?.website));

  // SEO — concise title + description that pulls the tier into the
  // crawlable text without making it the whole page name. Matches
  // the income page's `<svelte:head>` pattern. The bullet `•` here
  // matches the in-page trust line typography (the legacy mid-dot
  // `·` was a deliberate avoid because Korean treats it as a
  // division mark — see `tier.ts`).
  const seoTitle = $derived(`${heroTitle} • ${tierLabel} tier • WhoEarns Live`);
  // Sentence-form description so the Google SERP snippet reads as
  // prose rather than a cryptic bullet list. The hub trust line
  // stays as the visible hero copy (compact for in-page reading);
  // crawlers + accessibility tools get the wider context here.
  const seoDescription = $derived.by(() => {
    const tenure = scoring.tenure.badge;
    const client =
      scoring.client.version === null
        ? scoring.client.kind
        : `${scoring.client.kind} ${scoring.client.version}`;
    const tier = isUnrated
      ? 'currently rated unrated'
      : `currently ranked ${tierLabel.toLowerCase()} tier`;
    const skip =
      skipRateValue === null ? '' : ` Recent skip rate: ${(skipRateValue * 100).toFixed(2)}%.`;
    const income =
      incomeLast30dSol === null ? '' : ` Block income last month: ◎${incomeLast30dSol} SOL.`;
    return `${heroTitle} is a Solana validator ${tier} (${tenure} tenure, running ${client}).${skip}${income}`;
  });
</script>

<svelte:head>
  <title>{seoTitle}</title>
  <meta name="description" content={seoDescription} />
  <meta property="og:title" content={seoTitle} />
  <meta property="og:description" content={seoDescription} />
  <meta property="og:url" content="{SITE_URL}/v/{scoring.vote}" />
  <meta property="og:image" content="{SITE_URL}/og/{scoring.vote}.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <!--
    Canonical points at the income page (`/income/<vote>`). Site
    naming (whoearns.live) + the leaderboard's income-sorted default
    establish per-validator earnings as the primary surface; this hub
    is the secondary "operator profile" view. Pointing canonical
    there avoids the hub competing for the same query as income when
    both surfaces describe the same validator. The hub still indexes
    via its own URL; canonical just tells search engines which to
    prefer for ranking attribution.
  -->
  <link rel="canonical" href="{SITE_URL}/income/{scoring.vote}" />
</svelte:head>

<!-- ─────────── 1. Identity hero ─────────── -->
<Card tone="raised">
  <div class="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
    <div class="flex min-w-0 flex-1 items-start gap-4">
      <!-- Logo tile (48px) — falls back to first grapheme. -->
      <div
        class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]"
        aria-hidden="true"
      >
        {#if safeIconUrl && !iconLoadFailed}
          <img
            src={safeIconUrl}
            alt=""
            class="h-full w-full object-cover"
            loading="eager"
            referrerpolicy="no-referrer"
            onerror={() => {
              iconLoadFailed = true;
            }}
          />
        {:else}
          <span class="text-xl font-semibold text-[color:var(--color-brand-500)]">
            {initialForFallback}
          </span>
        {/if}
      </div>

      <div class="min-w-0 flex-1">
        <p
          class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]"
        >
          Validator
        </p>
        <h1
          class="mt-1 flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl"
          aria-label={moniker
            ? `${moniker} (${scoring.vote})`
            : `Validator vote pubkey ${scoring.vote}`}
        >
          <span class="truncate">{heroTitle}</span>
          {#if isClaimed}
            <VerifiedBadge
              size={18}
              label="Verified — claim signed with the validator identity key (Ed25519)"
            />
          {/if}
        </h1>
        <p class="mt-0.5">
          <EllipsisAddress
            pubkey={scoring.vote}
            class="font-mono text-xs text-[color:var(--color-text-subtle)]"
          />
        </p>

        <!--
          Trust summary one-liner — the hub's scannable hero line.
          Plain emphasized text at every breakpoint. An earlier
          revision gave it a bordered "chip" frame only at `lg:`;
          a frame that exists on one breakpoint and vanishes on
          another is an inconsistent component, not a responsive
          one. `text-base font-medium text-default` carries enough
          weight on its own — the line IS the hero's payload, it
          doesn't need a box.
        -->
        <p
          class="mt-3 text-base font-medium text-[color:var(--color-text-default)]"
          data-testid="trust-summary"
        >
          {trustLine}
        </p>

        {#if safeWebsiteUrl}
          <p class="mt-2 text-xs">
            <a
              href={safeWebsiteUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              class="text-[color:var(--color-brand-500)] hover:underline"
            >
              {safeWebsiteUrl}
            </a>
          </p>
        {/if}

        <!--
          Freshness — oldest income/client timestamp in the window.
          12px (`text-xs`) at `--color-text-muted` clears WCAG 1.4.3
          comfortably; the previous 11px / `text-subtle` combo
          sat just under the floor on the freshness path, which is
          one of the more delegator-critical lines on the page.
        -->
        {#if freshnessLabel}
          <p class="mt-2 text-xs text-[color:var(--color-text-muted)]">
            Last refreshed {freshnessLabel}
          </p>
        {/if}
      </div>
    </div>

    <!-- Share widget — top-right of hero on desktop, stacked on mobile. -->
    <div class="flex shrink-0 items-start justify-end">
      <ShareWidget
        vote={scoring.vote}
        siteUrl={SITE_URL}
        tierLabel="{tierLabel} tier"
        display={moniker ?? undefined}
      />
    </div>
  </div>

  <!--
    Sentinel for StickyHubHeader's IntersectionObserver — a zero-
    height element at the END of the hero card. Once the user
    scrolls past it, the sticky bar at the top appears (mobile
    only). No visual presence; pure observation target.
  -->
  <div bind:this={heroSentinel} aria-hidden="true" style="height: 0;"></div>
</Card>

<StickyHubHeader
  moniker={heroTitle}
  tier={tier.tier}
  {tierLabel}
  vote={scoring.vote}
  {isClaimed}
  {isOwnerHint}
  sentinel={heroSentinel}
/>

<!--
  Operator narrative — short note authored by the operator via the
  claim flow. The income page already surfaces this; mirroring on
  the hub keeps the trust signal on the now-canonical surface.
  Hidden when no narrative is set.

  `aria-label="Operator note"` so screen readers announce the
  landmark with attribution (matches the income page's
  `<section aria-label="Operator note">` pattern). The muted text
  tone disambiguates it visually from system copy — operator
  prose, not editorial.
-->
{#if operatorNarrative !== null}
  <Card tone="panel" class="mt-6" ariaLabelledby="operator-note-heading">
    <p
      id="operator-note-heading"
      class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
    >
      Operator note
    </p>
    <p class="mt-2 text-sm leading-relaxed text-[color:var(--color-text-muted)]">
      {operatorNarrative}
    </p>
  </Card>
{/if}

<!-- ─────────── 2. Tier card + Tenure/Client stack ─────────── -->
<!--
  col-7 / col-5 split (was col-8 / col-4). The Tier card is dense
  (ring + bars + warn chip + reason line + window-detail expander)
  and reads well at slightly less width; the Tenure/Client stack
  has roomy badges and a one-line subtext each, so it benefits
  from the extra ~8% width. Old ratio left the right column
  looking under-filled relative to the left.
-->
<div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
  <!-- Tier card — col-span-7 on desktop. -->
  <div class="lg:col-span-7">
    <Card tone="panel">
      <div class="flex flex-col gap-4">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-lg font-semibold tracking-tight">Node Tier</h2>
          <Pill tone={isUnrated ? 'neutral' : 'brand'} size="sm">
            <TierBadge tier={tier.tier} size={12} label="" />
            <span class="ml-1">{tierLabel}</span>
          </Pill>
        </div>

        <!--
          `size={144}` overrides the component default of 160px so
          the ring uses ~38% of an iPhone SE viewport (375px) rather
          than 43%. Desktop has plenty of horizontal breathing room
          at this size; mobile feels less cramped. A larger size on
          desktop isn't necessary — the surrounding card width
          already implies "this is the focal point of the section."
        -->
        <TierRing
          tier={tier.tier}
          composite={tier.composite}
          reliability={tierComponents.reliability}
          economicPercentile={tierComponents.economicPercentile}
          floorTriggered={reliabilityFloor}
          unratedReason={reason ?? undefined}
          size={144}
        />

        {#if reliabilityFloor}
          <!--
            Skip-rate-floor explanation chip. Renders ONLY when the
            reliability floor fired — explains WHY the tier was
            capped independently of economic productivity. Promoted
            to a `role="status"` warn-tone banner (not muted text)
            because a delegator skimming the page must NOT miss
            that the tier classification reflects a hard floor, not
            the economic half of the composite.
          -->
          <div
            class="flex items-start gap-2 rounded-md border border-[color:var(--color-status-warn-fg)]/30 bg-[color:var(--color-status-warn-bg)] px-3 py-2 text-sm font-medium text-[color:var(--color-status-warn-fg)]"
            role="status"
          >
            <span aria-hidden="true">⚠</span>
            <span>
              Skip rate {(
                (tierWindow.slotsSkipped / Math.max(1, tierWindow.slotsAssigned)) *
                100
              ).toFixed(1)}% — too high to rate above the lowest tier.
            </span>
          </div>
        {/if}

        {#if reason}
          <p class="text-xs text-[color:var(--color-text-muted)]">{reason}</p>
        {/if}

        <details class="text-xs">
          <summary
            class="inline-flex min-h-11 cursor-pointer items-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-default)]"
          >
            How this tier was scored
          </summary>
          <!--
            Plain-English labels. Earlier revision used internal
            engineering vocabulary ("Cohort size", "Measured epochs",
            "Cohort window") which a delegator doesn't recognise.
            The plain labels here are the same scope but readable.
          -->
          <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[color:var(--color-text-muted)]">
            <dt>Window length (epochs)</dt>
            <dd class="tabular-nums">{tierWindow.epochs}</dd>
            <dt>Peers compared</dt>
            <dd class="tabular-nums">{tierWindow.economicCohortSize.toLocaleString()}</dd>
            <dt>Epochs with income</dt>
            <dd class="tabular-nums">{tierWindow.economicMeasuredEpochs}</dd>
            {#if tierWindow.cohortAsOfEpoch}
              <dt>Peer-group epoch range</dt>
              <dd class="tabular-nums">
                {tierWindow.cohortAsOfEpoch.fromEpoch}–{tierWindow.cohortAsOfEpoch.toEpoch}
              </dd>
            {/if}
          </dl>
        </details>
      </div>
    </Card>
  </div>

  <!-- Tenure + Client stack — col-span-5 on desktop. -->
  <div class="flex flex-col gap-6 lg:col-span-5">
    <Card tone="panel">
      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold tracking-tight">Tenure</h2>
        <TenureBadge tenure={scoring.tenure} size="md" />
        <!--
          `tenure.firstSeenEpoch` carries the validator's TRUE first
          epoch with stake when the stakewiz ingester has backfilled
          `genesis_epoch`, falling back to the indexer-relative
          first-seen epoch otherwise — hence "Active since", not
          "First seen". Mainnet epoch ≈ 2 days; the day-count gloss
          makes the epoch number legible without teaching epoch math.
        -->
        <p class="text-xs text-[color:var(--color-text-muted)]">
          Active since epoch <span class="tabular-nums">{scoring.tenure.firstSeenEpoch}</span> ·
          <span class="tabular-nums">{scoring.tenure.activeEpochs.toLocaleString()}</span>
          epochs (~{(scoring.tenure.activeEpochs * 2).toLocaleString()}d).
        </p>
      </div>
    </Card>

    <Card tone="panel">
      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold tracking-tight">Client</h2>
        <ClientBadge client={scoring.client} size="md" />
        <!--
          "Gossip" was internal Solana protocol vocabulary; the
          earlier rename to "last verified" was wrong in the
          opposite direction — `verified` is reserved in this
          project for cryptographic attestations (claim ceremony,
          gist proof, dual-signature wallet). Gossip-reported
          client banner is unauthenticated; calling it "verified"
          implicitly promotes its trust signal. `last seen` is
          accurate (we observed this self-reported value on the
          cluster) without overloading the verified verb.
        -->
        {#if scoring.client.updatedAt !== null}
          <p class="text-xs text-[color:var(--color-text-muted)]">
            Version last seen {formatTimestamp(scoring.client.updatedAt)}.
          </p>
        {:else}
          <p class="text-xs text-[color:var(--color-text-muted)]">Version not yet observed.</p>
        {/if}
      </div>
    </Card>
  </div>
</div>

<!--
  ─────────── 3. Income summary strip ───────────

  Lifetime / 30d / 7d KPIs + a 16-epoch sparkline. Driven entirely
  from the SSR `/history` rows so there's no extra fetch. The deep
  link sends a viewer to `/income/[vote]` for the full epoch table
  (the hub's hierarchy is "at-a-glance"; the income page is "drill
  down"). Hidden entirely when `history` is null (brand-new
  validator with no rows — `/income/[vote]` will show the
  tracking-hand-off banner if the visitor follows the deep link).
-->
<!--
  IncomeSummaryStrip rendered only when there's something to say.
  An unrated validator with zero closed epochs has both the
  tier card AND a hypothetical income strip explaining "no data
  yet" — the strip's heading-only fallback was the worst of both
  (longer than nothing, sadder than honest). Hide the whole
  section in that exact case; otherwise render normally (the
  strip's own cold-start prose still fires for rated-but-quiet
  validators).
-->
{#if history !== null && !(isUnrated && historyIsColdStart)}
  <div class="mt-6">
    <IncomeSummaryStrip vote={scoring.vote} items={history.items} />
  </div>
{/if}

<!--
  ─────────── 4. Wallet activity heatmaps ───────────

  Promoted above OAI because the wallet half of the OAI today
  is wallet-only (governance ingest pending in every deployment),
  so the score the OAI publishes is ALREADY summarised here as
  the per-day grid. The PM brief said: "shorter page, not sadder"
  + "audit + heatmaps are the highest-signal delegator surfaces."

  Each registered operator wallet renders its own panel. Cold-
  start renders a CLS-stable skeleton (fixed min-height) so
  panels arriving via Wave 2 don't snap the page. Per-wallet
  rejections (5xx, network) render an explicit error tile —
  silent dropout was the worst version of this.
-->
{#if !claimStatusLoading && claimStatus !== null && claimStatus.wallets.entries.length > 0}
  <section class="mt-6 flex flex-col gap-4" aria-labelledby="wallet-activity-heading">
    <header class="px-1">
      <h2 id="wallet-activity-heading" class="text-lg font-semibold tracking-tight">
        Wallet activity
      </h2>
      <p class="mt-1 text-xs text-[color:var(--color-text-muted)]">
        Daily transactions per registered wallet, last 365 days.
      </p>
    </header>
    {#each claimStatus.wallets.entries as walletEntry (walletEntry.wallet)}
      {@const activity = walletActivity.get(walletEntry.wallet)}
      {@const isFailed = walletActivityFailed.has(walletEntry.wallet)}
      {#if activity !== undefined}
        <ActivityHeatmap
          wallet={walletEntry.wallet}
          label={walletEntry.label}
          entries={activity.entries}
        />
      {:else if isFailed}
        <!--
          Per-wallet failure tile. Distinct from "loading" so a
          delegator can see WHICH wallet's heatmap didn't load.
          `role="status"` for screen-reader announcement.
        -->
        <!--
          `role="status"` implies `aria-live="polite"` +
          `aria-atomic="true"` per ARIA 1.2 — no need to spell out
          both. The earlier explicit `aria-live="polite"` was
          redundant chrome.
        -->
        <div
          class="rounded-lg border border-[color:var(--color-status-warn-fg)]/40 bg-[color:var(--color-status-warn-bg)] p-4 text-sm text-[color:var(--color-status-warn-fg)]"
          role="status"
        >
          Couldn't load activity for <strong>{walletEntry.label}</strong>. The wallet is registered;
          try refreshing the page.
        </div>
      {:else}
        <!--
          Skeleton: matches the heatmap's resting height so panels
          arriving via Wave 2 don't snap the page. `aria-busy="true"`
          tells AT users that the region is mid-load; the static
          "Loading…" text is the visible cue.
        -->
        <div
          class="min-h-[220px] animate-pulse rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4 text-sm text-[color:var(--color-text-muted)]"
          role="status"
          aria-busy="true"
          aria-label="Loading activity for {walletEntry.label}"
        >
          Loading activity for {walletEntry.label}…
        </div>
      {/if}
    {/each}
  </section>
{/if}

<!--
  ─────────── 5. Claim audit timeline ───────────

  Moved above OAI in the section order. For a delegator with an
  8-second skim window the highest-signal warning on the page is
  the identity-rotation reclaim — burying it below a (currently
  governance-pending) OAI panel hid the signal that matters most.

  Gate: `claimStatus.claimed` rather than `scoring.oai !== null`.
  An opted-out or identity-drifted validator still has a public
  audit log (the reclaim row IS the smoking-gun signal); gating
  on OAI eligibility hid those rows from the people who needed
  them most.
-->
{#if !auditLoading && (isClaimed || auditFailed)}
  <div class="mt-6">
    <AuditLogList events={auditEvents} failed={auditFailed} />
  </div>
{:else if auditLoading && (isClaimed || claimStatusLoading)}
  <!--
    Audit skeleton — `min-h-[320px]` reserves close to the actual
    rendered height (5 events × ~52px row + 64px header). Earlier
    180px under-reserved and caused a layout jump every claimed
    validator's hub paint.
  -->
  <div
    class="mt-6 min-h-[320px] animate-pulse rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4 text-sm text-[color:var(--color-text-muted)]"
    role="status"
    aria-busy="true"
    aria-label="Loading claim audit timeline"
  >
    Loading audit timeline…
  </div>
{/if}

<!--
  ─────────── 6. OAI panel (Operator Activity Index) ───────────

  Now BELOW the wallet heatmaps + audit because today's deployment
  serves `governance: null` everywhere (the GitHub-discussions
  ingest is unshipped), and the surface above already summarises
  the wallet half as a per-day grid. When the governance ingest
  ships and OAI publishes a real composite, this section will
  move back up. Same component — only its place in the hierarchy
  changes.
-->
<div class="mt-6">
  <!--
    OAI renders directly from the SSR `scoring.oai` payload — no
    CSR fetch required. Earlier revision gated render on
    `claimStatusLoading`, but the OaiPanel's display state is
    fully derivable from SSR data: `oai === null` collapses to
    the unclaimed-or-pending branch; `oai !== null` renders the
    full panel. Wave 1 only REFINES `isClaimed` (opted-out and
    identity-drifted edge cases), which doesn't change what the
    panel shows. The skeleton was masking a Promise.all that
    blocked the whole panel on the slowest of three fan-out
    requests (SIMD curator latency would delay OAI for no data
    reason).
  -->
  <OaiPanel oai={scoring.oai} claimed={isClaimed} />
</div>

<!--
  ─────────── 7. SIMD curations ───────────

  AI-curated SIMD proposals (`/v1/simd-proposals`). Section is
  hidden entirely when the curator job hasn't published any rows
  yet — `count: 0` is the common case today (the AI-curation
  worker ships separately from the API + UI). On a populated
  response, render up to 6 cards in a 2-column grid on desktop.
-->
<!--
  Always-mounted `role="status"` region so AT users get a single
  short announcement when SIMD cards arrive via Wave 1. Earlier
  revision put `aria-live="polite"` on the conditionally-mounted
  `<section>` itself — live regions only announce CHANGES to a
  pre-existing region, so mounting the region simultaneously with
  its content meant nothing fired. This decoupled status line is
  the standard pattern.
-->
<p class="sr-only" role="status" aria-live="polite">
  {#if !simdLoading && simdItems.length > 0}
    Loaded {simdItems.length}
    {simdItems.length === 1 ? 'recent SIMD proposal' : 'recent SIMD proposals'}.
  {/if}
</p>
{#if !simdLoading && simdItems.length > 0}
  <section class="mt-6 flex flex-col gap-4" aria-labelledby="simd-curations-heading">
    <header class="px-1">
      <h2 id="simd-curations-heading" class="text-lg font-semibold tracking-tight">
        Recent SIMD proposals
      </h2>
      <p class="mt-1 text-xs text-[color:var(--color-text-muted)]">
        AI-curated summaries of recent SIMD proposals.
      </p>
    </header>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {#each simdItems as proposal (proposal.simdNumber)}
        <SimdProposalCard {proposal} />
      {/each}
    </div>
  </section>
{/if}

<!--
  ─────────── 8. Action footer (claim CTA / soft owner hint) ───────────

  Suppressed entirely when the operator opted out of the footer CTA
  (`profile.hideFooterCta === true`) AND the visitor isn't the owner.
  The owner-hint exception keeps "Manage profile" reachable for the
  operator themselves. Earlier revision loaded `data.hideFooterCta`
  on the SSR path but never consumed it on the hub — a silent
  regression of the operator's stored preference now that `/v/[id]`
  is the canonical surface.
-->
{#if !data.hideFooterCta || isOwnerHint}
  <Card tone="accent" class="mt-6">
    <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold tracking-tight">
          {#if isClaimed}Operator dashboard{:else}Are you the operator?{/if}
        </h2>
        <p class="mt-1 text-sm text-[color:var(--color-text-muted)]">
          {#if isClaimed}
            Claimed and verified by the validator's operator.
          {:else}
            Claim with an offline Ed25519 signature to publish a profile and register wallets.
          {/if}
        </p>
      </div>
      <!--
      CTA copy ladder:
        - claimed + owner-hint: PRIMARY "Manage profile" (the operator
          is the only audience that can act on this)
        - unclaimed: GHOST "Operator? Sign to claim" (claim flow
          requires offline Ed25519 — the soft phrasing makes clear
          this is a guarded action, not a casual button for
          delegators who happened to land on the page)
        - claimed + no owner hint: GHOST "Operator? Manage profile"
          (same reasoning — the visitor probably isn't the operator)
    -->
      <div class="flex shrink-0 items-center gap-2">
        {#if isClaimed && isOwnerHint}
          <Button href="/claim/{scoring.vote}" variant="primary" size="md">Manage profile</Button>
        {:else if !isClaimed}
          <Button href="/claim/{scoring.vote}" variant="ghost" size="md"
            >Operator? Sign to claim</Button
          >
        {:else}
          <Button href="/claim/{scoring.vote}" variant="ghost" size="md"
            >Operator? Manage profile</Button
          >
        {/if}
      </div>
    </div>
  </Card>
{/if}
