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
    SKIP_RATE_FLOOR,
    TIER_CUTOFFS,
    TIER_LABEL,
    WEIGHT_RELIABILITY,
    WEIGHT_ECONOMIC_PERCENTILE_EFFECTIVE,
    WEIGHT_CU_PERCENTILE_EFFECTIVE,
    WINDOW_CLOSED_EPOCHS,
    isReliabilityFloorTriggered,
    nextTierGap,
    skipRate,
    trustSummary,
    unratedReason,
  } from '$lib/tier';
  import { formatTimestamp, lamportsStringToSolNumber } from '$lib/format';
  import { SITE_URL } from '$lib/site';
  import { safeOperatorUrl } from '$lib/url-safety';
  import { fetchClaimAudit, fetchClaimStatus, fetchSimdProposals } from '$lib/api';
  import type { ClaimAuditEvent, ClaimStatus, NodeTier, SimdProposalListItem } from '$lib/types';
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

  // CSR-deferred panel data — claim status + audit. None of these
  // block the initial paint; the hero + tier card + tenure/client
  // render from the SSR `/scoring` payload, then these fill in as
  // their fetches resolve.
  //
  // Three failure dimensions, each tracked separately so the UI can
  // tell "loaded successfully but empty" apart from "fetch failed":
  //   - loading: request in-flight (skeleton)
  //   - failed:  request rejected (error tile + retry hint)
  //   - data:    fulfilled value (the real render)
  // Mirroring this shape across all three surfaces is what closes the
  // "audit-empty-OR-broken renders the same" silent-failure class.
  //
  // Wallet activity is no longer a separate fan-out: the claim-status
  // fetch is made with `includeActivity: true`, so each registered
  // wallet's 365-day activity arrives inline on
  // `claimStatus.wallets.entries[].activity`. One loading state
  // (`claimStatusLoading`) covers the whole wallet-activity section.
  let claimStatus = $state<ClaimStatus | null>(null);
  let claimStatusLoading = $state(true);
  let claimStatusFailed = $state(false);
  let auditEvents = $state<ClaimAuditEvent[]>([]);
  let auditLoading = $state(true);
  let auditFailed = $state(false);
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
    simdItems = [];
    simdLoading = true;
  }

  /**
   * Drive the CSR fan-out for `vote` — claim status + audit log +
   * SIMD feed, all in parallel. Each request honours the shared
   * `signal`; if the user navigates away before it completes, the
   * controller aborts and the resulting rejection (with
   * `name: 'AbortError'`) is intentionally ignored so we don't paint
   * a stale error tile after teardown.
   *
   * Claim status is fetched with `includeActivity: true` so each
   * registered wallet's 365-day activity arrives INLINE on the same
   * response — there is no longer a per-wallet activity fan-out
   * (exposing the full operator-wallet pubkey in a `/v1/*` URL was
   * information disclosure). The wallet-activity section's loading
   * state is just `claimStatusLoading`.
   */
  async function loadCsrPanels(vote: string, signal: AbortSignal): Promise<void> {
    const claimPromise = fetchClaimStatus(vote, { signal, includeActivity: true }).then(
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
      // Wilson-upper alignment: the floor is checked against
      // `1 − reliability` (the same wilsonUpper the backend uses)
      // rather than the raw point-estimate skip rate. Earlier the
      // UI used the point estimate and silently disagreed with the
      // backend for small samples — the floor banner would not
      // render for capped validators with thin windows.
      reliability: tierComponents.reliability,
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

  // ── Tier card: gap-to-next + composite arithmetic ──
  // All presentation-layer derivations off the SSR scoring payload —
  // no extra fetch. The card answers not just "what tier" but "why",
  // "how far to the next tier", and (via the breakdown table) how
  // the composite is built.

  // The gap one-liner renders only for a rated, non-floored
  // validator. Floored: the composite is not the blocker (warn chip
  // owns that). Unrated: the composite is null (the reason box
  // owns that).
  const showGapStrip = $derived(tier.composite !== null && !reliabilityFloor);
  // `nextTierGap` is null at forge (top tier) — the line then shows
  // the "top tier" headline instead of a points-away line.
  const tierGap = $derived(tier.composite === null ? null : nextTierGap(tier.composite));

  // Composite arithmetic for the breakdown table — shows the
  // score is BUILT, not assigned. Mirrors the exact backend formula:
  //
  //   composite     = 0.30·reliability + 0.70·economicScore
  //   economicScore = 0.90·economicPercentile + 0.10·cuSubscore
  //   cuSubscore    = cuPercentile (or economicPercentile when the
  //                   validator produced no blocks — non-producer
  //                   fallback in `services/node-tier.ts`).
  //
  // Expanded into the three raw inputs each input ends up with these
  // effective composite weights: 0.30 / 0.63 / 0.07. The breakdown
  // shows all three lines explicitly so a delegator can verify the
  // composite arithmetically — the earlier two-line form silently
  // dropped the CU contribution and didn't add up to the rendered
  // composite when CU subscore diverged from economic percentile.
  //
  // Null when there's no composite (unrated): the breakdown then
  // shows only tier bands + measurement, never a phantom sum.
  const compositeMath = $derived.by(() => {
    const composite = tier.composite;
    const economicPercentile = tierComponents.economicPercentile;
    if (composite === null || economicPercentile === null) return null;
    const reliabilityPct = tierComponents.reliability * 100;
    const economicPct = economicPercentile * 100;
    // Non-producer fallback: when `cuPercentile` is null, the
    // composite uses `economicPercentile` as the CU subscore so the
    // validator is judged on income alone. Mirror that here so the
    // breakdown matches the displayed composite even for non-
    // producers.
    const cuPercentileRaw = tierComponents.cuPercentile;
    const cuFallback = cuPercentileRaw === null;
    const cuSubscoreFraction = cuPercentileRaw ?? economicPercentile;
    const cuSubscorePct = cuSubscoreFraction * 100;
    return {
      reliabilityPct,
      economicPct,
      cuSubscorePct,
      cuFallback,
      reliabilityTerm: WEIGHT_RELIABILITY * reliabilityPct,
      economicTerm: WEIGHT_ECONOMIC_PERCENTILE_EFFECTIVE * economicPct,
      cuTerm: WEIGHT_CU_PERCENTILE_EFFECTIVE * cuSubscorePct,
      composite,
    };
  });

  // Median per-leader-slot income behind the economic percentile —
  // the raw figure the percentile ranks. 6 decimals: per-slot income
  // is the same magnitude class as median block fees.
  const economicMedianSol = $derived.by(() => {
    const sol = lamportsStringToSolNumber(tierWindow.economicMedianLamportsPerSlot);
    return sol === null ? null : sol.toFixed(6);
  });

  // Cold start — fewer closed-epoch rows indexed than the configured
  // 5-epoch window. Drives the honest "{n} of 5 (window still
  // filling)" copy (the screenshot's bare "4" read as a tiny window).
  const windowStillFilling = $derived(tierWindow.epochs < WINDOW_CLOSED_EPOCHS);

  // Skip-rate point estimate as a display percentage — used by the
  // reliability-floor warn chip and the Validator facts row. Returns
  // null for zero-slot validators so consumers can render "—" rather
  // than a misleading "0.0%" (a validator that never had a leader
  // slot has no skip rate to report).
  const skipRatePctLabel = $derived(
    tierWindow.slotsAssigned > 0
      ? ((tierWindow.slotsSkipped / tierWindow.slotsAssigned) * 100).toFixed(1)
      : null,
  );
  // Skip-rate floor 0.20 → "20" for the warn chip's recovery copy.
  const skipFloorPctLabel = (SKIP_RATE_FLOOR * 100).toFixed(0);

  // Skip rate for the trust summary line — point estimate, not Wilson
  // upper (the hub's hero summary is for-humans context, not the
  // pessimistic floor that drives the tier).
  const skipRateValue = $derived(skipRate(tierWindow));

  // Activated stake in SOL — formatted to 0 decimals (millions of SOL
  // rounds cleanly without losing information at this magnitude).
  // `null` when the window spans only pre-stake-snapshot epochs.
  const activatedStakeSol = $derived.by<string | null>(() => {
    const lamports = tierWindow.activatedStakeLamports;
    if (lamports === null) return null;
    const sol = lamportsStringToSolNumber(lamports);
    if (sol === null) return null;
    return new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(sol);
  });

  // Vote credits total across the scoring window — Solana epochs
  // produce up to ~432,000 credits per validator, so the window total
  // is ≤ ~4.3M for a 10-epoch window. Locale-formatted integer for
  // legibility (commas).
  const voteCreditsTotalLabel = $derived(
    new Intl.NumberFormat('en').format(BigInt(tierWindow.voteCreditsTotal)),
  );

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

  // Verified GitHub account — surfaced as a chip in the identity
  // hero. `/v1/claims/:vote` returns a non-null `githubLink` ONLY for
  // a current (non-expired) link, so presence alone means
  // "cryptographically verified via the Ed25519-signed Gist + still
  // live". CSR-fetched as part of `claimStatus`, so the chip appears
  // once Wave 1 resolves — same timing as the audit / wallet panels.
  const githubLink = $derived(claimStatus?.githubLink ?? null);

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
  <!--
    `og:url` matches the canonical (`/income/<vote>`) below — both
    point at the public per-validator surface so an `/v/<vote>` URL
    shared on social media surfaces the canonical equivalent in the
    Twitter / OG preview rather than echoing the internal hub path.
  -->
  <meta property="og:url" content="{SITE_URL}/income/{scoring.vote}" />
  <meta property="og:image" content="{SITE_URL}/og/{scoring.vote}.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <!--
    `noindex, follow` — `/v/<vote>` is intentionally not a public
    entry point. Every app surface routes external visitors through
    `/income/<vote>` (the canonical), and the hub is only reached from
    the income page's "Operator profile →" hand-off strip. Search
    engines shouldn't expose hub URLs in results; the `follow` half
    keeps internal links discoverable so the canonical+OG signals
    above still propagate.
  -->
  <meta name="robots" content="noindex, follow" />
  <!--
    Canonical points at the income page (`/income/<vote>`). Site
    naming (whoearns.live) + the leaderboard's income-sorted default
    establish per-validator earnings as the primary surface; this hub
    is the secondary "operator profile" view. Pointing canonical
    there avoids the hub competing for the same query as income when
    both surfaces describe the same validator.
  -->
  <link rel="canonical" href="{SITE_URL}/income/{scoring.vote}" />
</svelte:head>

<!--
  Back-breadcrumb to the canonical `/income/<vote>` surface. The hub
  is reachable only from inside the income page via the "Operator
  profile →" hand-off strip, so a delegator drilling down into this
  page needs an obvious way out. `aria-label` names the destination
  for screen readers; the visible glyph reads as a back chevron
  rather than a generic link.
-->
<nav class="mb-4" aria-label="Breadcrumb">
  <a
    href={`/income/${scoring.vote}`}
    class="inline-flex min-h-11 items-center gap-1 text-xs text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-brand-500)]"
  >
    <span aria-hidden="true">←</span>
    Back to income view
  </a>
</nav>

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
          <!-- break-words at <sm so long monikers wrap rather than
               silently clipping to "…"; sm: switches to single-line
               truncate where the hero has horizontal room. -->
          <span class="min-w-0 break-words sm:truncate">{heroTitle}</span>
          {#if isClaimed}
            <VerifiedBadge
              size={18}
              label="Verified — claim signed with the validator identity key (Ed25519)"
            />
          {/if}
        </h1>
        <!-- min-w-0 on the wrapper so EllipsisAddress's flex truncate
             actually fires under the hero's flex column constraints —
             without it the pubkey's font-mono span ignores the column
             width and wraps mid-key. -->
        <p class="mt-0.5 min-w-0">
          <EllipsisAddress
            pubkey={scoring.vote}
            class="font-mono text-xs text-[color:var(--color-text-subtle)]"
          />
        </p>

        <!--
          Verified GitHub-account chip. Renders once the CSR claim
          fetch resolves — `/v1/claims/:vote` returns `githubLink`
          only for a current, non-expired link, so its mere presence
          means "verified + live". Links out to the operator's GitHub
          profile. The username is backend-validated (alphanumerics +
          single hyphens, ≤39 chars), so the interpolated profile URL
          needs no extra escaping.
        -->
        {#if githubLink}
          <p class="mt-2">
            <a
              href="https://github.com/{githubLink.githubUsername}"
              target="_blank"
              rel="noopener noreferrer nofollow"
              class="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] px-3 py-2 text-xs font-medium text-[color:var(--color-text-default)] transition-colors hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
              aria-label="Verified GitHub account {githubLink.githubUsername} — opens github.com in a new tab"
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
              <span>{githubLink.githubUsername}</span>
              <span class="text-[color:var(--color-status-ok-fg)]" aria-hidden="true">✓</span>
            </a>
          </p>
        {/if}

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
            <!-- inline-flex + min-h-11 gives the link a WCAG 2.5.5 touch
                 target without bloating the visible text — the hit area
                 grows, the type stays at text-xs. -->
            <a
              href={safeWebsiteUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              class="inline-flex min-h-11 items-center text-[color:var(--color-brand-500)] hover:underline"
            >
              {safeWebsiteUrl}
            </a>
          </p>
        {/if}

        <!--
          Cross-link to /compare so a delegator researching "should I
          delegate here vs. someone else" has a single-click path to
          the side-by-side comparison flow. `?a=<vote>` pre-seeds the
          left slot with THIS validator so the user only has to pick
          the right slot, not both. Without this the hub is a dead-
          end for the comparison sub-task.
        -->
        <p class="mt-2 text-xs">
          <a
            href={`/compare?a=${scoring.vote}`}
            class="inline-flex min-h-11 items-center text-[color:var(--color-brand-500)] hover:underline"
          >
            Compare to peer validators →
          </a>
        </p>

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
          unratedReason={reason ?? undefined}
          size={144}
          nextCutoff={tierGap?.nextCutoff ?? null}
        />

        {#if reliabilityFloor}
          <!--
            Skip-rate-floor banner. Renders whenever the reliability
            floor fired. `role="status"` warn-tone (not muted text)
            because a delegator skimming the page must NOT miss that
            the tier reflects a hard floor, not the economic half of
            the composite. Copy states the FLOOR RULE (always true)
            rather than asserting the current displayed tier, and
            carries the recovery path — a capped validator should
            read this as recoverable, not as a dead end.
          -->
          <div
            class="flex items-start gap-2 rounded-md border border-[color:var(--color-status-warn-fg)]/30 bg-[color:var(--color-status-warn-bg)] px-3 py-2 text-sm font-medium text-[color:var(--color-status-warn-fg)]"
            role="status"
          >
            <span aria-hidden="true">⚠</span>
            <span>
              Skip rate {skipRatePctLabel ?? '—'}% is above the {skipFloorPctLabel}% reliability
              floor — this hard-caps the tier at Kindling regardless of economic percentile. Bring
              it under {skipFloorPctLabel}% to lift the cap.
            </span>
          </div>
        {/if}

        <!--
          One-line tier-gap note. The wide gap-to-next strip with
          0/40/80/100 tick labels collapsed into a single line
          because the per-row composite footer in the table below
          already carries the "tier ≥ N" map. The ring's next-tier
          tick (the small dot on the perimeter) visualises position;
          this line names it in words. Suppressed under skip-floor
          (the banner above is the blocker).
        -->
        {#if showGapStrip}
          <p class="text-sm">
            {#if tierGap}
              <span class="font-semibold text-[color:var(--color-text-default)]">
                {tierGap.pointsAway}
                {tierGap.pointsAway === 1 ? 'point' : 'points'}
              </span>
              <span class="text-[color:var(--color-text-muted)]">
                to {tierGap.nextLabel} tier — composite needs to reach {tierGap.nextCutoff}.
              </span>
            {:else}
              <span class="font-semibold text-[color:var(--color-text-default)]">
                {tierLabel}
              </span>
              <span class="text-[color:var(--color-text-muted)]">
                — the top tier, composite {tier.composite} of 100.
              </span>
            {/if}
          </p>
        {/if}

        {#if reason}
          <!--
            Unrated reason. For an unrated validator this line IS the
            "what to do" — given a calm bordered box (not the faintest
            muted text) so it isn't skimmed past, without an alarmist
            warn tone.
          -->
          <p
            class="rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] px-3 py-2 text-sm text-[color:var(--color-text-muted)]"
          >
            {reason}
          </p>
        {/if}

        <!--
          Sub-component breakdown table. Replaces the previous
          paragraph-style "What raises this score" + the collapsible
          "How this tier was scored" disclosure. The table is
          information-denser per vertical inch:

          - One row per input (reliability / economic percentile /
            CU subscore) with the value, weight, and contribution
            visible in-line — no need to expand a disclosure to
            see the math.
          - A "what moves it" hint sits under each metric name as
            small muted text so the actionable lever is right next
            to its number.
          - The composite row at the bottom carries the tier-cutoff
            label ("Forge ≥ 95") instead of a separate tier-bands
            list — same fact, less vertical space.
          - The earlier `<details>` chevron is dropped because the
            information no longer hides behind a click.

          Only renders for rated validators (composite non-null).
          Unrated state already gets the `reason` box above which
          explains which gate fired.
        -->
        {#if compositeMath}
          <div class="overflow-x-auto">
            <!--
              `<colgroup>` pins explicit widths so the metric-name
              column doesn't eat the numeric columns when the
              browser auto-distributes. Last column is widest to
              fit "Contribution".
            -->
            <table class="w-full text-sm">
              <colgroup>
                <col />
                <col class="w-20" />
                <col class="w-20" />
                <col class="w-24" />
              </colgroup>
              <thead
                class="text-[10px] uppercase tracking-wider text-[color:var(--color-text-muted)]"
              >
                <tr class="border-b border-[color:var(--color-border-default)]">
                  <th scope="col" class="text-left py-1.5 pr-3 font-medium">Sub-component</th>
                  <th scope="col" class="text-right py-1.5 px-2 font-medium">Value</th>
                  <th scope="col" class="text-right py-1.5 px-2 font-medium">Weight</th>
                  <th scope="col" class="text-right py-1.5 pl-2 font-medium">Contribution</th>
                </tr>
              </thead>
              <tbody>
                <!--
                  Each sub-component spans TWO rows: a data row with
                  the row-header label + value/weight/contribution
                  numerics, then a hint row with `<td colspan="4">`
                  carrying the "what moves it" copy. Splitting the
                  hint out of the `<th scope="row">` stops screen
                  readers from re-announcing the entire hint as part
                  of the row header for every numeric cell — the
                  data row reads as a clean four-column row, the
                  hint reads as an explanatory note.
                -->
                <tr class="align-baseline">
                  <th scope="row" class="text-left pt-2.5 pr-3 font-medium">
                    <span class="inline-flex items-center gap-1.5">
                      Reliability
                      {#if reliabilityFloor}
                        <span
                          class="text-[color:var(--color-status-warn-fg)]"
                          aria-label="Reliability floor triggered">⚠</span
                        >
                      {/if}
                    </span>
                  </th>
                  <td class="text-right tabular-nums pt-2.5 px-2"
                    >{compositeMath.reliabilityPct.toFixed(1)}%</td
                  >
                  <td
                    class="text-right tabular-nums pt-2.5 px-2 text-[color:var(--color-text-muted)]"
                    >0.30</td
                  >
                  <td class="text-right tabular-nums pt-2.5 pl-2 font-semibold"
                    >{compositeMath.reliabilityTerm.toFixed(1)}</td
                  >
                </tr>
                <tr class="border-b border-[color:var(--color-border-default)]">
                  <td colspan="4" class="pb-2.5 text-xs text-[color:var(--color-text-muted)]">
                    Conservative reliability estimate — counts both skip rate AND sample size, so
                    small windows can't claim 100%. Lower skip rate AND more leader slots raise it;
                    tier is hard-capped at Kindling if reliability drops below 80%.
                  </td>
                </tr>
                <tr class="align-baseline">
                  <th scope="row" class="text-left pt-2.5 pr-3 font-medium">Economic percentile</th>
                  <td class="text-right tabular-nums pt-2.5 px-2"
                    >{compositeMath.economicPct.toFixed(1)}%</td
                  >
                  <td
                    class="text-right tabular-nums pt-2.5 px-2 text-[color:var(--color-text-muted)]"
                    >0.63</td
                  >
                  <td class="text-right tabular-nums pt-2.5 pl-2 font-semibold"
                    >{compositeMath.economicTerm.toFixed(1)}</td
                  >
                </tr>
                <tr class="border-b border-[color:var(--color-border-default)]">
                  <td colspan="4" class="pb-2.5 text-xs text-[color:var(--color-text-muted)]">
                    Cohort rank of median fee + MEV tip per leader slot vs
                    {tierWindow.economicCohortSize.toLocaleString()} indexed peers. Higher fee + tip capture
                    per slot raises it.
                  </td>
                </tr>
                <tr class="align-baseline">
                  <th scope="row" class="text-left pt-2.5 pr-3 font-medium">CU subscore</th>
                  <td class="text-right tabular-nums pt-2.5 px-2"
                    >{compositeMath.cuSubscorePct.toFixed(1)}%</td
                  >
                  <td
                    class="text-right tabular-nums pt-2.5 px-2 text-[color:var(--color-text-muted)]"
                    >0.07</td
                  >
                  <td class="text-right tabular-nums pt-2.5 pl-2 font-semibold"
                    >{compositeMath.cuTerm.toFixed(1)}</td
                  >
                </tr>
                <tr>
                  <td colspan="4" class="pb-2.5 text-xs text-[color:var(--color-text-muted)]">
                    {#if compositeMath.cuFallback}
                      Validator produced no blocks in the window — defaults to economic percentile
                      so it isn't penalised on a metric it had no chance to register.
                    {:else}
                      Cohort rank of average compute units per produced block. Denser block packing
                      raises it.
                    {/if}
                  </td>
                </tr>
              </tbody>
              <tfoot class="border-t-2 border-[color:var(--color-border-default)]">
                <tr>
                  <!--
                    `colspan="3"` on the label cell pulls the
                    composite total right against the Contribution
                    column — the previous version left two empty
                    `<td>`s between the label and the number, which
                    screen readers announced as "blank, blank" and
                    visually fragmented the row.
                  -->
                  <th scope="row" colspan="3" class="text-left pt-3 pr-3 font-semibold">
                    Composite
                    <span class="font-normal text-[color:var(--color-text-muted)]">
                      — {tierLabel}
                      {#if reliabilityFloor}
                        (capped by skip-rate floor)
                      {:else if tier.tier === 'kindling'}
                        &lt; {TIER_CUTOFFS.hearth}
                      {:else if tier.tier !== 'unrated'}
                        ≥ {TIER_CUTOFFS[tier.tier as Exclude<NodeTier, 'kindling' | 'unrated'>]}
                      {/if}
                    </span>
                  </th>
                  <td class="text-right tabular-nums pt-3 pl-2 font-bold text-base"
                    >{compositeMath.composite}</td
                  >
                </tr>
              </tfoot>
            </table>
          </div>

          <!--
            Measurement context — single dense line in lieu of the
            previous nested "This measurement" grid inside the
            collapsible. Same facts, one screen-friendly row.
          -->
          <p class="text-xs text-[color:var(--color-text-muted)]">
            <span class="text-[color:var(--color-text-muted)]">Measurement:</span>
            {tierWindow.epochs} of {WINDOW_CLOSED_EPOCHS} closed epochs · {tierWindow.economicCohortSize.toLocaleString()}
            peers compared{#if economicMedianSol !== null}
              · median ◎{economicMedianSol} / slot{/if}{#if tierWindow.cohortAsOfEpoch}
              · cohort epochs {tierWindow.cohortAsOfEpoch.fromEpoch}–{tierWindow.cohortAsOfEpoch
                .toEpoch}{/if}{#if windowStillFilling}
              (window still filling){/if}. Percentile is ranked against the validators WhoEarns
            indexes, not the whole cluster.
          </p>
          <!--
            "Glossary →" deep-link so an operator or delegator
            unfamiliar with terms ("Wilson upper bound", "CU
            subscore", "cohort percentile") has a one-click path
            to the definitions. Muted styling — supplementary, not
            a CTA.
          -->
          <p class="text-xs">
            <a
              href="/glossary"
              class="inline-flex min-h-11 items-center text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand-500)] hover:underline"
            >
              Glossary — definitions of every term on this card →
            </a>
          </p>
        {/if}
      </div>
    </Card>
  </div>

  <!--
    Validator facts — col-span-5 on desktop. Consolidates Tenure +
    Client into a single panel: one h2 instead of two, so the right
    column doesn't visually compete with the Tier card on the left
    (the 4-agent review flagged the "two h2s = peer of Tier" weight
    issue). `lg:sticky` floats the panel alongside the dense Tier
    card as the user scrolls; without sticky there's ~400px of empty
    column below this card next to the Tier card's lower half.
  -->
  <div class="lg:col-span-5">
    <Card tone="panel" class="lg:sticky lg:top-20">
      <h2 class="text-lg font-semibold tracking-tight">Validator facts</h2>
      <!--
        Two-tier layout inside the card:
          1. Tenure + Client badges at the top (visually anchored,
             carry a sub-line of context each).
          2. A dense key-value table below for the operational +
             economic facts (slots / skip rate / median income per
             slot / last 30d income). The four rows fit on one
             screen-height and let the right column actually balance
             the dense Tier card on the left.
      -->
      <dl class="mt-4 flex flex-col gap-5">
        <!--
          Tenure row.

          `tenure.firstSeenEpoch` carries the validator's TRUE first
          epoch with stake when the stakewiz ingester has backfilled
          `genesis_epoch`, falling back to the indexer-relative
          first-seen epoch otherwise — hence "Active since", not
          "First seen". Mainnet epoch ≈ 2 days; the year gloss
          ("~5.1 years") gives a delegator a scale they can read
          without doing epoch arithmetic.
        -->
        <div>
          <dt
            class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
          >
            Tenure
          </dt>
          <dd class="mt-1.5 flex flex-col gap-1.5">
            <div><TenureBadge tenure={scoring.tenure} size="md" /></div>
            <p class="text-xs text-[color:var(--color-text-muted)]">
              Active since epoch <span class="tabular-nums">{scoring.tenure.firstSeenEpoch}</span> —
              about
              <span class="tabular-nums"
                >{((scoring.tenure.activeEpochs * 2) / 365).toFixed(1)}</span
              >
              years (<span class="tabular-nums">{scoring.tenure.activeEpochs.toLocaleString()}</span
              > epochs).
            </p>
          </dd>
        </div>

        <!--
          Client row.

          "Gossip" was internal Solana protocol vocabulary; the
          earlier rename to "last verified" was wrong in the
          opposite direction — `verified` is reserved for
          cryptographic attestations (claim ceremony, gist proof,
          dual-signature wallet). `last seen` is accurate (we
          observed the self-reported value on the cluster) without
          overloading the verified verb.
        -->
        <div>
          <dt
            class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
          >
            Client
          </dt>
          <dd class="mt-1.5 flex flex-col gap-1.5">
            <div><ClientBadge client={scoring.client} size="md" /></div>
            {#if scoring.client.updatedAt !== null}
              <p class="text-xs text-[color:var(--color-text-muted)]">
                Version last seen {formatTimestamp(scoring.client.updatedAt)}.
              </p>
            {:else}
              <p class="text-xs text-[color:var(--color-text-muted)]">Version not yet observed.</p>
            {/if}
          </dd>
        </div>
      </dl>

      <!--
        Operational + economic facts table. Same window as the Tier
        card (10 closed epochs by default). Each row is a single
        key-value pair so the right column carries actual content
        rather than only the two visual badge rows above.

        - Slots: leader-slot sample size in the window. Tied to the
          composite's measurement footer ("X of Y closed epochs").
        - Skip rate: raw `slotsSkipped / slotsAssigned`. This is the
          INPUT to the Wilson-95 pessimistic reliability shown in
          the Tier card — surfacing the raw number lets an operator
          read both at once.
        - Median income / slot: same number the economic percentile
          ranks against (see the Tier card's measurement footer).
        - Last 30d income: rolling 30-day total fee + tip take.
          Mirrors the trust-strip number in the hero so the figure
          has a place on the page outside the one-liner.
      -->
      <dl
        class="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-[color:var(--color-border-default)] pt-5 text-sm"
      >
        <dt class="text-xs uppercase tracking-wider text-[color:var(--color-text-subtle)]">
          Slots
        </dt>
        <dd class="text-right tabular-nums">
          {tierWindow.slotsAssigned.toLocaleString()}
          <span class="text-xs text-[color:var(--color-text-muted)]">
            assigned · {tierWindow.slotsSkipped.toLocaleString()} skipped
          </span>
        </dd>

        <dt class="text-xs uppercase tracking-wider text-[color:var(--color-text-subtle)]">
          Skip rate
        </dt>
        <dd class="text-right tabular-nums">
          {#if skipRatePctLabel !== null}
            {skipRatePctLabel}%
          {:else}
            <span class="text-[color:var(--color-text-muted)]">—</span>
          {/if}
        </dd>

        <dt class="text-xs uppercase tracking-wider text-[color:var(--color-text-subtle)]">
          Median income / slot
        </dt>
        <dd class="text-right tabular-nums">
          {#if economicMedianSol !== null}
            ◎{economicMedianSol}
          {:else}
            <span class="text-[color:var(--color-text-muted)]">—</span>
          {/if}
        </dd>

        <dt class="text-xs uppercase tracking-wider text-[color:var(--color-text-subtle)]">
          Block income · 30d
        </dt>
        <dd class="text-right tabular-nums">
          {#if incomeLast30dSol !== null}
            ◎{incomeLast30dSol}
          {:else}
            <span class="text-[color:var(--color-text-muted)]">—</span>
          {/if}
        </dd>

        <!--
          Active stake — snapshot from the most recent closed
          epoch's `epoch_validator_stats` row (per the scoring
          response). `null` for pre-stake-snapshot epochs; we render
          an em-dash so a delegator doesn't see a misleading "0".
        -->
        <dt class="text-xs uppercase tracking-wider text-[color:var(--color-text-subtle)]">
          Active stake
        </dt>
        <dd class="text-right tabular-nums">
          {#if activatedStakeSol !== null}
            ◎{activatedStakeSol}
          {:else}
            <span class="text-[color:var(--color-text-muted)]">—</span>
          {/if}
        </dd>

        <!--
          Vote credits across the scoring window. Source is
          `getVoteAccounts.epochCredits`; under SIMD-0033 (Timely
          Vote Credits) the count is implicitly latency-weighted —
          a high ratio of credits to max-possible reads as "votes
          landed on time." Surfaced here as the window total.
        -->
        <dt class="text-xs uppercase tracking-wider text-[color:var(--color-text-subtle)]">
          Vote credits
        </dt>
        <dd class="text-right tabular-nums">
          {voteCreditsTotalLabel}
        </dd>
      </dl>
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

  Each registered operator wallet renders its own panel. The
  365-day activity arrives INLINE on the claim-status response
  (fetched with `includeActivity: true`) — no per-wallet fan-out,
  so the whole section shares one loading state tied to the
  claim-status fetch. While that fetch is in flight a single
  CLS-stable skeleton holds the space.
-->
{#if claimStatusLoading}
  <!--
    Section-level skeleton — one tile while the claim-status fetch
    (which carries the inline activity) is in flight. `aria-busy`
    tells AT users the region is mid-load.
  -->
  <div
    class="mt-6 min-h-[220px] animate-pulse rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-4 text-sm text-[color:var(--color-text-muted)]"
    role="status"
    aria-busy="true"
    aria-label="Loading wallet activity"
  >
    Loading wallet activity…
  </div>
{:else if claimStatus !== null && claimStatus.wallets.entries.length > 0}
  <section class="mt-6 flex flex-col gap-4" aria-labelledby="wallet-activity-heading">
    <header class="px-1">
      <h2 id="wallet-activity-heading" class="text-lg font-semibold tracking-tight">
        Wallet activity
      </h2>
      <p class="mt-1 text-xs text-[color:var(--color-text-muted)]">
        Daily transactions per registered wallet, last 365 days.
      </p>
    </header>
    {#each claimStatus.wallets.entries as walletEntry (walletEntry.walletAddressShort)}
      <ActivityHeatmap
        walletAddressShort={walletEntry.walletAddressShort}
        label={walletEntry.label}
        entries={walletEntry.activity?.entries ?? []}
      />
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

  Hidden entirely when the validator is unclaimed AND `scoring.oai`
  is null — the "shorter page, not sadder" PM doctrine. The Claim
  CTA below already nudges the operator; rendering an OAI stub here
  just steals scroll real estate from that surface.
-->
{#if isClaimed}
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
{/if}

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
  <!--
    Card tone is `accent` (the loudest tone) ONLY for the owner-claimed
    flow where the operator is the only audience who can act on the
    button. For unclaimed validators and non-owner visits the tone
    drops to `panel` so the CTA doesn't shout — the primary persona
    is a delegator, and a delegator-primary surface shouldn't have
    its highest visual weight on an operator-only action.
  -->
  <Card tone={isClaimed && isOwnerHint ? 'accent' : 'panel'} class="mt-6">
    <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0 flex-1">
        <h2 class="text-lg font-semibold tracking-tight">
          {#if isClaimed}Operator dashboard{:else}Are you the operator?{/if}
        </h2>
        <p class="mt-1 text-sm text-[color:var(--color-text-muted)]">
          {#if isClaimed}
            Claimed and verified by the validator's operator.
          {:else}
            Claim this validator to publish a profile and register operator wallets. The claim
            ceremony is signed offline with the validator identity key.
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

      Wrapper is `w-full sm:w-auto` so the button fills the row at
      mobile (left-aligned 180px button under a stretched header
      reads as a misplaced chip); from `sm` up it returns to
      intrinsic width on the right of the flex row.
    -->
      <div class="flex w-full shrink-0 items-center gap-2 sm:w-auto">
        {#if isClaimed && isOwnerHint}
          <Button href="/claim/{scoring.vote}" variant="primary" size="md" class="w-full sm:w-auto"
            >Manage profile</Button
          >
        {:else if !isClaimed}
          <Button href="/claim/{scoring.vote}" variant="ghost" size="md" class="w-full sm:w-auto"
            >Operator? Sign to claim</Button
          >
        {:else}
          <Button href="/claim/{scoring.vote}" variant="ghost" size="md" class="w-full sm:w-auto"
            >Operator? Manage profile</Button
          >
        {/if}
      </div>
    </div>
  </Card>
{/if}
