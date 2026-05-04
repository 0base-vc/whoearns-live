<!--
  App shell. Owns the header, footer, and the skip-link that every
  page inherits. Pages render into `<main id="main">`.

  SEO defaults live in `<svelte:head>` at the LAYOUT level so every
  page gets them for free; individual pages override with their own
  `<svelte:head>` blocks (SvelteKit merges by tag name).
-->
<script lang="ts">
  import '../app.css';
  import { afterNavigate } from '$app/navigation';
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import favicon from '$lib/assets/favicon.svg';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import DelegationCTA from '$lib/components/DelegationCTA.svelte';
  import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
  import { SITE_NAME, SITE_URL } from '$lib/site';
  import { currentLocale, syncLocaleFromUrl } from '$lib/stores/locale.svelte';

  let { children } = $props();

  /**
   * Phase 3 footer-CTA mute. Pages opt into this by returning
   * `hideFooterCta: true` from their loader — the income page does
   * so when the validator's profile has the flag set. Other pages
   * (home, about, claim) keep the CTA.
   *
   * Reads `page.data` which SvelteKit merges across the route tree,
   * so we don't need to plumb this manually.
   */
  const hideFooterCta = $derived<boolean>(
    (page.data as { hideFooterCta?: boolean } | null)?.hideFooterCta === true,
  );

  const LOCALIZED_CONTENT_ROUTES = new Set(['/about', '/faq', '/glossary']);
  const isLocalizedContentRoute = $derived<boolean>(
    LOCALIZED_CONTENT_ROUTES.has(page.url.pathname),
  );

  const DEFAULT_TITLE = `${SITE_NAME} — per-epoch income, fees, and MEV`;
  const DEFAULT_DESCRIPTION = `${SITE_NAME} — open dashboard for Solana validator income. Track per-epoch slot production, block fees, and on-chain Jito tips for any validator on mainnet. Maintained by 0base.vc.`;

  /**
   * Sync `<html lang>` with the active locale on bilingual content pages.
   *
   * Why an effect rather than a static attribute on app.html: the
   * `<html lang>` declaration drives screen-reader pronunciation,
   * Google's content-language signal, and `:lang(ko)` CSS pseudo-
   * class targeting — leaving it pinned to "en" while rendering
   * Korean content is both an accessibility regression (SR pronounces
   * 한글 with English phonemes) and an SEO contradiction (page lang
   * declared `en` while content is Korean confuses Search Console).
   *
   * Reactive form because `app.html` is the static HTML shell —
   * Core product pages (leaderboard, compare, income, claim, API docs)
   * are English-first. Keeping their document language pinned to `en`
   * avoids stale localStorage or `?lang=ko` links making screen readers
   * and crawlers treat English metric tables as Korean.
   */
  $effect(() => {
    if (!browser) return;
    document.documentElement.lang = isLocalizedContentRoute ? currentLocale() : 'en';
  });

  /**
   * Keep the locale rune in sync with the URL bar across browser
   * back/forward navigation. SvelteKit's client router fires
   * `afterNavigate` for in-app navigations including history pop —
   * the locale store's `_locale` rune doesn't auto-react to URL
   * changes (only to `setLocale()` calls), so we re-read here.
   *
   * Without this hook, a visitor who toggled `?lang=ko` then clicks
   * the browser back button to a `?lang=en` URL would see Korean
   * content under an English URL. Real edge case but easy to hit
   * during demos / share-link follow-ups.
   */
  afterNavigate(({ to }) => {
    if (to?.url && LOCALIZED_CONTENT_ROUTES.has(to.url.pathname)) syncLocaleFromUrl(to.url);
  });
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>{DEFAULT_TITLE}</title>
  <meta name="description" content={DEFAULT_DESCRIPTION} />
  <meta name="author" content="0base.vc" />
  <link rel="canonical" href={SITE_URL} />

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content={SITE_NAME} />
  <meta property="og:title" content={DEFAULT_TITLE} />
  <meta property="og:description" content={DEFAULT_DESCRIPTION} />
  <meta property="og:url" content={SITE_URL} />
  <meta property="og:image" content={`${SITE_URL}/og-default.png`} />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <!--
    Default `og:locale` reflects the active locale only on bilingual
    content pages. Core data pages stay English-first.
  -->
  <meta
    property="og:locale"
    content={isLocalizedContentRoute && currentLocale() === 'ko' ? 'ko_KR' : 'en_US'}
  />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={DEFAULT_TITLE} />
  <meta name="twitter:description" content={DEFAULT_DESCRIPTION} />
  <meta name="twitter:image" content={`${SITE_URL}/og-default.png`} />

  <!-- JSON-LD: WebSite + SoftwareApplication so search engines render
       a rich result with the site name, URL, and sitelinks searchbox -->
  {@html `<script type="application/ld+json">
  ${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        name: SITE_NAME,
        url: SITE_URL,
        potentialAction: {
          '@type': 'SearchAction',
          target: `${SITE_URL}/income/{idOrVote}`,
          'query-input': 'required name=idOrVote',
        },
      },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web',
        description: DEFAULT_DESCRIPTION,
        url: SITE_URL,
        author: { '@type': 'Organization', name: '0base.vc', url: 'https://0base.vc' },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    ],
  })}
  </script>`}
  <!--
    Web Analytics: Cloudflare auto-injects its beacon at the proxy
    layer for proxied sites (default-on for orange-cloud domains),
    so this template no longer ships a manual beacon snippet. AI
    crawlers + MCP clients still bypass any JS pixel — their traffic
    is captured by the server-side `/metrics` endpoint (Layer 3).
  -->
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>

<div class="min-h-screen bg-[color:var(--color-surface)] text-[color:var(--color-text-default)]">
  <header
    class="sticky top-0 z-30 border-b border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]/85 backdrop-blur"
  >
    <div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
      <a
        href="/"
        class="flex items-center gap-2.5 text-base font-semibold tracking-tight"
        aria-label={`${SITE_NAME} — home`}
      >
        <!--
          BrandMark uses its own fixed brand colors (violet star + white
          W) — a wrapping `text-...` class isn't needed since the SVG
          doesn't use `currentColor`. Keeping the glyph self-pigmented
          guarantees it matches the favicon, the OG image, and the
          verified-validator badge in EVERY context (light/dark theme,
          inside violet pills, etc.).
        -->
        <BrandMark size={24} />
        <!--
          Visible wordmark uses the SITE_NAME constant from `$lib/site`
          so a fork rebrand is a one-line edit. The brand-violet color
          treatment matches the BrandMark glyph next to it for visual
          cohesion. Older copy here read "Solana Validator Explorer"
          (the chain-qualified product name) — chain context now lives
          inline in the page hero ("Who's earning on Solana right
          now?") instead so the chrome stays brand-clean.
        -->
        <span class="whitespace-nowrap text-[color:var(--color-brand-500)]">
          {SITE_NAME}
        </span>
      </a>

      <!--
        Primary nav. Mobile tap targets ≥ 44 px tall via `min-h-11` on
        each interactive element — the visible label stays at the
        original font size but the hit-area grows to the WCAG 2.5.5
        threshold so touch users don't have to aim precisely at a
        20 px-tall link in a sticky header that easily mis-fires
        adjacent items.
      -->
      <nav aria-label="Primary" class="flex items-center gap-4 text-sm">
        {#if isLocalizedContentRoute}
          <LocaleSwitcher />
        {/if}
        <a
          href="/compare"
          class="hidden min-h-11 items-center text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-text-default)] sm:inline-flex"
        >
          Compare
        </a>
        <a
          href="/api/docs"
          class="hidden min-h-11 items-center text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-text-default)] sm:inline-flex"
        >
          API
        </a>
        <a
          href="https://github.com/0base-vc/whoearns-live"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center text-[color:var(--color-text-muted)] transition-colors hover:text-[color:var(--color-text-default)]"
        >
          GitHub
        </a>
        <!--
          Stake CTA — deep-links to a third-party staking surface for
          0base.vc so the click actually lets the visitor delegate SOL
          (via their wallet), not just land on the marketing site.
          Solana Compass chosen because it has a first-class "Stake"
          button that kicks straight into a Phantom/Solflare flow.
        -->
        <a
          href="https://solanacompass.com/validators/5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ"
          target="_blank"
          rel="noopener noreferrer"
          class="hidden min-h-11 items-center rounded-md border border-[color:var(--color-brand-500)] px-3 text-sm font-semibold text-[color:var(--color-brand-500)] transition-colors hover:bg-[color:var(--color-brand-500)] hover:text-white sm:inline-flex"
        >
          Stake with 0base.vc
        </a>
      </nav>
    </div>
  </header>

  <main id="main" class="mx-auto max-w-6xl px-6 py-10">
    {@render children()}
  </main>

  <footer
    class="mt-20 border-t border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)]"
  >
    <div class="mx-auto max-w-6xl px-6 py-10">
      {#if !hideFooterCta}
        <DelegationCTA />
      {/if}

      <div
        class="mt-8 flex flex-col items-start justify-between gap-3 text-xs text-[color:var(--color-text-subtle)] sm:flex-row sm:items-center"
      >
        <p>
          Data from
          <a
            href={SITE_URL}
            class="font-medium text-[color:var(--color-text-muted)] hover:text-[color:var(--color-brand-500)]"
          >
            {SITE_NAME}
          </a>.
        </p>
        <!--
          Footer nav. Each link wraps a `min-h-11` flex item so tap
          surfaces hit the WCAG 2.5.5 floor without bloating the
          desktop layout — `inline-flex items-center` keeps the
          baseline the same as the surrounding `<p>` text.
        -->
        <nav aria-label="Footer" class="flex flex-wrap items-center gap-x-5 gap-y-1">
          <a
            href="/about"
            class="inline-flex min-h-11 items-center hover:text-[color:var(--color-brand-500)]"
            >About</a
          >
          <a
            href="/glossary"
            class="inline-flex min-h-11 items-center hover:text-[color:var(--color-brand-500)]"
            >Glossary</a
          >
          <a
            href="/faq"
            class="inline-flex min-h-11 items-center hover:text-[color:var(--color-brand-500)]"
            >FAQ</a
          >
          <a
            href="/compare"
            class="inline-flex min-h-11 items-center hover:text-[color:var(--color-brand-500)]"
            >Compare</a
          >
          <a
            href="/api/docs"
            class="inline-flex min-h-11 items-center hover:text-[color:var(--color-brand-500)]"
            >API</a
          >
          <a
            href="https://github.com/0base-vc/whoearns-live"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex min-h-11 items-center hover:text-[color:var(--color-brand-500)]"
            >GitHub</a
          >
          <a
            href="https://0base.vc"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex min-h-11 items-center hover:text-[color:var(--color-brand-500)]"
            >0base.vc</a
          >
        </nav>
      </div>
    </div>
  </footer>
</div>
