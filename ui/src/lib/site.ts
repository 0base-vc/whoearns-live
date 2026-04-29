/**
 * Single source of truth for site-wide identity strings (canonical URL,
 * site name). Every page/component that emits a canonical/og:url/JSON-LD
 * URL MUST import from here — never hard-code the production domain.
 *
 * Why a build-time env (`PUBLIC_SITE_URL`) and not a runtime fetch:
 * - SvelteKit's `adapter-static` produces a SPA, so there is no SSR window
 *   to inject runtime config.
 * - Meta/canonical/JSON-LD must be emitted at first paint for crawlers
 *   that don't run JS — the value has to be inlined in the bundle.
 * - Self-hosters set `PUBLIC_SITE_URL` once at build time. Default is a
 *   localhost placeholder so production deploys without override fail loudly
 *   (crawler logs show localhost) — better than baking an upstream operator's
 *   domain into a fork's bundle and silently degrading their SEO for weeks.
 *
 * Trailing-slash hygiene: callers append paths with a leading `/`, so we
 * strip any trailing slashes here. `${SITE_URL}/about` always produces
 * `https://example.com/about`, never `https://example.com//about`.
 */
// Use SvelteKit's `$env/static/public` rather than Vite's
// `import.meta.env.PUBLIC_*`. Vite's default `envPrefix` is `VITE_`,
// and even though `@sveltejs/kit/vite` adds `PUBLIC_*` to the public
// env loader, the resulting `import.meta.env.PUBLIC_FOO` reference is
// only inlined inconsistently across build phases — empirically, the
// SPA bundle picks it up but adapter-static's prerender step does
// NOT, so canonical/og:url ended up baking the FALLBACK while the
// runtime SPA bundle had the right value.
//
// `$env/static/public` is SvelteKit's first-class API for build-time
// env replacement: it emits `_app/env.js` AND inlines references at
// the prerender stage, so HTML `<head>` tags and the SPA bundle stay
// in sync. The trade-off is that PUBLIC_SITE_URL must be a known
// identifier (declared in `.env` or set in the build environment) —
// `ui/.env` ships an empty placeholder so type checks pass even when
// no override is supplied.
import { PUBLIC_SITE_URL } from '$env/static/public';

const RAW_FROM_ENV = PUBLIC_SITE_URL ?? '';
// Local-dev placeholder. ANY production deployment MUST override via
// `PUBLIC_SITE_URL` or the helm chart's `config.siteUrl`.
//
// Why localhost instead of a real reference domain: this codebase is
// open-source and forks who forget to override would otherwise leak the
// upstream operator's brand into THEIR canonical/og:url/JSON-LD tags,
// silently degrading their SEO. A localhost fallback is a "loud" failure —
// any crawler log immediately surfaces it, and operators catch it in
// minutes instead of the silent-domain-leak which can persist for weeks.
const FALLBACK = 'http://localhost:8080';
const RAW = RAW_FROM_ENV.length > 0 ? RAW_FROM_ENV : FALLBACK;
export const SITE_URL: string = RAW.replace(/\/+$/, '');

/**
 * Brand display name. Lives next to SITE_URL because both are used by the
 * same SEO/structured-data emit sites (layout `<svelte:head>`, JSON-LD,
 * og:site_name, page titles) and forks rebranding the project want to
 * change them together. Single source of truth — every visible "WhoEarns"
 * string in the UI threads through here, so a fork rebrand is a one-line
 * edit (with optional matching change in backend `core/config.ts`'s
 * SITE_NAME default for sitemap/llms/MCP responses).
 */
export const SITE_NAME = 'WhoEarns';
