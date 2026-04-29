/**
 * Prerender /about — pure static content. Layout-level SSR + prerender
 * are disabled by default for the dynamic pages, so we override both
 * explicitly here.
 */
export const ssr = true;
export const prerender = true;
