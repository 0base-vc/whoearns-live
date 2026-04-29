/**
 * Prerender /api/docs — endpoint catalog is static. Override the
 * layout's app-wide SSR/prerender disable so the page builds as a
 * real `api/docs.html`.
 */
export const ssr = true;
export const prerender = true;
