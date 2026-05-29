<!--
  Validator income detail page.

  This file was rebuilt 2026-04-25 after a two-agent UX review
  (structure + critique) surfaced several issues with the previous
  layout:

    - Lifetime total income was the PRIMARY reason users open this
      page but was cramped into a side-dl. Promoted to the hero
      number (text-4xl / text-5xl, accent).
    - Running-epoch data now appears directly in the Epoch income
      table as the first row with a compact Live badge. The previous
      expandable running card was harder to scan than the table.
    - "MEV tips" + "MEV (Jito)" were two near-duplicate columns in
      the history table. Uses on-chain gross Jito tips as the primary
      MEV value; Kobe payout is retained only as a backend reference.
    - History table clipped the last 6 columns on mobile (only
      Epoch / Assigned / Produced / Skip rate were visible at
      375px). Replaced the table with a stacked-card list at
      `< md`, mirroring the Leaderboard responsive pattern. The
      `<table>` element still renders at `md+` so desktop users keep
      the scannable grid.
    - Validator logo (`iconUrl`) was never rendered anywhere in the
      UI despite living on the API response. Now shown as a 48px
      rounded tile in the hero, with a styled text-initial fallback
      for validators whose operators haven't published a logo.
    - Status legend was removed from the epoch table. Closed epochs do
      not need a repeated "Final" label; only the live row is marked.
-->
<script lang="ts">
  import type { PageData } from './$types';
  import type { NodeTier, ValidatorEpochRecord } from '$lib/types';
  import {
    formatNumberOrDash,
    formatSkipRate,
    formatSol,
    formatSolFixed,
    shortenPubkey,
  } from '$lib/format';

  import IncomeChartLoader from '$lib/components/IncomeChartLoader.svelte';
  import ComputeUnitsChartLoader from '$lib/components/ComputeUnitsChartLoader.svelte';
  import Card from '$lib/components/Card.svelte';
  import AddressDisplay from '$lib/components/AddressDisplay.svelte';
  import VerifiedBadge from '$lib/components/VerifiedBadge.svelte';
  import TierBadge from '$lib/components/TierBadge.svelte';
  import ShareWidget from '$lib/components/ShareWidget.svelte';
  import Tooltip from '$lib/components/Tooltip.svelte';
  import { serializeJsonLd } from '$lib/json-ld';
  import { SITE_NAME, SITE_URL } from '$lib/site';
  import { safeOperatorUrl } from '$lib/url-safety';

  // Per-row decimal counts in the epoch-history table. Fixed-
  // precision SOL renders so decimal points line up across rows —
  // the `formatSol` helper trims trailing zeros (great in isolation,
  // bad in a sortable table). See `ui/src/lib/format.ts` for the
  // rationale behind the specific counts.
  const HISTORY_PER_EPOCH_DECIMALS = 3;

  /**
   * Average compute units per produced block for one epoch row. CU
   * runs to tens of millions, so render a one-decimal "M" suffix to
   * keep the table cell scannable (matching the leaderboard's CU
   * column). "—" when the epoch produced no blocks (null CU).
   */
  function epochCuText(cu: string | null): string {
    if (cu === null) return '—';
    const n = Number(cu);
    if (!Number.isFinite(n)) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return new Intl.NumberFormat('en').format(n);
  }

  const LAST_MONTH_EPOCHS = 16;

  let { data }: { data: PageData } = $props();

  const history = $derived(data.history);
  /**
   * Best-effort tier surface for the cross-link strip below the
   * breadcrumb. `null` when:
   *   - the validator has no scoring yet (unrated / sample too thin),
   *   - the operator opted out of the gamification surface, or
   *   - the `/scoring` endpoint 404s for any other reason.
   * Income page renders fine without it; the strip just collapses.
   */
  const scoring = $derived(data.scoring);

  /**
   * Tier-name in plain English for the cross-link strip. Mirrors the
   * `tierLabel` map inside `TierBadge`'s aria-label, capitalised so
   * it reads as a proper noun in the strip ("Forge tier · …").
   */
  const tierName = $derived.by<string | null>(() => {
    if (scoring === null) return null;
    const map: Record<NodeTier, string> = {
      forge: 'Forge',
      anvil: 'Anvil',
      hearth: 'Hearth',
      kindling: 'Kindling',
      unrated: 'Unrated',
    };
    return map[scoring.tier.tier];
  });

  /**
   * On-chain vote-account commission (integer 0–100) for the income
   * hero. Sourced from the already-loaded `/scoring` payload's tier
   * window — no extra fetch. `null` when scoring is unavailable
   * (unrated / opted-out / 404) OR when the backend refresh tick
   * hasn't covered this validator's row yet (legacy rows).
   *
   * IMPORTANT — honesty contract (see `docs/scoring.md` design-
   * principle #1): WhoEarns income is OPERATOR income (block fees +
   * tips → operator identity), framed commission-NEUTRAL. Commission
   * is surfaced as STANDALONE context for the delegator's own
   * inflation-reward math; it is deliberately NOT multiplied against
   * the displayed income number. `(1 − commission) × operatorIncome`
   * is the wrong formula — commission applies to inflation rewards we
   * do not track, not to the fee/tip income shown here.
   */
  const commissionPct = $derived<number | null>(scoring?.tier.window.commission ?? null);

  /**
   * True when the user hit an unknown pubkey and the indexer just
   * auto-tracked it. The first rendered response is always empty
   * (`items.length === 0`) — subsequent reloads progressively fill
   * in the previous epoch's stats (fee-ingester tick every 30s) and
   * then the running epoch in real time.
   */
  const isTracking = $derived<boolean>(history.tracking === true);
  const trackingMessage = $derived<string | null>(history.trackingMessage ?? null);
  // Shared HTTPS-only gate with userinfo / IP / bare-host rejection,
  // matching the hub's surface. Earlier this page used a looser
  // `safeHttpUrl` (allowed `http:` + no shape checks) which created
  // an asymmetric defense — same data, two postures.
  const safeWebsiteUrl = $derived(safeOperatorUrl(history.website));
  const safeIconUrl = $derived(safeOperatorUrl(history.iconUrl));

  const lastMonthRows = $derived<ValidatorEpochRecord[]>(history.items.slice(0, LAST_MONTH_EPOCHS));
  const lastMonthFeesSol = $derived<number>(
    lastMonthRows.reduce((acc, r) => {
      const v = r.blockFeesTotalSol === null ? 0 : Number(r.blockFeesTotalSol);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0),
  );
  const lastMonthMevSol = $derived<number>(
    lastMonthRows.reduce((acc, r) => {
      const v = r.blockTipsTotalSol === null ? 0 : Number(r.blockTipsTotalSol);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0),
  );
  const lastMonthTotalSol = $derived<number>(lastMonthFeesSol + lastMonthMevSol);

  const latestClosedRow = $derived<ValidatorEpochRecord | null>(
    history.items.find((r) => r.isFinal) ?? null,
  );

  const operatorNarrative = $derived.by<string | null>(() => {
    const override = history.profile?.narrativeOverride;
    if (override !== null && override !== undefined && override.trim().length > 0) {
      return override.trim();
    }
    return null;
  });

  /**
   * True when we have ZERO history rows AND we're not in the tracking
   * hand-off state. Distinct from `isTracking` because:
   *   - `isTracking && items.length === 0` → tracking banner + empty
   *     prompt (first load after on-demand track kicks in).
   *   - `!isTracking && items.length === 0` → validator exists in our
   *     watched set but the fee-ingester hasn't processed any epoch
   *     for it yet. Rare but possible during backfill windows.
   */
  const hasAnyHistory = $derived<boolean>(history.items.length > 0);

  const shortVote = $derived(shortenPubkey(history.vote, 6, 6));
  // Prefer moniker in the <title> tag — makes browser tabs, OS
  // recents, and shared-link previews actually readable. Falls back
  // to the short pubkey for unregistered validators.
  const titleLabel = $derived(history.name ?? shortVote);
  // Typography matches the hub page (`${heroTitle} • ${tierLabel} tier
  // • WhoEarns Live`) so a delegator navigating hub ↔ income sees one
  // page-name shape, not two. The bullet `•` is deliberate — Korean
  // treats the middle-dot `·` as a division mark, so the site
  // standardises on the slightly wider bullet across both pages.
  const pageTitle = $derived(`${titleLabel} • Epoch income • ${SITE_NAME}`);
  const pageDescription = $derived(
    `Per-epoch income for ${titleLabel}: block fees, on-chain Jito tips, slot production, and indexed-validator median income per leader slot over the most recent month-sized window.`,
  );

  /**
   * JSON-LD graph for this validator page. Two top-level entities:
   *   - BreadcrumbList — anchors the page in the site hierarchy
   *     (Leaderboard → this validator).
   *   - Dataset — a Schema.org Dataset with `variableMeasured`
   *     listing the headline numbers. Generative search engines and
   *     SEO crawlers recognize this as citable structured data;
   *     the description is English-first and avoids generated prose
   *     that can drift from the data table.
   */
  const jsonLd = $derived({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        // Two-item trail matches the visible breadcrumb on the page:
        // Leaderboard → this validator's income. With income as the
        // canonical surface (the page user landed on), the hub no
        // longer sits between them in the hierarchy — the tier-glance
        // strip handles that cross-link as garnish rather than a
        // breadcrumb step.
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Leaderboard', item: `${SITE_URL}/` },
          {
            '@type': 'ListItem',
            position: 2,
            name: history.name ?? shortenPubkey(history.vote, 6, 6),
            item: `${SITE_URL}/income/${history.vote}`,
          },
        ],
      },
      {
        '@type': 'Dataset',
        name: `${history.name ?? shortenPubkey(history.vote, 6, 6)} — Epoch income | ${SITE_NAME}`,
        inLanguage: 'en',
        description: operatorNarrative ?? pageDescription,
        // Dataset URL points at the income page itself (canonical
        // alignment): structured-data crawlers should attribute
        // earnings data to this surface, not the hub.
        url: `${SITE_URL}/income/${history.vote}`,
        creator: { '@type': 'Organization', name: '0base.vc' },
        license: 'https://creativecommons.org/publicdomain/zero/1.0/',
        keywords: ['Solana', 'validator', 'MEV', 'Jito', 'block fees', history.vote],
        variableMeasured: [
          {
            '@type': 'PropertyValue',
            name: 'lastMonthIncomeSol',
            value: lastMonthTotalSol > 0 ? lastMonthTotalSol.toFixed(9) : '0',
            description:
              'Block fees + on-chain Jito tip earnings (in SOL) over the most recent month-sized window',
          },
          {
            '@type': 'PropertyValue',
            name: 'epochCount',
            value: history.items.length,
            description: 'Number of epochs indexed for this validator',
          },
          ...(latestClosedRow !== null
            ? [
                {
                  '@type': 'PropertyValue',
                  name: 'latestEpoch',
                  value: latestClosedRow.epoch,
                  description: 'Most recent closed epoch covered',
                },
              ]
            : []),
        ],
      },
    ],
  });

  /**
   * Single-character fallback tile for validators without a published
   * logo. Takes the first graphemes of the moniker (handles flag
   * emojis + wide characters correctly via `Array.from`) — if there's
   * no moniker at all, shows a neutral "?" so the tile shape stays
   * consistent.
   */
  const initialForFallback = $derived.by<string>(() => {
    if (history.name === null || history.name.length === 0) return '?';
    const firstChar = Array.from(history.name)[0];
    return firstChar === undefined ? '?' : firstChar;
  });

  /**
   * Broken-image bookkeeping. If `history.iconUrl` 404s or fails
   * CORS, the `<img>` `onerror` handler flips this to `true` and we
   * switch to the text-initial fallback. Scoped per-page so a
   * remount (SvelteKit navigation) gives the remote URL another
   * chance.
   */
  let iconLoadFailed = $state(false);

  /**
   * Primary MEV display is our on-chain gross Jito tips, derived from
   * every produced block. Kobe's post-TipRouter payout remains available
   * on the API as a reference, but it is not the page's income source.
   */
  function unifiedMevFor(row: ValidatorEpochRecord): {
    display: string | null;
    isApproximate: boolean;
  } {
    if (row.blockTipsTotalSol !== null) {
      return { display: row.blockTipsTotalSol, isApproximate: false };
    }
    return { display: null, isApproximate: false };
  }

  function isLiveRow(row: ValidatorEpochRecord): boolean {
    return row.isCurrentEpoch && !row.isFinal;
  }

  /**
   * Skip rate uses elapsed slots as its denominator on the live row so the
   * percentage reflects production health right now. Dividing by full
   * `slotsAssigned` mid-epoch would understate skips until every leader
   * slot had passed. The slots column ("produced / assigned") instead
   * uses `slotsAssigned` directly — readers expect a stable "progress
   * toward the epoch's full leader-slot allocation" denominator.
   */
  function skipRateDenominator(row: ValidatorEpochRecord): number | null {
    return isLiveRow(row) ? (row.slotsElapsedAssigned ?? row.slotsAssigned) : row.slotsAssigned;
  }
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={pageDescription} />
  <!--
    Canonical points at this income page itself. Site naming
    (`whoearns.live`) + the leaderboard's income-sorted default make
    "per-validator earnings" the primary surface; the validator hub
    `/v/<vote>` is the secondary "operator profile" surface and links
    here back via its own breadcrumb + share widget. Keeping the
    canonical here matches user intent on inbound traffic — most
    sources (search results, social shares, leaderboard rows) are
    looking up income, not gamification.
  -->
  <link rel="canonical" href={`${SITE_URL}/income/${history.vote}`} />
  <meta property="og:title" content={pageTitle} />
  <meta property="og:description" content={pageDescription} />
  <meta property="og:locale" content="en_US" />
  <!--
    Per-validator OG image rendered dynamically by the Fastify
    `og.route.ts` (Phase 2). The crawler hits `/og/<vote>.png`, the
    server pulls the validator's name + most recent closed epoch, and
    satori → resvg produces a 1200×630 brand card. LRU-cached for an
    hour so the social-card preview is consistent across refreshes.
  -->
  <meta property="og:image" content={`${SITE_URL}/og/${history.vote}.png`} />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:image" content={`${SITE_URL}/og/${history.vote}.png`} />
  <meta name="twitter:card" content="summary_large_image" />
  <!--
    JSON-LD graph: Dataset + BreadcrumbList. Bots that respect
    structured data (Google, Bing, Perplexity, ChatGPT browse) read
    `variableMeasured` for the headline numbers and `description`
    for the English-first page summary or operator-authored note.
  -->
  {@html `<script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>`}
  {#if isTracking}
    <!--
      Auto-refresh only while tracking — pulls newly-filled data without
      requiring user interaction. Stops as soon as `tracking` flips to
      false (happens once the dynamic-watched row gets its first stats
      row from the next fee-ingester tick).
    -->
    <meta http-equiv="refresh" content="45" />
  {/if}
</svelte:head>

<!--
  Breadcrumb trail (WAI-ARIA Breadcrumb pattern): Leaderboard →
  current validator. Two items match the JSON-LD `BreadcrumbList`
  below so structured-data crawlers + screen readers + sighted users
  all see the same hierarchy. With income as the canonical surface
  the hub is reached via the tier-glance strip below, not as a
  breadcrumb step — that keeps the breadcrumb a true ancestor chain.

  Every `<li>` is `min-h-11` for matching vertical rhythm + meeting
  WCAG 2.5.5 (44×44 target size on mobile).
-->
<nav aria-label="Breadcrumb" class="mb-3">
  <ol class="flex list-none flex-wrap items-center gap-1 p-0">
    <li class="inline-flex min-h-11 items-center">
      <a
        href="/"
        class="inline-flex items-center text-xs text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand-500)] hover:underline"
      >
        Leaderboard
      </a>
    </li>
    <li
      class="inline-flex min-h-11 items-center text-xs text-[color:var(--color-text-subtle)]"
      aria-current="page"
    >
      <span aria-hidden="true" class="px-1.5">›</span>
      <span>{history.name ?? shortenPubkey(history.vote, 6, 6)}</span>
    </li>
  </ol>
</nav>

<!--
  Tier-glance strip. Sits between the breadcrumb and the income hero
  as a soft hand-off to the validator hub (`/v/<vote>`), where the
  full gamification surface lives (tier ring, tenure, client, OAI,
  wallet activity heatmap, audit log). The income page stays the
  primary "performance" view — site name is whoearns.live, leaderboard
  sort key is income, the entire user expectation when clicking a row
  is "show me this validator's numbers." The strip lets a reader who
  IS curious about the operator-craft side of things hop over in one
  click without making that the default destination.

  Collapses silently when scoring is unavailable (unrated, opted-out,
  /scoring 404) — the income page is the contract; the strip is
  cross-link garnish.

  Whole strip is a single `<a>` so the hover affordance covers the
  entire row and the click target is large (WCAG 2.5.5 — 44×44 on
  mobile, the strip's `py-2.5` gives ~44px vertical even for a one-
  line text + 18px badge).
-->
{#if scoring !== null && tierName !== null}
  <a
    href={`/v/${history.vote}`}
    class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]/40 px-3 py-2.5 transition-colors hover:border-[color:var(--color-brand-500)] hover:bg-[color:var(--color-surface-muted)]"
    aria-label={`See ${tierName} tier details, badges, and activity on the validator hub`}
  >
    <span class="flex min-w-0 items-center gap-2 text-xs text-[color:var(--color-text-muted)]">
      <TierBadge tier={scoring.tier.tier} size={18} />
      <span class="truncate">
        <span class="font-semibold text-[color:var(--color-text-default)]">{tierName}</span>
        {#if scoring.tier.composite !== null}
          <span class="text-[color:var(--color-text-subtle)]">
            · {scoring.tier.composite} of 100
          </span>
        {/if}
        <span class="text-[color:var(--color-text-subtle)]">
          — tier, tenure, client, activity
        </span>
      </span>
    </span>
    <span
      class="shrink-0 text-xs font-semibold text-[color:var(--color-brand-500)]"
      aria-hidden="true"
    >
      Operator profile →
    </span>
  </a>
{/if}

<!-- ─────────── 1. Validator hero (identity + recent income) ─────────── -->
<Card tone="raised">
  <div class="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
    <div class="flex items-start gap-4 min-w-0 flex-1">
      <!--
        Logo tile (48px). Published via `solana validator-info publish
        --icon-url`; many validators leave it blank, so we ship a
        styled fallback that shows the first grapheme of the moniker
        on a subtle accent background — the tile shape stays
        consistent and the page never has a ragged left edge from a
        missing image.

        `referrerpolicy="no-referrer"` stops the fetch from leaking
        our domain to arbitrary remote hosts. `loading="eager"` (not
        lazy) because this is above-the-fold — lazy would flash the
        fallback for a beat on first paint.
      -->
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

      <div class="flex-1 min-w-0">
        <p
          class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]"
        >
          Validator
        </p>
        {#if history.name}
          <h1
            class="mt-1 flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl"
            aria-label={`${history.name} (${history.vote})`}
          >
            <span class="truncate">{history.name}</span>
            {#if history.claimed}
              <!--
                Verified badge inline with the H1 — same component the
                leaderboard uses, sized up to 18px so it doesn't get
                lost next to the larger heading text. The badge sits
                AFTER the moniker because that's the visual scan order
                (read name → see verification cue), and `shrink-0`
                keeps it intact when the moniker truncates.
              -->
              <VerifiedBadge
                size={18}
                label="Verified — claim signed with the validator identity key (Ed25519)"
              />
            {/if}
          </h1>
        {:else}
          <h1
            class="mt-1 flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl"
            aria-label="Validator vote pubkey {history.vote}"
          >
            <span class="truncate">{shortVote}</span>
            {#if history.claimed}
              <VerifiedBadge
                size={18}
                label="Verified — claim signed with the validator identity key (Ed25519)"
              />
            {/if}
          </h1>
        {/if}

        <!--
          Compact vote + identity row. `head…tail`-truncated, each with
          a copy button and an `(i)` tooltip. This replaces BOTH the
          old full-width vote pubkey under the moniker AND the separate
          bordered `<dl>` block lower in the hero — the vote pubkey
          used to render twice (once full under the moniker, once in
          the dl). Identity, which previously only lived in the dl,
          is now surfaced here too. One compact line instead of a
          line + a whole bordered block + its divider.
        -->
        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span class="inline-flex items-center gap-1">
            <span class="font-medium uppercase tracking-wide text-[color:var(--color-text-subtle)]">
              Vote
            </span>
            <Tooltip
              label="About the vote account"
              content="The on-chain vote account. Stakers delegate to this address. Each validator has exactly one fixed vote account that lives forever — even across re-keys."
            />
            <AddressDisplay pubkey={history.vote} variant="inline" head={6} tail={6} />
          </span>
          <span class="inline-flex items-center gap-1">
            <span class="font-medium uppercase tracking-wide text-[color:var(--color-text-subtle)]">
              Identity
            </span>
            <Tooltip
              label="About the identity key"
              content="The validator's identity keypair — the hot key that signs blocks and votes. Operators can rotate this key periodically while keeping the same vote account."
            />
            <AddressDisplay pubkey={history.identity} variant="inline" head={6} tail={6} />
          </span>
        </div>
        {#if safeWebsiteUrl}
          <!--
            Website is user-supplied on-chain; treat as untrusted link.
            `rel="noopener noreferrer nofollow"` prevents window.opener
            leak + discourages SEO pass-through to spammy registrations.
            URL scheme validation is duplicated here even though the
            backend also normalises validator-info: this page must stay
            safe if an old DB row predates the backend guard.
          -->
          <p class="mt-1.5 truncate text-xs">
            <a
              href={safeWebsiteUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              class="text-[color:var(--color-brand-500)] hover:underline"
            >
              {safeWebsiteUrl} ↗
            </a>
          </p>
        {/if}
        {#if history.profile?.twitterHandle}
          <!--
            Phase 3 twitter link. Points to X directly. Same untrusted-
            link treatment as the website — though in practice the
            handle is gated behind a signed-claim flow, which is a
            much stronger anti-spam control.
          -->
          <p class="mt-1 truncate text-xs">
            <a
              href={`https://x.com/${history.profile.twitterHandle}`}
              target="_blank"
              rel="noopener noreferrer nofollow"
              class="text-[color:var(--color-brand-500)] hover:underline"
            >
              @{history.profile.twitterHandle} ↗
            </a>
          </p>
        {/if}
        <!--
          Quiet "claim this validator" link for the operator. Always
          shown — pre-claim it reads as an invitation; post-claim it
          reads as an "edit my profile" shortcut. Muted colour keeps
          it out of the way for casual readers.
        -->
        <p class="mt-2 text-xs">
          <a
            href={`/claim/${history.vote}`}
            class="text-[color:var(--color-text-subtle)] hover:text-[color:var(--color-brand-500)] hover:underline"
          >
            {history.claimed ? 'Edit profile ›' : 'Are you the operator? Claim this validator ›'}
          </a>
        </p>
      </div>
    </div>

    <!--
      Right-hand hero column. Holds (1) the share/embed widget — the
      same component the hub uses, mounted here so the CANONICAL,
      SEO-indexed surface every delegator lands on has the growth-loop
      share affordance the hidden hub already had; and (2) the "money
      number" income block below it.

      The widget is always rendered (even in the tracking / no-history
      state) — a delegator who lands on a freshly-tracked validator can
      still share the page. The income block keeps its own
      `hasAnyHistory` gate so "◎0" never reads as a stated fact during
      ingestion.
    -->
    <div class="flex shrink-0 flex-col gap-4 lg:min-w-64 lg:items-end">
      <!-- Share widget — top-right of hero, mirroring the hub placement. -->
      <ShareWidget
        vote={history.vote}
        siteUrl={SITE_URL}
        tierLabel={tierName ? `${tierName} tier` : undefined}
        display={history.name ?? undefined}
      />

      <!--
        The "money number". Promoted from a side-dl (where it was
        essentially the same visual weight as the `Last epoch` label)
        to a dedicated hero block with an accent-coloured 4xl digit.
        It's the primary reason this page exists — a delegator
        sanity-checking their validator's earnings, an operator
        comparing epochs, a bidder evaluating a candidate.

        Hidden entirely in the `isTracking && !hasAnyHistory` state
        below, because "◎0" reads as a fact ("this validator earned
        zero") rather than "still ingesting" — the tracking banner
        carries the correct message for that case.
      -->
      {#if hasAnyHistory}
        <div class="text-left lg:text-right">
          <p
            class="inline-flex items-center text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
          >
            Total income · last month
            <Tooltip
              label="About last-month income"
              content="Block fees + on-chain Jito tips summed across the most recent month-sized window we have indexed. Pre-commission — this is what the operator earned, not what delegators received."
            />
          </p>
          <p
            class="mt-1 text-4xl font-semibold tracking-tight text-[color:var(--color-brand-500)] sm:text-5xl"
          >
            ◎{formatSol(lastMonthTotalSol.toString())}
          </p>
          {#if commissionPct !== null}
            <p class="mt-1 text-xs text-[color:var(--color-text-muted)]">
              Commission <span class="font-semibold text-[color:var(--color-text-default)]"
                >{commissionPct}%</span
              >
            </p>
          {/if}
          <!--
            Persistent, always-visible honesty caption (replaces relying
            on the hover tooltip alone). States plainly that this number
            is OPERATOR income, NOT the delegator's staking yield — block
            fees + tips accrue to the operator identity; only MEV tips
            are partly shared; the delegator's actual yield is inflation
            rewards (which we do not track) minus this validator's
            commission. We deliberately do NOT compute a fabricated
            "delegator yield" — `(1 − commission) × operatorIncome` is
            the wrong formula (commission applies to inflation, not to
            the fee/tip income shown here). See `docs/scoring.md`
            design-principle #1 (commission-neutral).

            `max-w-xs` keeps the multi-line caption from sprawling the
            full hero width; `lg:ml-auto` right-aligns the block under
            the right-aligned income number on desktop.
          -->
          <p
            class="mt-2 max-w-xs text-xs leading-relaxed text-[color:var(--color-text-muted)] lg:ml-auto"
          >
            Operator income — fees + tips the validator earns. Not your staking yield: delegators
            earn inflation rewards (not shown here) minus
            {#if commissionPct !== null}
              this validator's {commissionPct}% commission;
            {:else}
              the validator's commission;
            {/if}
            block fees go to the operator, only MEV tips are partly shared.
          </p>
        </div>
      {/if}
    </div>
  </div>
</Card>

<!-- ─────────── 1b. On-demand tracking banner ───────────
  Appears when the history endpoint reports `tracking: true`. The
  backend has just added this validator to the dynamic watched set;
  the fee-ingester picks it up on its next tick (~30s), so the user
  gets a progressive fill rather than a hard empty state.
-->
{#if isTracking}
  <Card tone="accent" class="mt-6">
    <div
      role="status"
      aria-live="polite"
      class="flex items-start gap-3 text-sm text-[color:var(--color-text-default)]"
    >
      <span
        aria-hidden="true"
        class="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-[color:var(--color-brand-500)] motion-safe:animate-pulse"
      ></span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">Tracking this validator now</p>
        <p class="mt-1 text-xs leading-relaxed text-[color:var(--color-text-muted)]">
          {trackingMessage ??
            'Indexing started. Previous-epoch stats and the running epoch appear within ~1 minute — refresh to see progress.'}
        </p>
      </div>
    </div>
  </Card>
{/if}

<!-- ─────────── 1c. Operator note ───────────
  Auto-generated prose was removed from the income flow because it
  repeated the hero/current-epoch numbers and slowed scanning. This
  slot is reserved for operator-authored context only.
-->
{#if operatorNarrative !== null && hasAnyHistory && !isTracking}
  <section
    class="mt-6 max-w-3xl text-base leading-relaxed text-[color:var(--color-text-muted)]"
    aria-label="Operator note"
  >
    <p>{operatorNarrative}</p>
  </section>
{/if}

<!-- ─────────── 2. Trend charts (income + compute units) ─────────── -->
<!--
  Hidden during the initial tracking window: an empty chart card is a
  "nothing here" signal that stacks redundantly with the tracking
  banner + Validator card. Shows as soon as `items.length > 0`.

  Responsive 2-column grid: at the `md` breakpoint (>= 768px) the
  income chart and the compute-units chart sit side by side, each
  roughly half width; below 768px the grid collapses to a single
  column so each chart gets the full content width on phones. Both
  charts read the same `history.items` array — one source of truth.
  Each chart's inner LineChart is `w-full`, so it reflows to whatever
  width its grid cell resolves to at any viewport size.
-->
{#if hasAnyHistory}
  <div class="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
    <IncomeChartLoader history={history.items} />
    <ComputeUnitsChartLoader history={history.items} />
  </div>
{/if}

<!-- ─────────── 3. Epoch income ─────────── -->
<section aria-labelledby="history-title" class="mt-10">
  <div class="mb-4">
    <h2 id="history-title" class="text-lg font-semibold">Epoch breakdown</h2>
  </div>

  {#if !hasAnyHistory}
    <Card>
      <p class="text-sm text-[color:var(--color-text-muted)]">
        {#if isTracking}
          Waiting for the next fee-ingester tick. The previous epoch's row appears first, then the
          running epoch fills in as slots get produced.
        {:else}
          No epoch records indexed for this validator yet. Historical data appears after the indexer
          observes the epoch.
        {/if}
      </p>
    </Card>
  {:else}
    <!--
      Responsive bimodal history list:
      - `md+` screens render the full <table> with one MEV tips column
        backed by on-chain gross Jito tips from produced blocks.
      - `< md` screens render a stacked card list — each epoch is
        its own card with a 2×2 grid of the key numbers, preventing
        the 6-column-clip problem the old `overflow-x-auto` table
        had on 375px phones.

      Both views read from the same `history.items` array —
      single source of truth, no drift between responsive modes.
    -->
    <!-- Mobile: stacked cards -->
    <ul class="space-y-3 md:hidden">
      {#each history.items as row (row.epoch)}
        {@const mev = unifiedMevFor(row)}
        {@const total =
          row.blockBaseFeesTotalSol !== null &&
          row.blockPriorityFeesTotalSol !== null &&
          row.blockTipsTotalSol !== null
            ? Number(row.blockBaseFeesTotalSol) +
              Number(row.blockPriorityFeesTotalSol) +
              Number(row.blockTipsTotalSol)
            : null}
        {@const skipDenominator = skipRateDenominator(row)}
        <li>
          <Card>
            <div class="flex items-baseline justify-between gap-3">
              <div class="flex items-baseline gap-3">
                <span class="font-mono text-lg font-semibold">Epoch {row.epoch}</span>
                {#if isLiveRow(row)}
                  <span
                    class="rounded-full border border-[color:var(--color-brand-500)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-brand-500)]"
                  >
                    Live
                  </span>
                {/if}
              </div>
              <div class="text-right">
                <p class="text-[10px] uppercase tracking-wide text-[color:var(--color-text-muted)]">
                  Total
                </p>
                {#if total !== null}
                  <p class="font-mono text-base font-semibold tabular-nums">
                    ◎{formatSolFixed(String(total), HISTORY_PER_EPOCH_DECIMALS)}
                  </p>
                {:else}
                  <p class="font-mono text-base text-[color:var(--color-text-subtle)]">—</p>
                {/if}
              </div>
            </div>

            <dl
              class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[color:var(--color-border-default)] pt-3 text-xs"
            >
              <div>
                <dt class="inline-flex items-center text-[color:var(--color-text-muted)]">
                  Slots
                  <Tooltip
                    label="About slots"
                    content="Blocks produced versus the number scheduled. Solana picks ~4 leader slots per validator per rotation."
                  />
                </dt>
                <dd class="font-mono tabular-nums">
                  {formatNumberOrDash(row.slotsProduced)} / {formatNumberOrDash(row.slotsAssigned)}
                </dd>
              </div>
              <div>
                <dt class="inline-flex items-center text-[color:var(--color-text-muted)]">
                  Skip rate
                  <Tooltip
                    label="About skip rate"
                    content="Percentage of scheduled blocks that didn't get produced. Lower is better — sustained values above ~5% point at an unhealthy node."
                  />
                </dt>
                <dd class="font-mono tabular-nums">
                  {formatSkipRate(row.slotsSkipped, skipDenominator)}
                </dd>
              </div>
              <div>
                <dt class="inline-flex items-center text-[color:var(--color-text-muted)]">
                  Base fees
                  <Tooltip
                    label="About base fees"
                    content="Fixed 5,000 lamports per transaction signature, summed across every block produced this epoch."
                  />
                </dt>
                <dd class="font-mono tabular-nums">
                  {#if row.blockBaseFeesTotalSol !== null}
                    ◎{formatSolFixed(row.blockBaseFeesTotalSol, HISTORY_PER_EPOCH_DECIMALS)}
                  {:else}
                    —
                  {/if}
                </dd>
              </div>
              <div>
                <dt class="inline-flex items-center text-[color:var(--color-text-muted)]">
                  Priority fees
                  <Tooltip
                    label="About priority fees"
                    content="Optional extra users pay to outbid others. 100% to the leader since SIMD-96 (no burn)."
                  />
                </dt>
                <dd class="font-mono tabular-nums">
                  {#if row.blockPriorityFeesTotalSol !== null}
                    ◎{formatSolFixed(row.blockPriorityFeesTotalSol, HISTORY_PER_EPOCH_DECIMALS)}
                  {:else}
                    —
                  {/if}
                </dd>
              </div>
              <div>
                <dt class="inline-flex items-center text-[color:var(--color-text-muted)]">
                  MEV tips
                  <Tooltip
                    label="About MEV tips"
                    content="On-chain Jito tips traders deposit into public tip accounts to land bundles in this validator's blocks. Derived from each produced block, so it is available during the running epoch."
                  />
                </dt>
                <dd class="font-mono tabular-nums">
                  {#if mev.display !== null}
                    ◎{formatSolFixed(mev.display, HISTORY_PER_EPOCH_DECIMALS)}
                  {:else}
                    —
                  {/if}
                </dd>
              </div>
              <div>
                <dt class="inline-flex items-center text-[color:var(--color-text-muted)]">
                  CU
                  <Tooltip
                    label="About compute units"
                    content="Average compute units consumed per block this validator produced this epoch."
                  />
                </dt>
                <dd class="font-mono tabular-nums">
                  {epochCuText(row.avgComputeUnitsPerProducedBlock)}
                </dd>
              </div>
            </dl>
          </Card>
        </li>
      {/each}
    </ul>

    <!-- Desktop: table -->
    <div
      class="hidden md:block overflow-x-auto rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]"
    >
      <table class="min-w-full divide-y divide-[color:var(--color-border-default)] text-sm">
        <caption class="sr-only">
          Epoch breakdown for validator {history.vote}, newest epoch first. The live running epoch
          appears first when available. Income is decomposed into three revenue streams: base fees,
          priority fees, and Jito MEV tips. The MEV column shows on-chain Jito tips derived from
          produced blocks. The CU column is the average compute units consumed per produced block.
        </caption>
        <thead
          class="bg-[color:var(--color-surface-muted)] text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]"
        >
          <tr>
            <th scope="col" class="px-4 py-3 text-left">Epoch</th>
            <th scope="col" class="px-4 py-3 text-right">
              <span class="inline-flex items-center justify-end">
                Slots
                <Tooltip
                  label="About slots"
                  placement="bottom"
                  content="Blocks the validator produced versus the number it was scheduled to lead this epoch."
                />
              </span>
            </th>
            <th scope="col" class="px-4 py-3 text-right">
              <span class="inline-flex items-center justify-end">
                Skip rate
                <Tooltip
                  label="About skip rate"
                  placement="bottom"
                  content="Percentage of scheduled blocks that didn't get produced. Lower is better — anything consistently above ~5% suggests an unhealthy node."
                />
              </span>
            </th>
            <th scope="col" class="px-4 py-3 text-right">
              <span class="inline-flex items-center justify-end">
                Base fees
                <Tooltip
                  label="About base fees"
                  placement="bottom"
                  content="Fixed 5,000 lamports per transaction signature, summed across every block produced this epoch."
                />
              </span>
            </th>
            <th scope="col" class="px-4 py-3 text-right">
              <span class="inline-flex items-center justify-end">
                Priority fees
                <Tooltip
                  label="About priority fees"
                  placement="bottom"
                  content="Optional extra users pay to outbid others. 100% to the leader since SIMD-96 (no burn)."
                />
              </span>
            </th>
            <th scope="col" class="px-4 py-3 text-right">
              <span class="inline-flex items-center justify-end">
                MEV
                <Tooltip
                  label="About MEV"
                  placement="bottom"
                  content="On-chain Jito tips derived from this validator's produced blocks. This is the live MEV signal used in totals."
                />
              </span>
            </th>
            <th scope="col" class="px-4 py-3 text-right">
              <span class="inline-flex items-center justify-end">
                Total
                <Tooltip
                  label="About total"
                  placement="bottom"
                  content="Base fees + Priority fees + MEV — every revenue stream the indexer can see, summed."
                />
              </span>
            </th>
            <th scope="col" class="px-4 py-3 text-right">
              <span class="inline-flex items-center justify-end">
                CU
                <Tooltip
                  label="About compute units"
                  placement="bottom"
                  align="right"
                  content="Average compute units consumed per block this validator produced this epoch."
                />
              </span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[color:var(--color-border-default)]">
          {#each history.items as row (row.epoch)}
            {@const mev = unifiedMevFor(row)}
            {@const skipDenominator = skipRateDenominator(row)}
            <tr
              class="bg-[color:var(--color-surface)] transition-colors hover:bg-[color:var(--color-surface-muted)]"
            >
              <th scope="row" class="px-4 py-3 text-left font-mono font-medium">
                <span class="inline-flex items-center gap-2">
                  {row.epoch}
                  {#if isLiveRow(row)}
                    <span
                      class="rounded-full border border-[color:var(--color-brand-500)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-brand-500)]"
                    >
                      Live
                    </span>
                  {/if}
                </span>
              </th>
              <td class="px-4 py-3 text-right tabular-nums">
                {formatNumberOrDash(row.slotsProduced)} / {formatNumberOrDash(row.slotsAssigned)}
              </td>
              <td class="px-4 py-3 text-right tabular-nums">
                {formatSkipRate(row.slotsSkipped, skipDenominator)}
              </td>
              <td class="px-4 py-3 text-right tabular-nums">
                {#if row.blockBaseFeesTotalSol !== null}
                  ◎{formatSolFixed(row.blockBaseFeesTotalSol, HISTORY_PER_EPOCH_DECIMALS)}
                {:else}
                  <span class="text-[color:var(--color-text-subtle)]" aria-label="no data">—</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-right tabular-nums">
                {#if row.blockPriorityFeesTotalSol !== null}
                  ◎{formatSolFixed(row.blockPriorityFeesTotalSol, HISTORY_PER_EPOCH_DECIMALS)}
                {:else}
                  <span class="text-[color:var(--color-text-subtle)]" aria-label="no data">—</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-right tabular-nums">
                {#if mev.display !== null}
                  <span class="inline-flex items-baseline gap-1.5">
                    ◎{formatSolFixed(mev.display, HISTORY_PER_EPOCH_DECIMALS)}
                  </span>
                {:else}
                  <span class="text-[color:var(--color-text-subtle)]" aria-label="no data">—</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-right tabular-nums">
                {#if row.blockBaseFeesTotalSol !== null && row.blockPriorityFeesTotalSol !== null && row.blockTipsTotalSol !== null}
                  <span class="font-semibold">
                    ◎{formatSolFixed(
                      String(
                        Number(row.blockBaseFeesTotalSol) +
                          Number(row.blockPriorityFeesTotalSol) +
                          Number(row.blockTipsTotalSol),
                      ),
                      HISTORY_PER_EPOCH_DECIMALS,
                    )}
                  </span>
                {:else}
                  <span class="text-[color:var(--color-text-subtle)]" aria-label="no data">—</span>
                {/if}
              </td>
              <td class="px-4 py-3 text-right tabular-nums">
                {#if row.avgComputeUnitsPerProducedBlock !== null}
                  {epochCuText(row.avgComputeUnitsPerProducedBlock)}
                {:else}
                  <span class="text-[color:var(--color-text-subtle)]" aria-label="no data">—</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
