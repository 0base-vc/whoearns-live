// Pure SPA: disable SSR and prerender across the whole app so the build
// is a single static HTML shell + JS bundle. Data loading happens in
// `+page.ts` `load` functions, which run client-side on navigation.
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';
