<!--
  Validator income detail page.

  This file was rebuilt 2026-04-25 after a two-agent UX review
  (structure + critique) surfaced several issues with the previous
  layout:

    - Lifetime total income was the PRIMARY reason users open this
      page but was cramped into a side-dl. Promoted to the hero
      number (text-4xl / text-5xl, accent).
    - Running-epoch card had 8 equal-weight KPI tiles competing for
      attention. Collapsed to a single "Total so far" hero figure +
      "slots produced / assigned" + a "Breakdown" disclosure that
      reveals the base / priority / live MEV tips split for power
      users who want it.
    - Epoch progress used to be a standalone flex column with its
      own label. Inlined as a thin sliver under the "Running epoch"
      header with a `~Xh left` caption — context, not content.
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
    - Status legend was ABOVE the table, separating the content
      from the vocabulary that explains it. Moved BELOW the table/
      cards so readers see the data first, then the legend as a
      footnote (an accessibility trade-off — the SR `<caption>` still
      covers vocabulary-before-data for that path).
    - Freshness indicator was the 8th KPI tile in the running-epoch
      grid, invisible at a glance. Promoted to a pulsing dot +
      "updated 23s ago" next to the running-epoch title.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import type { ValidatorEpochRecord } from '$lib/types';
  import {
    formatNumberOrDash,
    formatSkipRate,
    formatSol,
    formatSolFixed,
    formatTimestamp,
    shortenPubkey,
  } from '$lib/format';

  import IncomeChart from '$lib/components/IncomeChart.svelte';
  import Card from '$lib/components/Card.svelte';
  import AddressDisplay from '$lib/components/AddressDisplay.svelte';
  import EllipsisAddress from '$lib/components/EllipsisAddress.svelte';
  import VerifiedBadge from '$lib/components/VerifiedBadge.svelte';
  import Tooltip from '$lib/components/Tooltip.svelte';
  import { SITE_NAME, SITE_URL } from '$lib/site';

  // Per-row decimal counts in the epoch-history table. Fixed-
  // precision SOL renders so decimal points line up across rows —
  // the `formatSol` helper trims trailing zeros (great in isolation,
  // bad in a sortable table). See `ui/src/lib/format.ts` for the
  // rationale behind the specific counts.
  const HISTORY_PER_EPOCH_DECIMALS = 3;

  // Solana's target slot time is ~400ms; leader-schedule calculations
  // in the indexer already use this constant. Used here ONLY for the
  // "~Xh left in this epoch" readout — a visualisation aid, not an
  // accurate countdown. Real slot time drifts 5-10% with network load;
  // we round aggressively (hours/mins, no seconds) so the noise isn't
  // visible to the user.
  const APPROX_SLOT_MS = 400;

  /**
   * `relativeNow` drives `formatTimestamp()` and the "updated Xs ago"
   * ticker so relative timestamps advance without a page reload.
   * Incremented on a timer in `onMount`. The actual DATA doesn't
   * refetch — only the relative-time rendering. Cheapest possible
   * "live-feel" UX: no extra HTTP calls, no server load, just makes
   * the existing stale-indicator readable.
   *
   * Backend data freshness is a separate axis, driven by the polling
   * fee-ingester (30s) and the gRPC live-path (sub-second when
   * enabled). A user who wants truly fresh numbers still needs F5,
   * but at least the timestamp won't deceive them.
   */
  let relativeNow = $state(new Date());
  onMount(() => {
    // 10-second tick is the sweet spot: fine enough that "13s" → "23s"
    // visibly updates while a user is looking, coarse enough that the
    // browser doesn't spin a setInterval at 1Hz for no reason.
    const id = setInterval(() => {
      relativeNow = new Date();
    }, 10_000);
    return () => clearInterval(id);
  });

  let { data }: { data: PageData } = $props();

  const history = $derived(data.history);
  const currentEpoch = $derived(data.currentEpoch);

  /**
   * True when the user hit an unknown pubkey and the indexer just
   * auto-tracked it. The first rendered response is always empty
   * (`items.length === 0`) — subsequent reloads progressively fill
   * in the previous epoch's stats (fee-ingester tick every 30s) and
   * then the running epoch in real time.
   */
  const isTracking = $derived<boolean>(history.tracking === true);
  const trackingMessage = $derived<string | null>(history.trackingMessage ?? null);

  const currentRow = $derived<ValidatorEpochRecord | undefined>(
    currentEpoch === null ? undefined : history.items.find((r) => r.epoch === currentEpoch.epoch),
  );
  const historyWithoutCurrent = $derived<ValidatorEpochRecord[]>(
    currentRow === undefined ? history.items : history.items.filter((r) => r !== currentRow),
  );

  const lifetimeFeesSol = $derived<number>(
    history.items.reduce((acc, r) => {
      const v = r.blockFeesTotalSol === null ? 0 : Number(r.blockFeesTotalSol);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0),
  );
  const lifetimeMevSol = $derived<number>(
    history.items.reduce((acc, r) => {
      const v = r.blockTipsTotalSol === null ? 0 : Number(r.blockTipsTotalSol);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0),
  );
  const lifetimeTotalSol = $derived<number>(lifetimeFeesSol + lifetimeMevSol);

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

  /**
   * True when we have a current-epoch KPI row to show. Distinct from
   * `currentEpoch !== null` because the cluster might know the
   * current epoch while our indexer hasn't produced a row for this
   * validator yet (freshly tracked, or the validator isn't a leader
   * this epoch).
   */
  const hasRunningKpis = $derived<boolean>(currentRow !== undefined);

  const epochProgressPct = $derived<number | null>(
    currentEpoch === null || currentEpoch.slotsElapsed === null || currentEpoch.slotCount === 0
      ? null
      : (currentEpoch.slotsElapsed / currentEpoch.slotCount) * 100,
  );

  /**
   * Rough "time left in this epoch" in minutes. Uses the ~400ms/slot
   * nominal rate; network load can make this off by 5-10%, so we
   * render in coarse units (hours/mins) rather than seconds to keep
   * the imprecision invisible.
   *
   * Returns null if any input is missing (null slotsElapsed, zero
   * slotCount). The UI shows "—" in that case.
   */
  const minutesLeftInEpoch = $derived.by<number | null>(() => {
    if (currentEpoch === null) return null;
    if (currentEpoch.slotsElapsed === null) return null;
    const slotsRemaining = Math.max(0, currentEpoch.slotCount - currentEpoch.slotsElapsed);
    return Math.round((slotsRemaining * APPROX_SLOT_MS) / 60_000);
  });

  const epochTimeLeftLabel = $derived.by<string | null>(() => {
    const m = minutesLeftInEpoch;
    if (m === null) return null;
    if (m <= 0) return 'closing';
    if (m < 60) return `~${m}m left`;
    const hours = Math.round(m / 60);
    return `~${hours}h left`;
  });

  /**
   * Epoch label shown in the hero and running-epoch cards. Guards
   * against transient API states where the backend might hand back a
   * zero or negative epoch during a cold-start window (freshly-created
   * embedded Postgres, migration in progress, epoch-watcher hasn't
   * ticked yet). Displaying "-1" or "0" is confusing — em-dash signals
   * "not known yet" consistently with the other fallbacks.
   */
  const currentEpochLabel = $derived<string>(
    currentEpoch === null || !Number.isInteger(currentEpoch.epoch) || currentEpoch.epoch <= 0
      ? '—'
      : String(currentEpoch.epoch),
  );

  const shortVote = $derived(shortenPubkey(history.vote, 6, 6));
  // Prefer moniker in the <title> tag — makes browser tabs, OS
  // recents, and shared-link previews actually readable. Falls back
  // to the short pubkey for unregistered validators.
  const titleLabel = $derived(history.name ?? shortVote);
  const pageTitle = $derived(`${titleLabel} — Solana validator income | ${SITE_NAME}`);
  const pageDescription = $derived(
    `Per-epoch income for Solana validator ${history.vote}: block fees, on-chain Jito tips, slot production, and cluster-median comparison over the last ${history.items.length} epochs.`,
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
        name: `${history.name ?? shortenPubkey(history.vote, 6, 6)} — Solana validator income | ${SITE_NAME}`,
        inLanguage: 'en',
        description: operatorNarrative ?? pageDescription,
        url: `${SITE_URL}/income/${history.vote}`,
        creator: { '@type': 'Organization', name: '0base.vc' },
        license: 'https://creativecommons.org/publicdomain/zero/1.0/',
        keywords: ['Solana', 'validator', 'MEV', 'Jito', 'block fees', history.vote],
        variableMeasured: [
          {
            '@type': 'PropertyValue',
            name: 'totalIncomeSol',
            value: lifetimeTotalSol > 0 ? lifetimeTotalSol.toFixed(9) : '0',
            description:
              'Lifetime block fees + on-chain Jito tip earnings (in SOL) across indexed epochs',
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
   * Total income for the running epoch "so far" — the one big number
   * that replaces the 3-tile base/priority/MEV split at the top of
   * the running-epoch card. Returns null when any of the three
   * components is null (we don't want to advertise a partial sum
   * that might mislead — a null in one stream is a null in the
   * total, same semantic as the history table's Total column).
   */
  const runningTotalSol = $derived.by<number | null>(() => {
    if (currentRow === undefined) return null;
    if (
      currentRow.blockBaseFeesTotalSol === null ||
      currentRow.blockPriorityFeesTotalSol === null ||
      currentRow.blockTipsTotalSol === null
    ) {
      return null;
    }
    return (
      Number(currentRow.blockBaseFeesTotalSol) +
      Number(currentRow.blockPriorityFeesTotalSol) +
      Number(currentRow.blockTipsTotalSol)
    );
  });

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
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={pageDescription} />
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
  {@html `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`}
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

<!-- ─────────── 1. Validator hero (identity + lifetime) ─────────── -->
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
        {#if history.iconUrl && !iconLoadFailed}
          <img
            src={history.iconUrl}
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
              <VerifiedBadge size={18} />
            {/if}
          </h1>
          <!--
            Vote pubkey under the moniker. `EllipsisAddress` is
            elastic: on iPhone Pro and narrower viewports it
            middle-truncates ("5BAi9Y…C6uBPZ") so the address sits
            on a single line and the hero stays vertically tight;
            on tablet+ where 318 px fits comfortably, the full
            44-char pubkey renders. Copy-on-select still yields
            the full pubkey via the component's clipboard hijack.
            Earlier this used `break-all` which wrapped to two
            lines on iPhone Pro — visually noisy.
          -->
          <p class="mt-0.5">
            <EllipsisAddress
              pubkey={history.vote}
              class="font-mono text-xs text-[color:var(--color-text-subtle)]"
            />
          </p>
        {:else}
          <h1
            class="mt-1 flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl"
            aria-label="Validator vote pubkey {history.vote}"
          >
            <span class="truncate">{shortVote}</span>
            {#if history.claimed}
              <VerifiedBadge size={18} />
            {/if}
          </h1>
        {/if}
        {#if history.website}
          <!--
            Website is user-supplied on-chain; treat as untrusted link.
            `rel="noopener noreferrer nofollow"` prevents window.opener
            leak + discourages SEO pass-through to spammy registrations.
          -->
          <p class="mt-1.5 truncate text-xs">
            <a
              href={history.website}
              target="_blank"
              rel="noopener noreferrer nofollow"
              class="text-[color:var(--color-brand-500)] hover:underline"
            >
              {history.website} ↗
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
            {history.profile ? 'Edit profile ›' : 'Are you the operator? Claim this validator ›'}
          </a>
        </p>
      </div>
    </div>

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
      <div class="shrink-0 text-left lg:min-w-64 lg:text-right">
        <p
          class="inline-flex items-center text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
        >
          Total income · last {history.items.length} epochs
          <Tooltip
            label="About lifetime income"
            content="Block fees + on-chain Jito tips summed across the most recent epochs we've indexed. Pre-commission — this is what the operator earned, not what delegators received."
          />
        </p>
        <p
          class="mt-1 text-4xl font-semibold tracking-tight text-[color:var(--color-brand-500)] sm:text-5xl"
        >
          ◎{formatSol(lifetimeTotalSol.toString())}
        </p>
      </div>
    {/if}
  </div>

  <!--
    Addresses moved below the hero row so the money-shot gets a clean
    horizontal band to dominate. On mobile they stack naturally under
    the identity block; on desktop they form a two-column strip.
  -->
  <dl
    class="mt-5 grid grid-cols-1 gap-3 border-t border-[color:var(--color-border-default)] pt-4 sm:grid-cols-2"
  >
    <AddressDisplay
      pubkey={history.vote}
      variant="block"
      label="Vote"
      head={8}
      tail={8}
      tooltip="The on-chain vote account. Stakers delegate to this address. Each validator has exactly one fixed vote account that lives forever — even across re-keys."
    />
    <AddressDisplay
      pubkey={history.identity}
      variant="block"
      label="Identity"
      head={8}
      tail={8}
      tooltip="The validator's identity keypair — the hot key that signs blocks and votes. Operators can rotate this key periodically while keeping the same vote account."
    />
  </dl>
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

<!-- ─────────── 2. Running-epoch card ─────────── -->
<!--
  Skipped entirely during the initial tracking window — there's
  nothing useful to show (all tiles would render "—" and the user
  already has the tracking banner above). Re-enabled automatically
  once `currentRow` materialises.
-->
{#if currentEpoch && hasRunningKpis}
  <Card tone="accent" class="mt-6">
    <!--
      Header row: epoch label + status + freshness on the left; the
      "Total so far" hero figure on the right. Stacks vertically on
      mobile (`< sm`) so the two blocks never overlap on narrow
      viewports — the right column's right-align would otherwise crash
      into the left column's progress-bar caption at ~400px widths.
    -->
    <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-x-6">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p
            class="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-subtle)]"
          >
            Running epoch
          </p>
          <p class="flex items-baseline gap-2 text-2xl font-semibold">
            <span class="font-mono">{currentEpochLabel}</span>
            {#if currentRow}
              <span
                class="rounded-full border border-[color:var(--color-border-default)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-text-muted)]"
              >
                {currentRow.isFinal ? 'Final' : 'Running'}
              </span>
            {/if}
          </p>
          <!--
            Freshness indicator — single source of live-feel. Pulsing
            dot anchors attention; the ticker copy actually earns its
            value here vs. buried as the 8th KPI tile. `motion-reduce`
            collapses animation for users who've asked for it.
          -->
          {#if currentRow}
            <span
              class="flex items-center gap-1.5 text-xs text-[color:var(--color-text-muted)]"
              aria-label={`Last updated ${formatTimestamp(currentRow.lastUpdatedAt, relativeNow)}`}
            >
              <span
                aria-hidden="true"
                class="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-brand-500)] motion-safe:animate-pulse"
              ></span>
              <span class="font-mono tabular-nums">
                updated {formatTimestamp(currentRow.lastUpdatedAt, relativeNow)}
              </span>
            </span>
          {/if}
        </div>

        <!--
          Progress bar — inlined thin sliver, context not content.
          Drops below the title on wrap; otherwise shares the row
          with the total-income hero. `~Xh left` replaces the
          previous bare percentage because "50% done" on a 432,000-
          slot epoch means wildly different things time-wise
          depending on when you land.
        -->
        {#if epochProgressPct !== null}
          <div class="mt-2.5 max-w-md">
            <div class="flex items-baseline justify-between gap-2 text-[11px]">
              <span
                class="font-mono tabular-nums text-[color:var(--color-text-muted)]"
                title={currentEpoch.slotsElapsed !== null
                  ? `${currentEpoch.slotsElapsed.toLocaleString()} / ${currentEpoch.slotCount.toLocaleString()} slots`
                  : undefined}
                >{epochProgressPct.toFixed(1)}%{epochTimeLeftLabel
                  ? ` · ${epochTimeLeftLabel}`
                  : ''}</span
              >
            </div>
            <div
              class="mt-1 h-1 overflow-hidden rounded-full bg-[color:var(--color-surface-muted)]"
              role="progressbar"
              aria-valuenow={epochProgressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Epoch ${currentEpoch.epoch} is ${epochProgressPct.toFixed(1)}% complete`}
            >
              <div
                class="h-full bg-[color:var(--color-brand-500)] transition-[width]"
                style:width={`${epochProgressPct.toFixed(2)}%`}
              ></div>
            </div>
          </div>
        {/if}
      </div>

      <!--
        The running-epoch hero number: "Total so far". One figure,
        prominent, accent-coloured. Replaces the 3-tile base/
        priority/MEV split at the top; the split is available
        one click away in the disclosure below.

        Null state ("—") when any of the three streams is null —
        consistent with the history table's Total column and avoids
        misleading partial sums during the first few blocks of a
        new epoch.
      -->
      <div class="text-left sm:text-right">
        <p
          class="inline-flex items-center text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
        >
          Total so far
          <Tooltip
            label="About running-epoch total"
            align="right"
            content="Block fees + Jito tips earned since the running epoch started. Will keep growing as the validator produces more blocks until the epoch closes."
          />
        </p>
        {#if runningTotalSol !== null}
          <p
            class="mt-1 text-3xl font-semibold tracking-tight text-[color:var(--color-brand-500)] sm:text-4xl"
          >
            ◎{formatSol(String(runningTotalSol))}
          </p>
        {:else}
          <p class="mt-1 text-3xl text-[color:var(--color-text-subtle)] sm:text-4xl">—</p>
        {/if}
        {#if currentRow}
          <p class="mt-0.5 text-xs text-[color:var(--color-text-muted)]">
            {formatNumberOrDash(currentRow.slotsProduced)} / {formatNumberOrDash(
              currentRow.slotsAssigned,
            )} slots · {formatSkipRate(currentRow.slotsSkipped, currentRow.slotsAssigned)} skipped
          </p>
        {/if}
      </div>
    </div>

    <!--
      Breakdown disclosure. `<details>` is HTML-native, keyboard/SR
      accessible for free, and gets remembered per-session via the
      `name` attribute so repeat visitors don't have to re-click.
      Initial closed state keeps the page calm; power users
      expand and the split is right there.
    -->
    {#if currentRow}
      <details
        class="mt-4 group border-t border-[color:var(--color-border-default)] pt-3"
        name="running-breakdown"
      >
        <summary
          class="cursor-pointer list-none select-none text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-default)]"
        >
          <span class="inline-block transition-transform group-open:rotate-90" aria-hidden="true"
            >▸</span
          >
          Breakdown
        </summary>
        <dl class="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <dt
              class="inline-flex items-center text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              Base fees
              <Tooltip
                label="About base fees"
                content="The fixed 5,000-lamport-per-signature fee every Solana transaction pays. Always paid regardless of network load."
              />
            </dt>
            <dd class="mt-0.5 font-mono text-sm tabular-nums">
              {#if currentRow.blockBaseFeesTotalSol !== null}
                ◎{formatSol(currentRow.blockBaseFeesTotalSol)}
              {:else}
                <span class="text-[color:var(--color-text-subtle)]">—</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt
              class="inline-flex items-center text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              Priority fees
              <Tooltip
                label="About priority fees"
                content="Optional extra users pay to outbid others for inclusion in busy blocks. Since SIMD-96, 100% of priority fees go to the leader (zero burn)."
              />
            </dt>
            <dd class="mt-0.5 font-mono text-sm tabular-nums">
              {#if currentRow.blockPriorityFeesTotalSol !== null}
                ◎{formatSol(currentRow.blockPriorityFeesTotalSol)}
              {:else}
                <span class="text-[color:var(--color-text-subtle)]">—</span>
              {/if}
            </dd>
          </div>
          <div>
            <dt
              class="inline-flex items-center text-xs uppercase tracking-wide text-[color:var(--color-text-muted)]"
            >
              MEV tips (gross)
              <Tooltip
                label="About MEV tips"
                content="Jito tips traders deposit on-chain to land bundles in this validator's blocks. 'Gross' because Jito's TipRouter takes a 3% fee before the final payout."
              />
            </dt>
            <dd class="mt-0.5 font-mono text-sm tabular-nums">
              {#if currentRow.blockTipsTotalSol !== null}
                ◎{formatSol(currentRow.blockTipsTotalSol)}
              {:else}
                <span class="text-[color:var(--color-text-subtle)]">—</span>
              {/if}
            </dd>
          </div>
        </dl>
      </details>
    {/if}
  </Card>
{/if}

<!-- ─────────── 3. Income trend chart ─────────── -->
<!--
  Hidden during the initial tracking window: an empty chart card is a
  "nothing here" signal that stacks redundantly with the tracking
  banner + Validator card. Shows as soon as `items.length > 0`.
-->
{#if hasAnyHistory}
  <div class="mt-6">
    <IncomeChart history={history.items} />
  </div>
{/if}

<!-- ─────────── 4. Epoch income history ─────────── -->
<section aria-labelledby="history-title" class="mt-10">
  <div class="mb-4">
    <h2 id="history-title" class="text-lg font-semibold">Epoch income history</h2>
  </div>

  {#if historyWithoutCurrent.length === 0 && !currentRow}
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

      Both views read from the same `historyWithoutCurrent` array —
      single source of truth, no drift between responsive modes.
    -->
    <!-- Mobile: stacked cards -->
    <ul class="space-y-3 md:hidden">
      {#each historyWithoutCurrent as row (row.epoch)}
        {@const mev = unifiedMevFor(row)}
        {@const total =
          row.blockBaseFeesTotalSol !== null &&
          row.blockPriorityFeesTotalSol !== null &&
          row.blockTipsTotalSol !== null
            ? Number(row.blockBaseFeesTotalSol) +
              Number(row.blockPriorityFeesTotalSol) +
              Number(row.blockTipsTotalSol)
            : null}
        <li>
          <Card>
            <div class="flex items-baseline justify-between gap-3">
              <div class="flex items-baseline gap-3">
                <span class="font-mono text-lg font-semibold">Epoch {row.epoch}</span>
                <span class="text-xs font-medium text-[color:var(--color-text-muted)]">
                  {row.isFinal ? 'Final' : 'Running'}
                </span>
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
                  {formatSkipRate(row.slotsSkipped, row.slotsAssigned)}
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
              <div class="col-span-2">
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
            </dl>
          </Card>
        </li>
      {/each}
    </ul>

    <!-- Desktop: table -->
    <div
      class="hidden md:block overflow-x-auto rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]"
    >
      <table
        class="min-w-full divide-y divide-[color:var(--color-border-default)] text-sm"
        aria-describedby="status-legend"
      >
        <caption class="sr-only">
          Epoch income history for validator {history.vote}, newest epoch first. Income is
          decomposed into three revenue streams: gross base fees, gross priority fees, and Jito MEV
          tips. The MEV column shows on-chain Jito tips derived from produced blocks.
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
                  align="right"
                  content="Base fees + Priority fees + MEV — every revenue stream the indexer can see, summed."
                />
              </span>
            </th>
            <th scope="col" class="px-4 py-3 text-center">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[color:var(--color-border-default)]">
          {#each historyWithoutCurrent as row (row.epoch)}
            {@const mev = unifiedMevFor(row)}
            <tr
              class="bg-[color:var(--color-surface)] transition-colors hover:bg-[color:var(--color-surface-muted)]"
            >
              <th scope="row" class="px-4 py-3 text-left font-mono font-medium">{row.epoch}</th>
              <td class="px-4 py-3 text-right tabular-nums">
                {formatNumberOrDash(row.slotsProduced)} / {formatNumberOrDash(row.slotsAssigned)}
              </td>
              <td class="px-4 py-3 text-right tabular-nums">
                {formatSkipRate(row.slotsSkipped, row.slotsAssigned)}
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
              <td class="px-4 py-3 text-center">
                <span class="text-xs font-medium text-[color:var(--color-text-muted)]">
                  {row.isFinal ? 'Final' : 'Running'}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
