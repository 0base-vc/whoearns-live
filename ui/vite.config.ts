import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * In production the UI is served by the indexer's Fastify — same origin,
 * no CORS. In `vite dev`, we're on :5173 while the API is remote, so
 * Vite proxies `/v1/*` and `/healthz` to a backend. This matches what
 * `src/lib/api.ts` expects when `PUBLIC_INDEXER_API_URL` is unset: a
 * same-origin base (`''`) that happens to work in both modes.
 *
 * Falls back to `PUBLIC_SITE_URL` (the canonical-URL env var, also used
 * by `$lib/site`) so a self-hoster who set `PUBLIC_SITE_URL=https://my.example`
 * gets dev proxying to their own backend without a second env var.
 *
 * Final fallback is `http://localhost:8080` — the chart's default API
 * port. Devs running both `pnpm --dir ui dev` and the indexer binary
 * locally get a working setup with zero env vars.
 */
const DEV_API_TARGET =
  process.env.PUBLIC_INDEXER_API_URL ?? process.env.PUBLIC_SITE_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      '/v1': {
        target: DEV_API_TARGET,
        changeOrigin: true,
        secure: true,
      },
      '/healthz': {
        target: DEV_API_TARGET,
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
