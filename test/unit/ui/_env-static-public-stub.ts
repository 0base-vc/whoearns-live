/**
 * Vitest stub for SvelteKit's `$env/static/public` virtual module.
 *
 * `$env/static/public` only exists inside a SvelteKit/Vite build —
 * the plain node-vitest harness cannot resolve it. `vitest.config.ts`
 * aliases the import to this file so UI library modules that read a
 * `PUBLIC_*` env var (e.g. `solana-rpc-client.ts`) can be unit-tested
 * directly. An empty string mirrors the un-set state, exercising each
 * module's documented fallback.
 */
export const PUBLIC_SOLANA_RPC_URL = '';
export const PUBLIC_SITE_URL = '';
export const PUBLIC_INDEXER_API_URL = '';
