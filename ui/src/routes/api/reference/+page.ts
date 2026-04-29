/**
 * Prerender the interactive Scalar shell. The heavy API-reference
 * runtime is loaded from Scalar's CDN by the page component, so the
 * main app and the lightweight `/api/docs` route do not pay for it.
 */
export const ssr = true;
export const prerender = true;
