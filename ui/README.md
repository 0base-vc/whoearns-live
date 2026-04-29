# WhoEarns UI

SvelteKit UI for browsing per-epoch Solana validator income — slot production,
block fees, and on-chain Jito tips — powered by the
[WhoEarns](https://github.com/0base-vc/whoearns-live) API.

## Pages

- `/` — search by vote or identity pubkey.
- `/income/:idOrVote` — income history for a validator. Accepts either a vote
  pubkey or an identity pubkey; the API resolves both.

## Quickstart

```bash
pnpm install
pnpm run dev
# http://localhost:5173
```

By default the dev server proxies to `http://localhost:8080` (the WhoEarns
API port). Set `PUBLIC_INDEXER_API_URL` at build time to point at a staging
or remote backend (e.g., the 0base reference deployment at
`https://whoearns.live`).

## Deploy

The production Docker image builds this UI with SvelteKit `adapter-static`
and serves it from Fastify. For standalone preview, run `pnpm run build` and
serve `ui/build/` with any static file server.

## Contract

Response shape is mirrored in `src/lib/types.ts`. Keep this in sync with the
the WhoEarns
[`docs/openapi.yaml`](https://github.com/0base-vc/whoearns-live/blob/main/docs/openapi.yaml)
when the contract evolves. The UI is deliberately decoupled at the HTTP
layer, not the module layer.
