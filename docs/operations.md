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

### Symptoms: income history loads but tier and commission details fail

The income page only waits for `/history` during navigation. Once visible,
it requests `/scoring` separately; pending or failed scoring cannot delay
the history table. A scoring failure displays a **Retry details** button
that retries only scoring. A scoring 404 is shown as unavailable rather
than as a transient error. Navigating to another validator or leaving the
page aborts the previous scoring request and discards any late response.
The normal 15-second API client timeout remains unchanged.

Correlate incoming request, completion and error logs by request ID before
attributing a delay. SQLSTATE `57014` with **"canceling statement due to
statement timeout"** confirms a PostgreSQL statement timeout; the code
alone also covers other cancellations. A stack through
`StatsRepository.findEconomicPercentile` points to the scoring cohort/CU
query, which also runs from the tier snapshot job. It does not identify
whether query execution, lock waits or resource pressure caused the
timeout. The query's rotation-aware `processed_blocks` aggregation is not
equivalent to simply reading `epoch_validator_stats.compute_units_total`
(see migration 0043). Query changes need local PostgreSQL correctness and
performance evidence; increasing the timeout is not a UI fix.

### Symptoms: scoring or tier snapshot statement timeouts

`StatsRepository.findEconomicPercentile` computes a shared income/CU
cohort over the validator's closed-epoch window. SQLSTATE `57014` together
with **"canceling statement due to statement timeout"** confirms a statement
timeout; the code alone also covers other cancellations. Correlate API
request IDs with completion and error logs before attributing a page delay.

CU matching uses distinct `(vote, identity)` rows and an equality join to
`processed_blocks`, retaining the constant epoch range for partition
pruning. This keeps the identity set window-wide (including mid-epoch
rotations) without multiplying blocks when an identity appears in several
epochs. It also lets the planner use an equality join instead of repeatedly
applying an identity-array filter. The produced-block denominator, cohort
membership, opt-out and null behavior remain unchanged. This is not a
substitution with migration 0043's accumulated CU totals.

The PostgreSQL 16 integration regressions compare the lookup against a
frozen pre-change SQL fixture and check a synthetic cohort execution plan.
Synthetic timings do not guarantee production latency: cardinality,
statistics, hardware, lock waits and concurrent workload still matter.
Do not treat a plan without execution as an actual runtime measurement.

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

## Fee polling and dynamic backfill progress

The `fee-ingester` gives block fetching a cooperative deadline of
`FEE_INGEST_INTERVAL_MS` from tick start. It drains and persists an in-flight
RPC batch before yielding, then resumes from missing block facts on the next
tick. Live polling fetches the most recent missing slots first, so searching
for a cold validator does not put every old current-epoch slot ahead of newly
finalised slots.

If the live pass leaves time, the job attempts at most
`FEE_INGEST_BATCH_SIZE` blocks for one pending dynamic validator's previous
epoch. It rotates pending votes even after RPC errors. The
`prev_epoch_backfilled_at` marker is set only after all facts are captured
without errors; partial backfills deliberately take multiple ticks. Previously
captured blocks are skipped on resumption, including after a worker restart.
Migration `0047_dynamic_backfill_target_epoch.sql` adds the nullable
`prev_epoch_backfill_epoch` column. The worker atomically chooses each
pending validator's target on its first resolved pending-set observation,
after a successful authoritative `EpochService.syncCurrent()`, before live
block RPC work or a leftover-budget check, then keeps that original epoch
through rollover and restart. A stale open database epoch after a watcher
outage is insufficient. Sync failure leaves new rows unclaimed while existing
scopes and cached live ingestion continue. One read-only candidate snapshot precedes the chain sample, including on an
empty epoch cache. It records vote, `xmin` and `ctid`; bulk SQL claims only the
unchanged observed versions. A new registration after the sample, or a row
changed/deleted/re-registered while RPC runs, waits for the next fresh sample.
Even ordinary lookup updates conservatively postpone that claim. Already-pinned
epochs need no extra epoch RPC. Their addresses update only when the mapping changes.
Snapshot and bulk resolution each use one query, with no per-validator claim loop.
No watched-row lock spans RPC. With no cached epoch, the initial sync is reused.
A NULL proposal or omitted candidate cohort never claims new rows.

The claim preflight has its own caller-owned RPC allowance: 10% of the ingest
interval, capped at one second and floored at one millisecond. It forwards a
cancellation signal through epoch reads, the shared RPC queue, quota waits,
response reads and retry delays; ordinary timeout/retry policy is unchanged.
Early failure also cancels the companion epoch request. Late RPC settlements
are consumed without epoch writes or claims. After preflight and target
resolution, a new `FEE_INGEST_INTERVAL_MS` deadline governs live block work
and the remaining historical batch. An epoch RPC outage therefore cannot
repeatedly consume the live allowance. Already-started database statements
drain normally, so this remains cooperative rather than a hard tick-duration
guarantee. Registration queues a pending row; selection waits for its own
successful fresh observation.
Migration
`0048_dynamic_backfill_target_identity.sql` adds the nullable
`prev_epoch_backfill_identity` column. The worker records the current validator
identity used for automatic collection. This is the owner's accepted product
assumption; it is not proof of the vote's full historical identity. Fresh and
legacy epoch-only targets automatically adopt the current mapping, without a
manual provenance prerequisite. Missing validator mappings remain pending.

An observed identity change requeues that validator's original pinned epoch
using the new address, including after an earlier collection completed. Its
attempt cursor starts over. Only the affected derived `(epoch, vote)` row
switches to the new address and its captured facts; other epochs and all raw
blocks remain intact. Old-address income is not carried into new-address totals.
The row records the collection address, so it does not claim a combined history
for an actual rotation. A schedule observed empty under the accepted assumption
can complete as measured zero and stays outside the positive-slot economic cohort.

Completion validates epoch, address, the row revision observed by that tick,
all assigned produced/skipped facts and all five income totals. A delayed old
collection cannot stamp a replacement, including an address that changes back.
Current-address conflicts with an existing derived ledger still defer for
reconciliation instead of silently clearing income. The runtime does not infer
provenance from generic stats, and does not require it for ordinary collection.

Captured-block writers publish exact identity sums under watched/stats locks
using a fresh facts snapshot, instead of adding delayed deltas to totals already
reconstructed during an address change. Repeated/concurrent publication is
idempotent. Fact capture and publication remain separate writes; publication
failure leaves historical measurement pending until the ledger is reconciled.

Pending historical scopes keep both fee/tip measurement timestamps NULL even
when captured batches have nonzero income or CU. Captured income is published;
only guarded completion marks that scope measured. Resolving or claiming a
pending scope also clears pre-existing measurement timestamps, including for
same-address ledger conflicts, without altering counters or income.
Claims, deltas and completion serialize on watched rows before locking stats;
a claim waiting for an earlier delta reads the locked stats' latest timestamps.
Already-unmeasured stats are not rewritten during repeated target resolution.
Completed scopes and unrelated live rows retain their normal measurement behaviour.

The production reconciler's missing-row/income-gap selection excludes only the
exact pinned vote/epoch pairs, including non-NULL identity/income conflicts.
The bounded fee ingester owns pending targets; conflicts need verified offline
repair. Their deliberately unmeasured rows therefore do not repeatedly select
old epochs and re-scan healthy watched votes. Another vote's real gap in that epoch, or that vote's gap in another
epoch, still selects repair. Raw gap reporting continues to show missing data;
the latest-closed settling pass and current/live ingestion keep their normal scope.

The ordinary income reconciler follows the stored historical scope for its
target epoch, including after completion. Slot writes lock and validate that
scope in SQL, so a claim or rotation between lookup and write cannot relabel
the aggregate. Both historical paths defer before fetching more blocks when
the existing aggregate identity or income does not match the captured facts.
The runtime reconciler does not replace pinned-target totals with a
single-identity rebuild; that could erase legitimate rotation income. A
mismatch is a reason for verified offline reconciliation, not proof that the
existing income is invalid and not permission to clear it.
If legitimate income from multiple identities cannot be represented by that
single target scope, resolve the ledger and completion decision offline;
keep it pending instead of dropping income to satisfy the runtime check.

Block-fact insertion and income-delta updates are separate existing writes.
If a delta fails after the fact commits, a restarted worker skips that captured
block but now keeps the target pending until the income ledger is reconciled.
Raw gap detection still reports pending targets after clearing stale measurement;
that does not itself repair an undercount. Later captured-fact publication can
reconcile exact address sums; completion still validates those sums. Same-address ledger conflicts are not automatically reset. Address changes
reconstruct only the new address collection from its facts.

Historical passes also rotate slots after the last attempt, including failed
RPC attempts. A permanently unavailable first batch therefore cannot consume
every later tick: later missing slots are attempted before wrapping back to
the errors. The attempt cursor is local to the running fee job, isolated by
vote, previous epoch and identity, and removed on completion or removal from
the pending set. Current-epoch rollover preserves the original backfill
target and cursor. An observed current identity change starts a new address collection and cursor;
it does not complete the unfinished old-address collection.
A restart can retry early errors again, but captured facts remain durable;
errors are never treated as completed blocks. Live polling keeps its newest
slot priority and does not use the historical cursor.

Historical leader-schedule lookup shares the remaining tick deadline and job
cancellation through RPC queue/quota waits, retries and fallback. Cancellation
does not start a fallback or permit late schedules to start historical writes.
Epoch rollover closes the previous row and upserts its replacement in one
transaction; cancellation or SQL failure before commit rolls both back. Readers
see the previous open row until the replacement commits. Started DB statements
and commit/rollback drain normally.

The deadline is not a hard tick-duration limit: live RPC requests already in flight
and database operations drain normally. Slow database queries, RPC timeouts,
and the startup median repair can still extend a tick. The scheduler waits
`FEE_INGEST_INTERVAL_MS` after tick completion before starting another tick.
Use `jobs_tick_duration_seconds{job="fee-ingester"}`, tick start/end logs,
and `remaining` in bounded ingest results to separate these delays from a
cold backlog. A deadline-exhausted live pass postpones historical work until
there is spare capacity. No environment-variable changes are needed.
Migrations 0047 and 0048 add the durable target columns; the all-in-one
startup runs migrations before starting the API and worker. Apply both
migrations before running the updated worker. This change does not run a
production migration or require manual edits to block facts.
