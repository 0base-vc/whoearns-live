/**
 * Ambient declaration of SvelteKit's `$env/static/public` virtual
 * module for the ROOT `tsc --noEmit` typecheck.
 *
 * SvelteKit generates the real `$env/static/public` types only inside
 * `ui/.svelte-kit/` (consumed by `svelte-check` against `ui/tsconfig.json`).
 * The root `tsc` typechecks `test/**` — including `test/unit/ui/*.test.ts`,
 * which transitively imports `ui/src/lib/solana-rpc-client.ts`, which
 * imports this virtual module. Without this declaration root `tsc`
 * fails with TS2307.
 *
 * `vitest.config.ts` separately aliases the same import to a runtime
 * stub so the tests can actually execute.
 */
declare module '$env/static/public' {
  export const PUBLIC_SOLANA_RPC_URL: string;
  export const PUBLIC_SITE_URL: string;
  export const PUBLIC_INDEXER_API_URL: string;
}
