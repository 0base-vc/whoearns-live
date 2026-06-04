# Architecture

This document describes the runtime topology, the ingestion jobs, the
storage layout, and the invariants the indexer relies on. If you are
looking for HTTP contracts, see [`api.md`](./api.md).

WhoEarns positions AI as an operations and interpretation layer above this
system. AI can summarize closed-epoch data, flag unusual income patterns,
and help maintain public docs, but it does not write accounting facts. The
source of truth remains the PostgreSQL data derived from Solana block data.

## Components

```
+--------------------+
|  Solana JSON-RPC   |
+---------+----------+
          ^
          |
+---------+----------+     +-----------------+     +------------------+
| Slot ingester job  |     | Fee ingester    |<----| Yellowstone gRPC |
| (schedule + facts) |     | (watched slots) |     |   (optional)     |
+---------+----------+     +--------+--------+     +------------------+
          |                         |
          v                         v
+---------------------------------------------+
|                 Worker process              |
|   +------------------+  +-----------------+ |
|   | Epoch watcher    |  | Aggregates job  | |
|   | (getEpochInfo)   |  | (SQL medians)   | |
|   +--------+---------+  +--------+--------+ |
+--------------+---------------------+--------+
               |                     |
               v                     v
           +-------------------------+
           |       PostgreSQL        |
           |  epochs                 |
           |  validators             |
           |  epoch_validator_stats  |
           |  processed_blocks       |
           |  ingestion_cursors      |
           +------------+------------+
                        ^
                        | read-only
                        |
               +--------+--------+
               |   API process   |
               |   (Fastify)     |
               +--------+--------+
                        |
                        v
             +----------+-----------+
             |  Consumer / exporter |
             +----------------------+
```

## Process model

Two processes run from the same image:

| Process | Entrypoint                        | DB role      | Replicas       |
| ------- | --------------------------------- | ------------ | -------------- |
| API     | `node dist/entrypoints/api.js`    | Read-only    | N (horizontal) |
| Worker  | `node dist/entrypoints/worker.js` | Read + write | 1 (strictly)   |

The worker is single-replica by design: each ingestion job uses a
row in `ingestion_cursors` as its progress marker, and the cursor is
not protected by a distributed lock. A second worker writing to the
same database will re-run already-processed work and waste RPC quota.
Optional Yellowstone gRPC ingestion runs inside the same worker process
and is still paired with the polling/reconciliation path for repair.

## Jobs

All jobs are cooperative timers managed by `src/jobs/scheduler.ts`.
Each tick executes a job if the prior tick has completed; jobs do not
overlap with themselves.

### Epoch watcher (`EPOCH_WATCH_INTERVAL_MS`, default 30s)

Calls `getEpochInfo`. If the epoch number advanced, inserts a new row
into `epochs` and closes the previous one (`is_closed=true`,
`closed_at=NOW()`). Also ensures `validators` is populated for the
watch list.

### Slot ingester (`SLOT_INGEST_INTERVAL_MS`, default 60s)

Uses the epoch leader schedule plus local `processed_blocks` facts to
update `epoch_validator_stats.slots_assigned` / `slots_produced` /
`slots_skipped` and sets `slots_updated_at`. It does not call
`getBlockProduction`; a leader slot with no fact row is treated as
pending until the fee ingester or reconciler fetches it. This is an
upsert; it is safe to re-run.

### Fee ingester (`FEE_INGEST_INTERVAL_MS`, default 30s)

Batch size: `FEE_INGEST_BATCH_SIZE`, default 50.

Walks the current epoch's leader schedule. For each un-processed slot
between the cursor and `(tip - SLOT_FINALITY_BUFFER)`, calls
`getBlock` and extracts:

- leader base-fee share,
- priority fees,
- on-chain Jito tip-account balance deltas.

It inserts a fact row into `processed_blocks` and applies the same delta
to `epoch_validator_stats.block_*_total_lamports`. `processed_blocks`
has `slot` as its primary key, so a duplicate call is a no-op.

When `YELLOWSTONE_GRPC_URL` is configured, a best-effort live subscriber
can feed current-epoch watched leader blocks into the same persistence path.
JSON-RPC polling remains enabled and repairs reconnect gaps.

### Aggregates job (`AGGREGATES_INTERVAL_MS`, default 300s)

Recomputes cluster-sample medians from stored facts for the configured
top-N validator sample. It does not call RPC. These medians power the
income page's validator-vs-cluster context; Decade leaderboard badges are
computed from stored 10-epoch leaderboard windows.

### Validator-info refresh (`VALIDATOR_INFO_INTERVAL_MS`, default 6h)

Re-fetches on-chain validator-info (moniker, icon) for the watched
set only and updates `validators`. A one-shot backfill for watched
validators with no info record also runs once after worker start.

### Validator-info bulk ingester (`VALIDATOR_INFO_BULK_INTERVAL_MS`, default 6h)

Sibling to the watched-set refresh above, but cluster-wide: one bulk
`getConfigProgramAccounts` pull (~2000 records, ~3 MB on mainnet)
fills `name`/`keybase_username`/`website`/`icon_url` for **every**
published validator, not just the watched set. Without it a
validator's `name` is only populated once it has been tracked (in the
watch list, or opened/added on-demand), so `/v1/validators/search`
could match monikers for that subset only — every other validator sat
in `validators` with a NULL `name`, findable by pubkey but never by
name. The repo's `upsertInfoBatch` uses an `IS DISTINCT FROM` guard,
so a tick where nothing renamed is a zero-row write.

### Cluster-nodes ingester (`CLUSTER_NODES_INTERVAL_MS`, default 30min) — DISABLED

**Disabled (code retained).** This job polls `getClusterNodes` (~500 KB)
and writes each gossip identity's `(client_kind, client_version)` to
`validators` by regex-matching the gossip version string. Its scheduler
registration was removed from `entrypoints/worker.ts` — the regex
classifier and the validators.app classifier both write the same
columns, and because cluster-nodes ran ~12× more often it would
repeatedly overwrite the richer validators.app fork classifications
(e.g. demoting `agave_bam` back to `agave`), livelocking the steady
state on the wrong value. The factory (`createClusterNodesIngesterJob`)
is kept for reference and tests but no longer ticks.

### Validators.app client ingester (`VALIDATORS_APP_INTERVAL_MS`, default ~2h)

The live client-kind source. Pulls canonical client classifications
from validators.app (whose gossip CRDS decoder distinguishes the fork /
new-client variants the regex matcher cannot) and writes
`(client_kind, client_version)` to `validators`. This drives the
client-family badges (Agave / Jito-Solana / Firedancer / ... plus
`agave_bam`, `rakurai`, `harmonic_*`, `firebam`, `raiku`,
`solana_labs`). External HTTP rather than Solana RPC, so it runs last
in the cold-start stagger.

### Wallet-activity ingester (`WALLET_ACTIVITY_INTERVAL_MS`, default 6h)

Enumerates registered `operator_wallets` and runs
`getSignaturesForAddress` per wallet, then calls
`getTransactionFeeAndPayer` per signature and keeps only **outgoing**
txs (`feePayer === wallet`). It upserts both per-day tx counts and
per-day tx-fee totals (`tx_fees_lamports`) into `wallet_daily_activity`;
both columns reflect the same outgoing-only set. RPC is tiered — the
walk selects `primaryRpc` vs the optional `archiveRpc` by phase (initial
/ incremental / backfill) and logs the chosen `rpcMode`. The upsert is
idempotent, so a partial tick is resumed on the next one.

### SIMD curation pipeline (`SIMD_CURATION_INTERVAL_MS`, default 12h) — not yet scheduled

Enriches pending `simd_proposals` rows via the Anthropic API
(`ANTHROPIC_MODEL`). Gated on `ANTHROPIC_API_KEY`: with no key the
pipeline is disabled and SIMDs stay pre-review. This would be the only
job that calls an API other than Solana RPC. **Not yet wired into the
scheduler** — no registration exists in `entrypoints/worker.ts`, so the
job does not tick and the `simd_proposals` table stays empty until it is
scheduled. The `GET /v1/simd-proposals` reader is live but returns an
empty list in the meantime.

The RPC-bursty jobs above carry staggered first-tick delays
(`initialDelayMs` in `entrypoints/worker.ts`) so a cold start does
not fire every job's first RPC call simultaneously. Every tick emits
`jobs_executed_total{job,outcome}` + `jobs_tick_duration_seconds{job}`
on the `/metrics` endpoint.

The Phase 2-6 jobs above write the gamification tables —
`validators` (client columns), `validator_github`,
`operator_wallets`, `wallet_daily_activity`, `simd_proposals`,
`simd_discussion_comments`, `validator_claim_events` — alongside the
claim surface (`validator_claims`, `validator_profiles`). The API
process reads these for the operator/SIMD/badge surfaces.

## Data flow

For any `(epoch, vote)`:

1. Epoch watcher creates the `epochs` row for `epoch` and refreshes
   the `validators` row for `vote`.
2. Slot ingester writes
   `(slots_assigned, slots_produced, slots_skipped, slots_updated_at)`.
3. Fee ingester (possibly many batches) adds to
   `block_fees_total_lamports`, `block_base_fees_total_lamports`,
   `block_priority_fees_total_lamports`, and
   `block_tips_total_lamports`, then updates freshness timestamps.
4. Aggregates job recomputes cluster medians from `processed_blocks`
   and `epoch_validator_stats`.
5. History API reads `epoch_validator_stats` in bulk to attach the
   indexed-validator average (mean) income per leader slot for each
   epoch (the legacy median is retained alongside it for back-compat).

The API reads a single `epoch_validator_stats` row and serialises it.
Each family's freshness is surfaced as a separate timestamp so a
client can tell what is stale.

## Idempotency and crash-safety

- **`processed_blocks` as a fact table.** The fee ingester never
  computes a value it has already written; duplicate slot visits are
  ignored by the primary-key conflict.
- **Aggregate rows are repairable caches.** `epoch_validator_stats`
  is updated incrementally for low-latency reads, but the accounting
  authority is `processed_blocks`. If the worker crashes after writing
  a fact row but before applying the aggregate delta, the fee ingester
  and closed-epoch reconciler rebuild cached totals from
  `processed_blocks`.
- **Cursors are per-job rows.** `ingestion_cursors.job_name` is the
  PK. Resumption is "read cursor, do work up to N blocks, write
  cursor". If the worker dies mid-batch, the next worker run picks
  up at the old cursor and re-processes any uncommitted slots; the
  primary key on `processed_blocks` debounces the repeats.

## Cold-start behaviour

On first boot, `epochs` is empty. Every endpoint that needs "the
current epoch" returns `503 not_ready` until the epoch watcher
completes its first tick (≤ `EPOCH_WATCH_INTERVAL_MS`, default 30s).
`/healthz` returns `200 degraded` during this window — the database
is fine, the indexer just has not caught up yet.

## Reorg safety

Solana's finalised commitment is already on the write side of a
supermajority vote; in practice we have never observed a finalised
slot reverted. We still add a 32-slot buffer
(`SLOT_FINALITY_BUFFER`, ~13 seconds at 400ms slot time) so the fee
ingester never reads a block that is both "finalised" and within the
buffer. Combined with the `processed_blocks` primary key, this gives
us at-most-once accounting for block fees without a compensating
delete path.

## Trade-offs

- **Optional chain stream, mandatory repair path.** Yellowstone gRPC
  can reduce live latency when configured, but JSON-RPC polling and
  reconciliation remain the source of repair for missed slots and
  provider disconnects.
- **No Jito payout API.** Income uses block facts only. That gives a
  running-epoch number and removes the delayed/optional Kobe payout
  dependency, but it means `blockTipsTotal*` is the gross on-chain tip
  total observed in produced blocks, not a post-TipRouter payout.
- **No inflation rewards.** Inflation rewards would need a
  per-`(epoch, identity)` lookup against `getInflationReward`, which is
  a separate RPC path with its own rate-limit envelope. Intentionally
  deferred.

## Integrating with an exporter (e.g. `0base-exporter`)

The exporter performs no RPC calls. It:

1. Reads its watch list from its own config.
2. For each scrape, fires `POST
/v1/validators/current-epoch/batch` to the indexer.
3. Flattens the JSON response into Prometheus gauges / counters.

Because the indexer has already pre-computed and cached the answer in
PostgreSQL, the scrape latency is dominated by a single SQL lookup
rather than by per-validator RPC round-trips. This was the original
motivation for splitting the indexer out of the exporter.
