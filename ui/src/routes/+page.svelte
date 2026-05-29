<!--
  Home / landing (redesigned around the live-trend leaderboard).

  Structure:
    1. Hero — brand headline + one-line pitch + slim search ("know the pubkey? jump to it")
    2. Leaderboard — the PRIMARY discovery surface. Top validators by
       live-trend income per slot; each row is a click-through.
    3. Features — three-card explainer (per-epoch / peer benchmark / open data).

  Why search was demoted: the original "enter a 44-char pubkey" form as
  the top CTA implied visitors already knew who to look up. For SEO +
  delegator intent + Foundation positioning, the LANDSCAPE view (top
  earners) is the stronger lede. Search stays available but collapses
  to a single input row under the hero once the leaderboard is the
  primary focus.
-->
<script lang="ts">
  import Leaderboard from '$lib/components/Leaderboard.svelte';
  import ValidatorSearchCombobox from '$lib/components/ValidatorSearchCombobox.svelte';
  import { serializeJsonLd } from '$lib/json-ld';
  import { SITE_NAME, SITE_URL } from '$lib/site';

  let input = $state('');
  let searchError = $state<string | null>(null);

  const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const trimmed = input.trim();
    if (trimmed.length === 0) return;
    if (!PUBKEY_RE.test(trimmed)) {
      searchError = 'Select a validator from results or paste a vote / identity pubkey.';
      return;
    }
    window.location.href = `/income/${encodeURIComponent(trimmed)}`;
  }

  const features = [
    {
      title: 'Per-epoch breakdown',
      body: 'Slots assigned / produced, skip rate, block fees, and on-chain Jito tips — final rows for closed epochs, with running totals for the live one.',
    },
    {
      title: 'Peer benchmark',
      body: 'Income is normalized per leader slot and compared against the indexed-validator median, so stake size does not hide execution quality.',
    },
    {
      title: 'Open data',
      body: 'Everything here comes from a public JSON API. Build your own dashboards, exporters, or automated alerts.',
    },
  ];
</script>

<svelte:head>
  <title>{SITE_NAME} — Solana validator income, decomposed per leader slot</title>
  <meta
    name="description"
    content="Open, reproducible data by 0base.vc decomposing Solana validator income per leader slot — base fee, priority fee, and Jito tip kept separate and normalized per slot. Queryable by AI agents via MCP."
  />
  <link rel="canonical" href={`${SITE_URL}/`} />
  <link
    rel="preload"
    href="/v1/leaderboard?limit=25&sort=income_per_slot&window=live_trend"
    as="fetch"
    type="application/json"
    crossorigin="anonymous"
  />
  <link
    rel="preload"
    href="/v1/epoch/current"
    as="fetch"
    type="application/json"
    crossorigin="anonymous"
  />

  <!-- ItemList schema: tells search engines the homepage lists ranked
       entities, improving rich-result eligibility for "top validators"
       queries. Concrete items are client-fetched; the schema just
       declares the page's shape. -->
  {@html `<script type="application/ld+json">
  ${serializeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Top Solana validators by live-trend income per slot',
    description: 'Ranked list of Solana mainnet validators by live-trend income per leader slot.',
    url: `${SITE_URL}/`,
  })}
  </script>`}
</svelte:head>

<section aria-labelledby="hero-title" class="relative">
  <div
    aria-hidden="true"
    class="pointer-events-none absolute inset-x-0 -top-10 -z-10 h-64 bg-gradient-to-b from-[color:var(--color-brand-100)]/60 via-transparent to-transparent dark:from-[color:var(--color-brand-900)]/25"
  ></div>

  <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
    Solana · Mainnet · Open, reproducible data
  </p>
  <h1 id="hero-title" class="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
    Who's earning on
    <span class="text-[color:var(--color-brand-500)]">Solana right now?</span>
  </h1>
  <!--
    Hero subhead states the actual wedge, not "AI". WhoEarns
    decomposes each operator's per-leader-slot income into its three
    real components — base fee, priority fee, Jito tip — kept separate,
    normalized per slot so stake size doesn't flatter anyone, and
    sourced from public on-chain records anyone can reproduce. The
    AI-assist is demoted to the eyebrow/strip, no longer the lede.
  -->
  <p class="mt-4 max-w-2xl text-base text-[color:var(--color-text-muted)]">
    WhoEarns breaks down what each Solana validator actually earns per leader slot — base fee,
    priority fee, and Jito tip kept separate, normalized per slot so stake size doesn't flatter
    anyone, from open on-chain records you can reproduce.
  </p>

  <form onsubmit={submit} class="mt-6 flex max-w-xl gap-2">
    <div class="min-w-0 flex-1">
      <ValidatorSearchCombobox
        id="home-validator-search"
        label="Validator name, vote pubkey, or identity pubkey"
        placeholder="Search validator"
        bind:value={input}
        onSelect={(item) => {
          searchError = null;
          window.location.href = `/income/${encodeURIComponent(item.vote)}`;
        }}
      />
      {#if searchError !== null}
        <p class="mt-1 text-xs text-[color:var(--color-status-warn-fg)]">{searchError}</p>
      {/if}
    </div>
    <button
      type="submit"
      class="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--color-brand-500)] px-5 py-2.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-[color:var(--color-brand-600)] disabled:opacity-40 sm:text-sm"
      disabled={input.trim().length === 0}
    >
      Go
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14M13 5l7 7-7 7"></path>
      </svg>
    </button>
  </form>

  <!--
    AI-agent strip. Real differentiator: the same data is queryable by
    AI agents over an in-process MCP server (`/mcp`) and described for
    crawlers via `llms.txt`. Slim, single-line, links to the API docs
    (the canonical, crawler-friendly catalog already in the nav/footer)
    — present without crowding the leaderboard below.
  -->
  <p class="mt-4 flex items-center gap-2 text-xs text-[color:var(--color-text-subtle)]">
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class="shrink-0 text-[color:var(--color-brand-500)]"
    >
      <rect x="4" y="8" width="16" height="12" rx="2"></rect>
      <path d="M12 8V4M9 4h6M9 14h.01M15 14h.01"></path>
    </svg>
    <span>
      Built to be queryable by AI agents — MCP server and
      <code class="font-mono">llms.txt</code> for programmatic access.
      <a href="/api/docs" class="font-medium text-[color:var(--color-brand-500)] hover:underline">
        See the API
      </a>
    </span>
  </p>
</section>

<div class="mt-10">
  <Leaderboard limit={25} />
</div>

<section aria-labelledby="features-title" class="mt-16">
  <h2
    id="features-title"
    class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
  >
    What you can see
  </h2>
  <div class="mt-4 grid gap-4 sm:grid-cols-3">
    {#each features as f (f.title)}
      <div
        class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
      >
        <h3 class="text-base font-semibold">{f.title}</h3>
        <p class="mt-2 text-sm leading-relaxed text-[color:var(--color-text-muted)]">{f.body}</p>
      </div>
    {/each}
  </div>
</section>
