<!--
  Home / landing (redesigned around the leaderboard).

  Structure:
    1. Hero — brand headline + one-line pitch + slim search ("know the pubkey? jump to it")
    2. Leaderboard — the PRIMARY discovery surface. Top validators by
       last-epoch income; each row is a click-through.
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
  import { serializeJsonLd } from '$lib/json-ld';
  import { SITE_NAME, SITE_URL } from '$lib/site';

  let input = $state('');

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const trimmed = input.trim();
    if (trimmed.length === 0) return;
    window.location.href = `/income/${encodeURIComponent(trimmed)}`;
  }

  const features = [
    {
      title: 'Per-epoch breakdown',
      body: 'Slots assigned / produced, skip rate, block fees, and on-chain Jito tips — one row per closed epoch, with running totals for the live one.',
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
    content="AI-assisted open data project by 0base.vc for Solana validator income. Compare closed-epoch fees, Jito tips, slots, skip rate, and performance."
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
    description:
      'Ranked list of Solana mainnet validators by total leader income in the most recent closed epoch.',
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
    slots, skip rate, and performance for tracked Solana validators.
  </p>

  <form onsubmit={submit} class="mt-6 flex max-w-xl gap-2">
    <label for="pubkey" class="sr-only">Validator vote or identity pubkey</label>
    <!--
      iOS Safari auto-zooms on focus when the input's computed
      font-size is < 16 px, then doesn't zoom back out — leaves the
      visitor stuck in a half-zoomed layout until they pinch out
      manually. `text-base` (16 px) on mobile defuses that; `sm:text-sm`
      restores the original 14 px monospace look on tablet+ where the
      auto-zoom rule doesn't apply. Same pattern below for the submit
      button so the row keeps its baseline alignment.
    -->
    <input
      id="pubkey"
      name="pubkey"
      type="text"
      bind:value={input}
      placeholder="Know a vote or identity pubkey? Jump to it…"
      class="flex-1 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-elevated)] px-4 py-2.5 font-mono text-base shadow-sm placeholder:text-[color:var(--color-text-subtle)] focus:border-[color:var(--color-brand-500)] sm:text-sm"
      autocomplete="off"
      spellcheck="false"
    />
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
