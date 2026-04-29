/**
 * Prerender the glossary so the FAQPage JSON-LD ships in static
 * HTML. The layout disables SSR + prerender app-wide for the
 * dynamic income/claim pages; we override both here.
 *
 * Locale: the prerendered shell ships with the EN copy because the
 * locale store falls back to 'en' when there's no browser context
 * (`browser` is false during prerender). Korean visitors get the
 * Korean copy after JS hydrates and the locale store re-resolves.
 */
export const ssr = true;
export const prerender = true;
