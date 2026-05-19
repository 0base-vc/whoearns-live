<!--
  Validator Hub `/v/[idOrVote]` — PR 1 (foundation).

  This PR ships:
   - Identity hero with moniker / icon / verified+claim chip / share widget
   - Tier card with TierRing (composite radial + reliability/economic bars)
   - Tenure + Client badges stack
   - Freshness line ("Last refreshed N ago")
   - Action footer (claim CTA OR soft "Manage profile" hint via `?owner=1` / local-storage)

  PRs 2 and 3 add the OAI panel, wallet-activity heatmap, audit timeline,
  income summary strip, SIMD feed, sticky mobile header, and cross-link
  swap from `/income/[id]` → `/v/[id]`. Plan reference:
  `/Users/jjangg96/.claude/plans/adaptive-nibbling-ocean.md`.

  Design principles honoured:
   - Per-component breakdown is mandatory: TierRing always shows the
     two sub-component bars next to the composite.
   - No half-shown scores: `composite: null` paints the ring as a faint
     stroke + em-dash, never a fake "0".
   - Cold-start = "shorter page, not sadder": identity, tier, tenure,
     client, share widget all work without claim/OAI/wallet/audit data.
   - Visitor-safe: no trusted-owner state. `?owner=1` and
     localStorage are SOFT UI hints only.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';

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

  import {
    TIER_LABEL,
    TIER_TAGLINE,
    isReliabilityFloorTriggered,
    skipRate,
    trustSummary,
    unratedReason,
  } from '$lib/tier';
  import { formatSolFixed, formatTimestamp } from '$lib/format';
  import { SITE_URL } from '$lib/site';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const scoring = $derived(data.scoring);
  const history = $derived(data.history);

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
  const safeIconUrl = $derived.by(() => {
    const url = history?.iconUrl;
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  });

  // Korean accent strip — purely cosmetic, triggered by the operator's
  // own choice to put 🇰🇷 in their moniker. NOT geolocation, NOT inferred.
  // The trigger respects the operator's identity.
  const showKoreanAccent = $derived(moniker !== null && moniker.includes('🇰🇷'));

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
  onMount(() => {
    try {
      const url = new URL(page.url.href);
      if (url.searchParams.get('owner') === '1') {
        isOwnerHint = true;
        return;
      }
      const key = `whoearns:owned:${scoring.vote}`;
      if (sessionStorage.getItem(key) === '1') {
        isOwnerHint = true;
      }
    } catch {
      // Private mode / SSR — soft hint stays off. That's correct,
      // any consumer that needs an auth boundary should use the
      // claim flow's offline signing.
    }
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
  const tierTagline = $derived(TIER_TAGLINE[tier.tier]);
  const isUnrated = $derived(tier.tier === 'unrated');
  const reason = $derived(isUnrated ? unratedReason(scoring.tier) : null);

  // Skip rate for the trust summary line — point estimate, not Wilson
  // upper (the hub's hero summary is for-humans context, not the
  // pessimistic floor that drives the tier).
  const skipRateValue = $derived(skipRate(tierWindow));

  // Income last 30d — SSR-aggregated lamports total. Format as 3-decimal
  // SOL (matches the income page hero convention).
  const incomeLast30dSol = $derived(formatSolFixed(data.incomeLast30dLamports, 3));

  // Trust summary one-liner under the hero title. When fields are
  // missing the resolver renders em-dashes — never fake values.
  const trustLine = $derived(
    trustSummary({
      tierLabel,
      tenureBadge: scoring.tenure.badge,
      clientKind: scoring.client.kind,
      clientVersion: scoring.client.version,
      skipRate: skipRateValue,
      incomeLast30dSol: data.incomeLast30dLamports === null ? null : incomeLast30dSol,
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

  // Claim state — `/scoring` response carries `oai !== null` only
  // when claimed + identity matches + not opted-out. We use that as
  // the public proxy ("does this validator have a claim?"). Manage
  // CTA appears for the soft-owner hint regardless of claim state
  // (operators who haven't claimed yet are precisely who need the
  // CTA the most).
  const isClaimed = $derived(scoring.oai !== null);

  // External website — operator-supplied, treat untrusted. HTTPS
  // only (was previously http: OR https:, but mixed content on a
  // delegator-trust surface is the wrong default; a delegator
  // clicking through to an http:// site sees a browser security
  // warning, which is the opposite of what we want on a tier page).
  const safeWebsiteUrl = $derived.by(() => {
    const url = history?.website;
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  });

  // SEO — concise title + description that pulls the tier into the
  // crawlable text without making it the whole page name. Matches
  // the income page's `<svelte:head>` pattern.
  const seoTitle = $derived(`${heroTitle} — ${tierLabel} tier · WhoEarns Live`);
  const seoDescription = $derived(trustLine);
</script>

<svelte:head>
  <title>{seoTitle}</title>
  <meta name="description" content={seoDescription} />
  <meta property="og:title" content={seoTitle} />
  <meta property="og:description" content={seoDescription} />
  <meta property="og:url" content="{SITE_URL}/v/{scoring.vote}" />
  <meta property="og:image" content="{SITE_URL}/og/{scoring.vote}.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="canonical" href="{SITE_URL}/v/{scoring.vote}" />
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
            <VerifiedBadge size={18} />
          {/if}
        </h1>
        <p class="mt-0.5">
          <EllipsisAddress
            pubkey={scoring.vote}
            class="font-mono text-xs text-[color:var(--color-text-subtle)]"
          />
        </p>

        <!-- Trust summary one-liner — the hub's scannable hero line. -->
        <p class="mt-3 text-sm text-[color:var(--color-text-muted)]" data-testid="trust-summary">
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
    Korean accent strip — 4px gradient bar at the bottom of the hero.
    Triggered ONLY by 🇰🇷 in the operator's own moniker. This is a
    cosmetic identity-respecting nod, not a locale inference.
  -->
  {#if showKoreanAccent}
    <!--
      South-Korean flag colours, literal hex throughout. Earlier
      revision used `var(--color-text-default)` for the white
      middle stripe, which inverts to near-black in light mode
      (broken) and uses a theme-tinted near-white in dark mode
      (off-flag). The flag's middle is `#ffffff` regardless of
      theme; that's what we paint here.
    -->
    <div
      class="mt-4 h-1 w-full rounded-full"
      style="background: linear-gradient(90deg, #cd2e3a 0%, #cd2e3a 33%, #ffffff 33%, #ffffff 67%, #0047a0 67%, #0047a0 100%);"
      aria-hidden="true"
    ></div>
  {/if}
</Card>

<!-- ─────────── 2. Tier card + Tenure/Client stack ─────────── -->
<div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
  <!-- Tier card — col-span-8 on desktop. -->
  <div class="lg:col-span-8">
    <Card tone="panel">
      <div class="flex flex-col gap-4">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-base font-semibold tracking-tight">Node Tier</h2>
          <Pill tone={isUnrated ? 'neutral' : 'brand'} size="sm">
            <TierBadge tier={tier.tier} size={12} label="" />
            <span class="ml-1">{tierLabel}</span>
          </Pill>
        </div>

        <p class="text-sm text-[color:var(--color-text-muted)]">{tierTagline}</p>

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
              ).toFixed(1)}% — tier capped at Kindling regardless of economic percentile.
            </span>
          </div>
        {/if}

        {#if reason}
          <p class="text-xs text-[color:var(--color-text-muted)]">{reason}</p>
        {/if}

        <details class="text-xs">
          <summary
            class="cursor-pointer text-[color:var(--color-text-subtle)] hover:text-[color:var(--color-text-default)]"
          >
            Window detail
          </summary>
          <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[color:var(--color-text-muted)]">
            <dt>Closed epochs</dt>
            <dd class="tabular-nums">{tierWindow.epochs}</dd>
            <dt>Cohort size</dt>
            <dd class="tabular-nums">{tierWindow.economicCohortSize.toLocaleString()}</dd>
            <dt>Measured epochs</dt>
            <dd class="tabular-nums">{tierWindow.economicMeasuredEpochs}</dd>
            {#if tierWindow.cohortAsOfEpoch}
              <dt>Cohort window</dt>
              <dd class="tabular-nums">
                {tierWindow.cohortAsOfEpoch.fromEpoch}–{tierWindow.cohortAsOfEpoch.toEpoch}
              </dd>
            {/if}
          </dl>
        </details>
      </div>
    </Card>
  </div>

  <!-- Tenure + Client stack — col-span-4 on desktop. -->
  <div class="flex flex-col gap-6 lg:col-span-4">
    <Card tone="panel">
      <div class="flex flex-col gap-3">
        <h2 class="text-base font-semibold tracking-tight">Tenure</h2>
        <TenureBadge tenure={scoring.tenure} size="md" />
        <p class="text-xs text-[color:var(--color-text-muted)]">
          First seen at epoch <span class="tabular-nums">{scoring.tenure.firstSeenEpoch}</span> ·
          active <span class="tabular-nums">{scoring.tenure.activeEpochs.toLocaleString()}</span> epochs.
        </p>
      </div>
    </Card>

    <Card tone="panel">
      <div class="flex flex-col gap-3">
        <h2 class="text-base font-semibold tracking-tight">Client</h2>
        <ClientBadge client={scoring.client} size="md" />
        {#if scoring.client.updatedAt !== null}
          <p class="text-xs text-[color:var(--color-text-muted)]">
            Gossip last observed {formatTimestamp(scoring.client.updatedAt)}.
          </p>
        {:else}
          <p class="text-xs text-[color:var(--color-text-muted)]">
            Gossip has not yet observed this validator.
          </p>
        {/if}
      </div>
    </Card>
  </div>
</div>

<!-- ─────────── 3. Action footer (claim CTA / soft owner hint) ─────────── -->
<Card tone="accent" class="mt-6">
  <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="min-w-0 flex-1">
      <h2 class="text-base font-semibold tracking-tight">
        {#if isClaimed}Operator dashboard{:else}Are you the operator?{/if}
      </h2>
      <p class="mt-1 text-sm text-[color:var(--color-text-muted)]">
        {#if isClaimed}
          This validator's profile is claimed. Linked GitHub, registered operator wallets, and
          forensic audit log are surfaced in upcoming sections.
        {:else}
          Claim this validator with an offline Ed25519 signature to surface a public profile and
          register operator wallets.
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

<!--
  PR 2 + PR 3 land:
    - OAI panel (governance + wallet score) — section 4
    - Income summary strip + sparkline + deep-link to `/income/[id]` — section 5
    - Wallet activity heatmaps per registered operator wallet — section 6
    - Claim audit timeline (identity-rotation reclaim ⚠) — section 7
    - SIMD curations (hidden until ingest ships) — section 8
    - Sticky mobile tier header + cross-link swap from `/income/[id]` — section 9
-->
