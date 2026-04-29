# WhoEarns

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/0base-vc/whoearns-live/actions/workflows/ci.yml/badge.svg)](https://github.com/0base-vc/whoearns-live/actions/workflows/ci.yml)

WhoEarns is a public, open-source Solana validator income transparency
service. This repository contains the indexer, HTTP API, MCP server, Helm
chart, Docker image, and SvelteKit UI that power
[whoearns.live](https://whoearns.live).

The public data model tracks per-epoch slot production, base/priority block
fees, and on-chain Jito tips derived from Solana block data. The derived data
is intended to be freely queryable and reproducible; it is **not** financial
advice, a delegation recommendation, or a complete accounting of validator or
delegator revenue.

## What this is

Prometheus exporters that compute validator epoch metrics at scrape time
must issue many RPC calls for every scrape. At tens of validators this is
slow, at hundreds it hits public-RPC rate limits.

WhoEarns moves that work off the scrape path:

- A **worker** continuously reads Solana leader schedules and produced
  blocks, then stores per-slot facts in PostgreSQL.
- An **API** serves per-validator, per-epoch results from PostgreSQL in a
  single round trip.
- A **UI** renders leaderboard, income history, comparison, claim/profile,
  and API-reference pages from that same public API.

The production image is all-in-one: PostgreSQL, migrations, API, worker, and
the static UI bundle run in one StatefulSet-friendly container. For local
bare-Node development, API and worker can still be run as separate processes.

## Architecture

```
                                                  +------------------+
                                                  |  Solana JSON-RPC |
                                                  +---------+--------+
                                                            ^
                                                            |
  +---------------+      +----------+     +-----------+     |
  |   Exporter    |      |   API    |     |  Worker   |-----+
  | (e.g. 0base-) | ---> | (fastify)| <-- |  (jobs)   |
  |  exporter     |      +----+-----+     +-----+-----+
  +---------------+           |                 |          +-------------+
                              v                 |
                        +-----+-------+         |
                        |  PostgreSQL | <-------+
                        +-------------+
```

## Features

- Per-epoch, per-validator slot production (assigned / produced / skipped).
- Cumulative block-fee rewards split into base-fee share and priority fees.
- On-chain Jito tip totals derived from produced block data.
- Current-epoch lower bounds that update as new leader blocks are ingested.
- Explicit watch list (recommended) or `*` to track all active validators.
- Crash-safe ingestion: per-slot `processed_blocks` facts make every job
  idempotent, and aggregate totals can be rebuilt from facts.
- Finality buffer avoids reorg-related double counting.
- JSON structured logs via pino.
- PostgreSQL 16+ backend; schema managed by SQL migrations.
- Two deployable surfaces: Docker Compose for local development, Helm for
  production.
- Built-in SvelteKit UI, read API, OpenAPI/Scalar reference, and optional
  cluster-internal Prometheus metrics endpoint.

## Non-goals

This project is intentionally narrow. It **does not**:

- Replicate `vx.tools`, `stakewiz`, or other explorer-style services.
- Emit validator-level Prometheus gauges directly; use an exporter that
  consumes the HTTP API for business metrics.
- Replace a validator's own RPC node, staking analysis, or governance
  tooling.
- Compute rewards other than block fees and on-chain Jito tips (no inflation
  rewards, no delegator splits).
- Track non-mainnet clusters in the MVP.

## Quickstart (local dev, Docker Compose)

```bash
git clone https://github.com/0base-vc/whoearns-live.git
cd whoearns-live
cp .env.example .env
# edit .env: set VALIDATORS_WATCH_LIST to a few vote pubkeys
docker compose -f deploy/docker/docker-compose.yml up --build
```

This starts PostgreSQL, runs migrations, and boots the API (port `8080`)
and the worker. After a minute or two the API will answer:

```bash
curl http://localhost:8080/v1/epoch/current
```

The same port also serves the SvelteKit UI — open
<http://localhost:8080/> in a browser, or jump straight to an income page
like <http://localhost:8080/income/5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ>.

### UI development (hot reload)

The UI lives under `ui/` and has its own `package.json`. For local
iteration run it against the production API:

```bash
cd ui
pnpm install
pnpm run dev    # http://localhost:5173
```

Set `PUBLIC_INDEXER_API_URL` to point the dev UI at a backend — your
own deployment, a local indexer on `:8080`, or the 0base reference
deployment at `https://whoearns.live` for a quick spin.

## Configuration

All configuration is read from environment variables at process start.
See [`.env.example`](./.env.example) for the authoritative list.

| Variable                             | Default                                             | Description                                                                                                               |
| ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                           | `development`                                       | One of `development`, `production`, `test`.                                                                               |
| `LOG_LEVEL`                          | `info`                                              | pino level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.                                                           |
| `HTTP_PORT`                          | `8080`                                              | API listen port.                                                                                                          |
| `HTTP_HOST`                          | `0.0.0.0`                                           | API listen address.                                                                                                       |
| `METRICS_PORT`                       | `0`                                                 | Separate cluster-internal `/metrics` listener. `0` disables it.                                                           |
| `SITE_URL`                           | `http://localhost:8080`                             | Canonical public URL used for OpenAPI, SEO, and MCP metadata.                                                             |
| `SITE_NAME`                          | `WhoEarns`                                          | Public display name used by API metadata and generated pages.                                                             |
| `API_RATE_LIMIT_MAX`                 | `60`                                                | Per-IP request cap for public API routes.                                                                                 |
| `API_RATE_LIMIT_WINDOW_MS`           | `60000`                                             | Rate-limit window in milliseconds.                                                                                        |
| `SOLANA_RPC_URL`                     | `https://solana-rpc.publicnode.com`                 | Solana JSON-RPC endpoint. Public RPC is rate-limited; use a paid provider for `*` mode.                                   |
| `SOLANA_RPC_TIMEOUT_MS`              | `30000`                                             | Per-request RPC timeout.                                                                                                  |
| `SOLANA_RPC_CONCURRENCY`             | `4`                                                 | Maximum concurrent in-flight RPC calls from the worker.                                                                   |
| `SOLANA_RPC_MAX_RETRIES`             | `3`                                                 | Retry budget for transient RPC failures.                                                                                  |
| `SOLANA_FALLBACK_RPC_URL`            | _(unset)_                                           | Optional secondary RPC used after primary retries are exhausted.                                                          |
| `SOLANA_ARCHIVE_RPC_URL`             | _(unset)_                                           | Optional secondary endpoint retained for one-shot historical scripts.                                                     |
| `YELLOWSTONE_GRPC_URL`               | _(unset)_                                           | Optional live block stream; JSON-RPC still repairs missed slots.                                                          |
| `YELLOWSTONE_GRPC_X_TOKEN`           | _(unset)_                                           | Optional auth token for Yellowstone providers that require one.                                                           |
| `SOLANA_RPC_CREDITS_PER_SEC`         | `0`                                                 | Optional upstream-credit token bucket. `0` disables it.                                                                   |
| `SOLANA_RPC_BURST_CREDITS`           | `0`                                                 | Optional burst size for the RPC credit bucket.                                                                            |
| `POSTGRES_URL`                       | `postgres://indexer:indexer@localhost:5432/indexer` | PostgreSQL connection string.                                                                                             |
| `POSTGRES_POOL_SIZE`                 | `10`                                                | `pg` pool size.                                                                                                           |
| `POSTGRES_STATEMENT_TIMEOUT_MS`      | `10000`                                             | Per-query statement timeout.                                                                                              |
| `VALIDATORS_WATCH_LIST`              | _(empty)_                                           | Comma-separated vote pubkeys, or `*` for all validators. Empty means "track nothing" and is only useful for API-only use. |
| `EPOCH_WATCH_INTERVAL_MS`            | `30000`                                             | How often the worker checks for a new epoch.                                                                              |
| `SLOT_INGEST_INTERVAL_MS`            | `60000`                                             | How often the worker derives slot counters from leader schedule + local facts.                                            |
| `FEE_INGEST_INTERVAL_MS`             | `30000`                                             | How often the worker walks the leader schedule and processes new blocks.                                                  |
| `FEE_INGEST_BATCH_SIZE`              | `50`                                                | Number of blocks processed per fee-ingest batch.                                                                          |
| `AGGREGATES_INTERVAL_MS`             | `300000`                                            | How often the worker recomputes cluster medians.                                                                          |
| `CLOSED_EPOCH_RECONCILE_INTERVAL_MS` | `300000`                                            | How often the worker repairs the latest closed epoch from leader-slot facts.                                              |
| `VALIDATOR_INFO_INTERVAL_MS`         | `21600000`                                          | How often watched validator identity metadata is refreshed.                                                               |
| `SLOT_FINALITY_BUFFER`               | `32`                                                | Blocks within this distance from the tip are considered not yet final and are skipped.                                    |
| `SHUTDOWN_TIMEOUT_MS`                | `15000`                                             | Grace period for in-flight work on SIGTERM.                                                                               |

### Watch list modes

The `VALIDATORS_WATCH_LIST` variable accepts two modes:

- **Explicit list (recommended):**
  `VALIDATORS_WATCH_LIST=Vote111...,Vote222...,Vote333...`
  Only the listed vote pubkeys are indexed. RPC load scales with the list
  size and is usually fine against the default public RPC for a handful of
  validators.

- **Top-N by activated stake:**
  `VALIDATORS_WATCH_LIST=top:100`
  The worker refreshes the active vote set from `getVoteAccounts` and tracks
  the top N validators by activated stake. This is the usual production mode
  when you want a bounded cluster sample.

- **All active validators (`*`):**
  `VALIDATORS_WATCH_LIST=*`
  The worker indexes every validator returned by `getVoteAccounts`.
  **This is a heavy workload.** Mainnet has ~1000+ active vote accounts
  and each epoch contains hundreds of thousands of leader slots. Expect
  sustained RPC traffic. The default public RPC **will** rate-limit you;
  run `*` only against a paid/private RPC or your own node.

## API reference

All endpoints return `application/json`. See [`docs/api.md`](./docs/api.md)
for the full reference and [`docs/openapi.yaml`](./docs/openapi.yaml) for
the OpenAPI 3.1 spec.

| Method | Path                                 | Description                                            |
| ------ | ------------------------------------ | ------------------------------------------------------ |
| GET    | `/healthz`                           | Liveness plus DB / RPC / epoch freshness.              |
| GET    | `/v1/epoch/current`                  | Current epoch boundary and elapsed-slot count.         |
| GET    | `/v1/leaderboard`                    | Closed-epoch validator ranking.                        |
| GET    | `/v1/validators/:vote/current-epoch` | Full current-epoch stats for one validator.            |
| GET    | `/v1/validators/:vote/history`       | Per-epoch history for one validator.                   |
| POST   | `/v1/validators/current-epoch/batch` | Same as above for up to 200 validators in one request. |
| GET    | `/v1/validators/:vote/epochs/:epoch` | Historical per-epoch stats for one validator.          |
| GET    | `/v1/claim/:vote/status`             | Public claim/profile state for a validator.            |
| GET    | `/mcp` / `POST /mcp`                 | Streamable HTTP MCP server for AI agents.              |

Validator response shape:

```json
{
  "vote": "Vote111...",
  "identity": "Iden222...",
  "epoch": 615,
  "slotsAssigned": 124,
  "slotsProduced": 122,
  "slotsSkipped": 2,
  "hasSlots": true,
  "hasIncome": true,
  "isCurrentEpoch": false,
  "isFinal": true,
  "blockBaseFeesTotalLamports": "3123112345",
  "blockBaseFeesTotalSol": "3.123112345",
  "blockPriorityFeesTotalLamports": "5300000000",
  "blockPriorityFeesTotalSol": "5.3",
  "blockFeesTotalLamports": "8423112345",
  "blockFeesTotalSol": "8.423112345",
  "blockTipsTotalLamports": "1230456789",
  "blockTipsTotalSol": "1.230456789",
  "totalIncomeLamports": "9653569134",
  "totalIncomeSol": "9.653569134",
  "freshness": {
    "slotsUpdatedAt": "2026-04-15T09:59:42Z",
    "feesUpdatedAt": "2026-04-15T09:59:55Z",
    "tipsUpdatedAt": "2026-04-15T09:59:55Z"
  }
}
```

Error envelope:

```json
{
  "error": {
    "code": "not_found",
    "message": "validator not found: Vote111...",
    "requestId": "b8f1e2c3-..."
  }
}
```

## MCP server

A read-only Model Context Protocol server is exposed at `/mcp` over
Streamable HTTP (no auth, stateless). AI agents — Claude Desktop,
Claude Code, custom MCP clients — can call three tools without
scraping the UI or parsing OpenAPI:

| Tool                | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `get_current_epoch` | Returns the running epoch number, slot range, and elapsed slots.  |
| `get_leaderboard`   | Top-N validators for the latest CLOSED epoch (configurable sort). |
| `get_validator`     | Per-epoch history for one validator (vote OR identity pubkey).    |

The MCP transport is exempt from the per-IP rate limit on `/v1/*`
because MCP clients are explicitly configured per-user; tool input
schemas cap response sizes (`limit ≤ 100`, `epochLimit ≤ 50`) so
intrinsic cost is bounded.

**Claude Desktop** — add to `~/.claude/claude_desktop_config.json`
(the `https://whoearns.live` URL below is the 0base.vc reference
deployment; replace it with your own `SITE_URL` for a self-hosted instance):

```jsonc
{
  "mcpServers": {
    "whoearns": {
      "type": "http",
      "url": "https://whoearns.live/mcp",
    },
  },
}
```

**Claude Code**:

```bash
claude mcp add --transport http whoearns \
  https://whoearns.live/mcp
```

Open a new conversation and ask "What epoch is Solana on?" — the
agent should pick `get_current_epoch` automatically.

## Running modes

The Docker/Helm image runs API, worker, migrations, and embedded PostgreSQL
from one supervised entrypoint. For development without the image, run the
two Node entrypoints against any reachable PostgreSQL 16+ instance:

| Mode   | Command                           | Purpose                                           |
| ------ | --------------------------------- | ------------------------------------------------- |
| API    | `node dist/entrypoints/api.js`    | Serves HTTP requests. Reads from PostgreSQL only. |
| Worker | `node dist/entrypoints/worker.js` | Runs background jobs. Writes to PostgreSQL.       |

The worker must remain a **single replica**. Running two workers against the
same database is not supported and will cause duplicate RPC load and cursor
contention.

## Deployment

### Docker Compose (local)

The `deploy/docker/docker-compose.yml` file runs the same all-in-one image
used by Helm. It reads `.env` through Docker Compose variable substitution.

```bash
cp .env.example .env
docker compose -f deploy/docker/docker-compose.yml up --build
```

### Helm (production)

A chart is published at `deploy/helm/solana-validator-indexer`. See that
chart's [README](./deploy/helm/solana-validator-indexer/README.md) for
values, upgrade flow, and persistence notes.

Quick install with the bundled StatefulSet Postgres:

```bash
helm upgrade --install svi deploy/helm/solana-validator-indexer \
  --namespace svi --create-namespace \
  --set config.validatorsWatchList="Vote111...,Vote222..." \
  --set config.solanaRpcUrl="https://your.rpc.endpoint/"
```

The chart name and path still use `solana-validator-indexer` for deployment
compatibility during the public rename. A future runtime-name migration can
rename the chart and Kubernetes resources separately.

## Development

### Prerequisites

- Node.js 22+
- pnpm 10+ (install via `corepack enable`)
- Docker (required for integration tests, which boot an ephemeral
  Postgres via Testcontainers)

### Common commands

```bash
pnpm install --frozen-lockfile                           # install
pnpm run dev:api                 # API in watch mode
pnpm run dev:worker              # worker in watch mode
pnpm run typecheck               # tsc --noEmit
pnpm run lint                    # eslint
pnpm run format                  # prettier write
pnpm test                        # full vitest suite
pnpm run test:unit               # unit only
pnpm run test:integration        # integration (Docker required)
pnpm run test:coverage           # with v8 coverage
pnpm run build                   # emit dist/
pnpm run migrate:up              # apply migrations against POSTGRES_URL
```

### Test structure

- `test/unit/` — pure logic, no I/O. Uses `msw` for HTTP mocks.
- `test/integration/` — spins up Postgres (Testcontainers) and asserts
  against real SQL.
- `test/smoke/` — end-to-end check that API + worker start and a few
  endpoints respond.

Coverage target is **≥ 80%** on branches, functions, lines, and statements.

## Data model

Full schema lives in [`src/storage/migrations`](./src/storage/migrations).
The core tables are:

| Table                        | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `validators`                 | Known vote / identity pubkeys plus optional validator metadata. |
| `epochs`                     | Epoch boundaries, closure state, and last observed chain tip.   |
| `epoch_validator_stats`      | Main read-path table. One row per (`epoch`, `vote`).            |
| `processed_blocks`           | Per-slot fact table that makes fee/tip ingestion idempotent.    |
| `epoch_aggregates`           | Cluster-sample medians used by the UI and API.                  |
| `watched_validators_dynamic` | On-demand watched validators registered by user/API access.     |
| `validator_claims`           | Proof-of-ownership claims for profile editing.                  |
| `validator_profiles`         | User-supplied profile/narrative overrides.                      |
| `ingestion_cursors`          | Per-job progress cursor (resume after restart).                 |

## Income handling

The public income model is built from Solana block facts only:

- `blockBaseFeesTotal*` — the validator leader's base-fee share.
- `blockPriorityFeesTotal*` — gross priority fees paid in produced blocks.
- `blockTipsTotal*` — positive balance deltas into the public Jito tip
  accounts during produced blocks.

`blockTipsTotal*` is the gross on-chain tip signal observed in blocks, not
a delayed post-epoch TipRouter payout feed. This lets the current epoch
show a live lower bound instead of waiting for an external payout API.

## What this MVP does not solve

- **Inflation rewards.** Only block fees and on-chain Jito tips are tracked.
- **Delegator-side accounting.** The indexer reports rewards earned by
  the vote account; it does not split them between validator and
  stakers.
- **Non-mainnet clusters.** Testnet and devnet are out of scope for 0.x.
- **Historical backfill beyond what is reachable via `getBlock`.** Old
  epochs below the RPC node's first-available slot cannot be backfilled.
- **HA for the worker.** There is no active-active worker topology.
- **Auth and multi-tenancy.** Public read routes are unauthenticated.
  Profile writes use signed validator-identity messages, not accounts.
- **High-volume abuse prevention.** Basic per-IP rate limiting is built in
  for `/v1/*`, but large operators should still place the service behind
  their normal ingress/CDN controls.

## Roadmap

- Inflation-rewards ingestion (optional, via `getInflationReward`).
- Reward splits for delegators.
- Devnet / testnet support (behind a config flag).
- More worker/business Prometheus metrics for ingestion and reconciliation
  health.

## Contributing

Issues and PRs are welcome. Please read
[`CONTRIBUTING.md`](./CONTRIBUTING.md) first, then open an issue before
sending large changes.

## Security

Please follow [`SECURITY.md`](./SECURITY.md) to report vulnerabilities.
**Do not** open a public issue for security problems.

## License

[MIT](./LICENSE) — copyright (c) 2026 0base.vc contributors.
