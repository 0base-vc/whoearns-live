<!--
  Home / landing (redesigned around the live-trend leaderboard).

  Structure:
    1. Hero — brand headline + one-line pitch + slim search ("know the pubkey? jump to it")
    2. Leaderboard — the PRIMARY discovery surface. Top validators by
       live-trend income per slot; each row is a click-through.
    3. Features — three-card explainer (per-epoch / cluster benchmark / open data).

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
      title: 'Cluster benchmark',
      body: 'Every median is contextualized against the top-100 validator sample so you can see whether a validator is earning above or below its peers.',
    },
    {
      title: 'Open data',
      body: 'Everything here comes from a public JSON API. Build your own dashboards, exporters, or automated alerts.',
    },
  ];
</script>

<svelte:head>
  <title>{SITE_NAME} — AI-assisted Solana validator income intelligence</title>
  <meta
    name="description"
    content="AI-assisted open data project by 0base.vc for Solana validator income. Compare live-trend fees, Jito tips, slots, skip rate, and income per slot."
  />
  <link rel="canonical" href={`${SITE_URL}/`} />

  <!-- ItemList schema: tells search engines the homepage lists ranked
       entities, improving rich-result eligibility for "top validators"
       queries. Concrete items are client-fetched; the schema just
       declares the page's shape. -->
  {@html `<script type="application/ld+json">
  ${serializeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Top Solana validators by per-epoch income',
    description: 'Ranked list of Solana mainnet validators by live-trend leader income.',
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
    Solana · Mainnet · AI-assisted open data
  </p>
  <h1 id="hero-title" class="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
    Who's earning on
    <span class="text-[color:var(--color-brand-500)]">Solana right now?</span>
  </h1>
  <p class="mt-4 max-w-2xl text-base text-[color:var(--color-text-muted)]">
    AI-assisted validator income intelligence from on-chain data: per-epoch block fees, Jito tips,
    slots, skip rate, and income per slot for tracked Solana validators.
  </p>

  <form onsubmit={submit} class="mt-6 flex max-w-xl gap-2">
    <div class="min-w-0 flex-1">
      <ValidatorSearchCombobox
        id="home-validator-search"
        label="Validator name, vote pubkey, or identity pubkey"
        placeholder="Search validator name, or paste vote / identity pubkey…"
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
