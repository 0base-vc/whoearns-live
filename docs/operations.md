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
  --set image.tag="0.3.0"
```

Migrations run inside the container on start before the API and worker boot.
If startup fails, inspect `kubectl logs -n whoearns-live sts/whoearns-live`.

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

## Migrations

SQL migrations live in `src/storage/migrations/` and are applied by
`pnpm run migrate:up` (`src/scripts/migrate.ts up`).

- In development you run the script manually.
- Under Helm the same script runs during container startup before the API and
  worker start.
- Rollback via `pnpm run migrate:down` is supported only within the
  last applied migration. Schema changes are **not** auto-reversible
  — for anything non-trivial, restore from backup.

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
  epochs, tracked-sample boundaries, and reproducible API fields.
- **Health.** `/healthz` is appropriate for both liveness and
  readiness.

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
