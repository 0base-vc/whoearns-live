/**
 * Homepage prerender opts. The layout disables SSR + prerender app-
 * wide (the income/claim pages are dynamic and have to stay SPA-
 * only); we explicitly re-enable both here so the build emits a
 * fully-rendered `index.html` with the ItemList JSON-LD, hero copy,
 * and meta tags baked in.
 *
 * The leaderboard `<table>` rows still hydrate client-side after
 * the JS bundle loads — the LeaderboardComponent's `onMount` fetch
 * doesn't run during prerendering, so the prerendered HTML ships
 * with placeholder/empty rows. That's fine: SEO + social-card
 * crawlers care about meta + structured data, and human visitors
 * see the table populate within ~200ms of hydration.
 */
export const ssr = true;
export const prerender = true;
