import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
  },
  kit: {
    // Static SPA bundle served by Fastify. The fallback is a thin shell
    // for SPA-only deep links (`/income/:vote`, `/compare`, …); pages
    // marked `export const prerender = true` get their own .html with
    // SEO-friendly meta + JSON-LD baked in.
    //
    // Why the fallback ISN'T `index.html`: SvelteKit's adapter-static
    // overwrites the fallback file last, so a prerendered homepage at
    // `build/index.html` would be clobbered by an empty SPA shell. We
    // give the fallback a dedicated name (`spa-fallback.html`) so the
    // prerendered homepage survives, and tell the Fastify
    // notFoundHandler to serve THIS file instead of `index.html` for
    // unknown deep-link routes. Net effect: `/` ships full SEO
    // metadata, `/income/:vote` ships the bare shell + hydrates client-
    // side (same behaviour as before for dynamic pages).
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'spa-fallback.html',
      strict: false,
    }),
    prerender: {
      // The static SvelteKit build doesn't know about Fastify-served
      // routes (`/openapi.yaml`, `/sitemap.xml`, `/llms.txt`,
      // `/og/*.png`, `/.well-known/*`, `/mcp`, `/v1/*`). When a
      // prerendered page links to one of these (the API-docs page
      // links to `/openapi.yaml`, the income-page meta references
      // `/og/<vote>.png`), the prerenderer follows the link, gets a
      // 404 from the dev server, and aborts the whole build.
      //
      // We swallow exactly those paths via `handleHttpError`.
      // Anything ELSE that 404s is still a real prerender bug
      // (broken intra-app link, typo in href) and should fail loud.
      handleHttpError: ({ path, referrer, message }) => {
        const fastifyServed = [
          '/openapi.yaml',
          '/sitemap.xml',
          '/robots.txt',
          '/llms.txt',
          '/llms-full.txt',
          '/healthz',
        ];
        const fastifyServedPrefixes = ['/og/', '/og-default', '/.well-known/', '/mcp', '/v1/'];
        if (fastifyServed.includes(path)) return;
        if (fastifyServedPrefixes.some((p) => path.startsWith(p))) return;
        // Re-raise anything else so a typo in a `<a href>` still
        // blocks the build.
        throw new Error(`Prerender ${path} (linked from ${referrer}): ${message}`);
      },
    },
  },
};

export default config;
