# Operations

This document is for people running WhoEarns in an environment they care
about. If you are just kicking the tires locally, the
[README](../README.md) quickstart is usually enough.

Operationally, "AI-assisted" means maintainers may use AI to monitor
freshness, review anomalies, and draft public explanations. Keep the
runtime source of truth boring: Solana RPC block facts, PostgreSQL rows,
logs, health checks, and metrics.

## Running locally

### Docker Compose

```bash
cp .env.example .env
# Edit .env:
#   - VALIDATORS_WATCH_LIST=Vote111...,Vote222...
#   - SOLANA_RPC_URL=... (optional; default is public RPC)
docker compose -f deploy/docker/docker-compose.yml up --build
```

This runs the same all-in-one image used in production: PostgreSQL,
migrations, API, worker, and the static UI bundle in one container. Stop
with `Ctrl-C`; `docker compose -f deploy/docker/docker-compose.yml down -v`
to wipe the PG volume.

### Bare Node.js

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Point POSTGRES_URL at a reachable Postgres 16+ instance.
pnpm run migrate:up
# Terminal 1:
pnpm run dev:api
# Terminal 2:
pnpm run dev:worker
```

## Helm

A chart lives at `deploy/helm/whoearns-live`. Install it with the
`whoearns-live` release name when you want Kubernetes objects and pods to use
the public runtime slug. It deploys:

- One `StatefulSet` with one container running PostgreSQL, migrations, API,
  worker, and the static UI bundle.
- One persistent volume claim for the embedded PostgreSQL data directory.
- `Service` resources for the API and the StatefulSet governing service.
- Optional `Ingress` when enabled by values.

See the chart's own `README.md` for the full value reference.

### Install

```bash
helm upgrade --install whoearns-live deploy/helm/whoearns-live \
  --namespace whoearns-live --create-namespace \
  --set config.validatorsWatchList="Vote111...,Vote222..." \
  --set config.solanaRpcUrl="https://your.rpc.endpoint/"
```

### Upgrade

```bash
helm upgrade whoearns-live deploy/helm/whoearns-live \
  --namespace whoearns-live \
  --reuse-values \
  --set image.tag="0.4.0"
```

Migrations run inside the container on start before the API and worker boot.
If startup fails, inspect `kubectl logs -n whoearns-live sts/whoearns-live`.

**Forcing the new image.** The deploy uses a mutable `image.tag` (e.g.
`latest`) with `pullPolicy: Always`. The pod template carries a
`helm.sh/rollout-at` annotation set to render time, so every `helm upgrade`
changes the pod-template hash and the StatefulSet rolls the pod (pulling the
fresh image) even when nothing else changed.

**Stuck rollout (crash-loop).** If a bad image leaves the pod not Ready, a
rolling update can wedge — `helm upgrade` keeps bumping the release revision
but the pod stays on the old one. The StatefulSet uses
`podManagementPolicy: Parallel` so the controller replaces an unhealthy pod
immediately; if a rollout is still stuck (e.g. a release from before this
setting), force it: `kubectl delete pod <name>-0` (the data PVC is retained,
so the DB survives). Verify with `kubectl get statefulset <name> -o
jsonpath='{.status.currentRevision}{"\n"}{.status.updateRevision}'` — the
two should match once healthy.

**`podManagementPolicy` is immutable.** Switching it (e.g. the one-time move
to `Parallel`) cannot be done by `helm upgrade` alone — recreate the
StatefulSet object once: `kubectl delete statefulset <name>` (the
`data-<name>-0` PVC is retained on delete) then `helm upgrade` to recreate
it; the new pod re-binds the existing PVC.

## Backup and restore

The indexer's data is derived from upstream Solana RPC, so in principle you
can rebuild from scratch. In practice, refill still costs one `getBlock` for
each watched produced leader slot, and rebuilding months of history can burn
through RPC quota. Snapshot the database if continuity matters.

### `pg_dump`

```bash
kubectl -n whoearns-live exec -it sts/whoearns-live -- \
  pg_dump -h 127.0.0.1 -U indexer -Fc indexer > indexer-$(date +%F).dump
```

For an external DB, run `pg_dump` against its URL directly.

### `pg_restore`

```bash
kubectl -n whoearns-live exec -i sts/whoearns-live -- \
  pg_restore -h 127.0.0.1 -U indexer -d indexer --clean --if-exists < indexer-YYYY-MM-DD.dump
```

Run this before restarting the API and worker.

> **Gamification tables — full-DB dump/restore only.** Of the Phase
> 2-6 tables (`validator_github`, `operator_wallets`,
> `wallet_daily_activity`, `simd_proposals`, `simd_discussion_comments`,
> `validator_claim_events`), `validator_github` and `operator_wallets`
> carry `ON DELETE CASCADE` foreign keys to `validator_claims` (which
> in turn cascades from `validators`). The rest deliberately omit FK
> constraints but are still logically keyed to the same claim/wallet
> rows. A partial, single-table `pg_dump`/`pg_restore` can fail on a
> missing parent — or, worse, silently drop linked rows when the
> parent is `--clean`-ed out from under it. Always snapshot and
> restore the whole database: the `pg_dump -Fc` / `pg_restore` flow
> above is the only safe path.

## Migrations

SQL migrations live in `src/storage/migrations/` and are applied by
`pnpm run migrate:up` (`src/scripts/migrate.ts up`).

- In development you run the script manually.
- Under Helm the same script runs during container startup before the API and
  worker start.
- Rollback via `pnpm run migrate:down` is supported only within the
  last applied migration. Schema changes are **not** auto-reversible
  — for anything non-trivial, restore from backup.

## Worker jobs

The worker runs a fixed set of cooperative-timer jobs (see
[`architecture.md`](./architecture.md) for the data-flow view). The
core ingestion jobs — epoch watcher, slot ingester, fee ingester,
aggregates, closed-epoch reconciler, validator-info refresh,
validator-info bulk ingester — are covered there. The Phase 2-6
gamification jobs are:

| Job                      | Env interval                  | Default | What it does                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster-nodes ingester   | `CLUSTER_NODES_INTERVAL_MS`   | 30 min  | Polls `getClusterNodes` (~500 KB) and writes each identity's `(client_kind, client_version)` to `validators`. Drives the client-family badges.                                                                                                                                              |
| Wallet-activity ingester | `WALLET_ACTIVITY_INTERVAL_MS` | 6 h     | One `getSignaturesForAddress` per registered operator wallet; upserts per-day tx counts into `wallet_daily_activity`. Idempotent.                                                                                                                                                           |
| SIMD curation pipeline   | `SIMD_CURATION_INTERVAL_MS`   | 12 h    | Enriches pending `simd_proposals` rows via the Anthropic API. **Gated on `ANTHROPIC_API_KEY`** — unset means curation is disabled entirely (the SIMD route still serves already-curated rows; new SIMDs stay pre-review). `ANTHROPIC_MODEL` selects the model, default `claude-sonnet-4-6`. |

Cold-start note: the RPC-bursty jobs (slot/fee ingest, cluster-nodes,
wallet-activity, validator-info refresh, validator-info bulk ingester,
closed-epoch reconcile) carry staggered first-tick delays so a fresh
boot doesn't fire every job's first RPC call at second 0 — see
`initialDelayMs` in `src/entrypoints/worker.ts`. The epoch watcher and
aggregates job still tick immediately.

Each tick emits `jobs_executed_total{job,outcome}` and
`jobs_tick_duration_seconds{job}` on the `/metrics` endpoint — alert
on a rising `outcome="fail"` rate to catch a job that is silently
failing every tick.

## Scaling

- **StatefulSet replica count** — keep it at 1. The embedded Postgres and
  worker are not active-active.
- **RPC throughput** — increase `SOLANA_RPC_CONCURRENCY` and
  `FEE_INGEST_BATCH_SIZE` against a private RPC provider if you need faster
  refill, not the pod replica count.
- **Postgres** — the embedded PG 16 instance handles the workload for a
  bounded watched set. Give the pod sensible CPU/RAM and a PVC that fits
  months of `processed_blocks` rows.

## Observability

- **Logs.** JSON (pino), one line per event, to stdout. Ship them
  with whatever log aggregator you already run.
- **Request id.** The API stamps a `requestId` on every response
  body (error shape) and every log line.
- **Metrics.** Set `METRICS_PORT` to a positive value to start a separate
  cluster-internal `/metrics` listener. The Helm chart annotates the pod for
  Prometheus scraping when `config.metricsPort > 0`. The endpoint exposes
  API request counters/latency histograms plus default Node.js process
  metrics; validator/business metrics still belong in an exporter that
  consumes the HTTP API.
- **AI-agent surfaces.** `/llms.txt`, `/llms-full.txt`, OpenAPI, and MCP are
  public read surfaces. Treat them like docs: keep claims tied to closed
  epochs, Decade/window sample boundaries, and reproducible API fields.
- **Health.** Two probe surfaces, by design:
  - `/healthz` — readiness + startup. 200 when the DB is up (`degraded`
    if the epoch heartbeat is stale > 2 min, but still serving), 503 when
    the DB probe fails. The Helm `startupProbe` and `readinessProbe` point
    here.
  - `/livez` — liveness. 503 only when the DB is unreachable OR the
    worker pipeline has frozen (epoch heartbeat `epochs.observed_at` stale
    beyond 15 min); 200 otherwise (including a null heartbeat on cold
    start). The Helm `livenessProbe` points here so Kubernetes restarts a
    pod whose worker has silently died — `/healthz` returns 200 `degraded`
    when stale, so a liveness probe on it never would (the 2026-06
    incident).
- **Process supervision.** `entrypoint.sh` runs api.js + worker.js as
  direct background children (they inherit the container's stdout, so pino
  JSON reaches `kubectl logs`) and polls to restart either on exit and to
  recycle either over its RSS ceiling (api 1 GiB / worker 4 GiB, tunable
  via env). A stdout-capturing manager such as pm2 is deliberately avoided:
  this app logs before it listens, and an undrained stdout pipe deadlocks
  that first write so the API never binds its port. `/livez` is the backstop
  for an alive-but-wedged worker no supervisor can detect. The
  income-reconciler additionally self-heals a closed epoch whose `epochs`
  metadata row is missing (worker down across the boundary) by
  reconstructing it from the running epoch's boundaries.

## Cloudflare cache and purge

WhoEarns is a static SPA shell plus public JSON API. Keep those cache classes
separate:

- HTML shells (`/`, `/index.html`, `/spa-fallback.html`, prerendered `*.html`)
  stay `Cache-Control: no-cache`. This prevents stale HTML from referencing
  old content-hashed chunks after a deployment.
- Vite/SvelteKit immutable assets under `/_app/immutable/*` ship as
  `Cache-Control: public, max-age=31536000, immutable`.
- `/v1/epoch/current` ships as
  `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300`.
- `/v1/leaderboard` uses a short browser-only cache
  (`Cache-Control: private, max-age=10`) so homepage preload can be reused
  without putting operator opt-out state into a shared CDN cache.
- `/v1/validators/:id/history` is `Cache-Control: no-store` because it
  includes profile, claim, opt-out, and auto-track state.

Add a Cloudflare Cache Rule for immutable assets:

- Expression:
  `(http.host eq "whoearns.live" and starts_with(http.request.uri.path, "/_app/immutable/"))`
- Cache eligibility: eligible for cache.
- Edge TTL: override origin, 1 year.
- Browser TTL: override origin, 1 year.

Cloudflare documents these settings as `cache`, `edge_ttl`, and
`browser_ttl` on Cache Rules. Use a dashboard rule or Terraform/API; do not
make HTML shell paths eligible for long-lived edge caching.

After each production deployment, purge the small set of HTML shell URLs in
the Cloudflare dashboard so the edge immediately discovers the new hashed
chunks. Use **Caching → Configuration → Purge Cache → Custom Purge → URL**
and purge:

- `https://whoearns.live/`
- `https://whoearns.live/index.html`
- `https://whoearns.live/spa-fallback.html`
- `https://whoearns.live/about`
- `https://whoearns.live/faq`
- `https://whoearns.live/glossary`
- `https://whoearns.live/api/docs`
- `https://whoearns.live/api/reference`

Avoid "Purge Everything" as the normal deploy path; it throws away the
long-lived immutable asset cache that keeps first visits fast after the first
deployment hit.

## Troubleshooting

### Symptoms: repeated `429` or `-32005` from Solana RPC

- The default `SOLANA_RPC_URL` is the public PublicNode endpoint.
  It is shared infrastructure and rate-limits aggressively.
- If you are running with `VALIDATORS_WATCH_LIST=*`, you **must**
  use a paid/private RPC or your own node.
- Reduce `SOLANA_RPC_CONCURRENCY` and/or increase
  `SLOT_INGEST_INTERVAL_MS` / `FEE_INGEST_INTERVAL_MS` to lower the
  RPC call rate.

### Symptoms: `fees_updated_at` stops advancing for one validator

- Check logs for `getBlock` errors on recent leader slots (skipped
  slots surface as successful `null` responses, not errors).
- Look at `ingestion_cursors` for the fee job:

  ```sql
  SELECT * FROM ingestion_cursors WHERE job_name = 'fee-ingester';
  ```

  If `last_processed_slot` is stale but `observed_at` is fresh, the
  worker is seeing the rows but failing to advance. That usually
  means the RPC provider is returning transient errors above
  `SOLANA_RPC_MAX_RETRIES`. Raise the retry budget and re-deploy.

### Symptoms: API returns `503 not_ready` right after rollout

- Expected. The epoch watcher runs on `EPOCH_WATCH_INTERVAL_MS`
  (default 30s) after worker start; the API cannot answer
  epoch-dependent queries until then.
- If it persists longer than ~2 × the interval, check worker logs
  for RPC or DB errors.

### Symptoms: `/healthz` returns 503 with `db: fail`

- The DB probe (`SELECT 1` with a 2-second timeout) failed. Check:
  - Is PostgreSQL reachable from the API pod / container?
  - Is the DB accepting connections (not in startup / recovery)?
  - Is `POSTGRES_STATEMENT_TIMEOUT_MS` tripping a slow query? 2s on
    `SELECT 1` is almost always a network problem, not a slow
    query.

### Symptoms: "stuck cursor" — worker keeps retrying the same slot

Typically an RPC method returning a deterministic error for a specific
slot (missing, pruned, or corrupted on the provider's side). Recover
by nudging the cursor past the bad slot:

```sql
UPDATE ingestion_cursors
SET last_processed_slot = last_processed_slot + 1
WHERE job_name = 'fee-ingester';
```

A skipped slot does not affect accuracy: the slot is either "produced"
(and we will lose its fees until you point it at another provider
that has the block) or "skipped" (and the fee contribution is zero
anyway).

## Upgrading

1. Snapshot the database (`pg_dump`, above).
2. Read the `CHANGELOG.md` entry for the target version; note any
   breaking changes or startup migrations that will run.
3. `helm upgrade` — the new pod runs migrations before starting the API and
   worker.
4. Check `/healthz` on the new pods and tail `kubectl logs` for a
   few minutes.
5. If something looks wrong, `helm rollback whoearns-live <prev-revision>`
   before more data lands.
