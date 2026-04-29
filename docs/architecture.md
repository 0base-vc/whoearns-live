# Architecture

This document describes the runtime topology, the ingestion jobs, the
storage layout, and the invariants the indexer relies on. If you are
looking for HTTP contracts, see [`api.md`](./api.md).

## Components

```
+--------------------+
|  Solana JSON-RPC   |
+---------+----------+
          ^
          |
+---------+----------+     +-----------------+
| Slot ingester job  |     | Fee ingester    |
|  (getBlockProd.)   |     | (getBlock)      |
+---------+----------+     +--------+--------+
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

### Aggregates job (`AGGREGATES_INTERVAL_MS`, default 300s)

Recomputes cluster-sample medians from stored facts for the configured
top-N validator sample. It does not call RPC. These medians power the
income page's validator-vs-cluster context and leaderboard badges.

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

The API reads a single `epoch_validator_stats` row and serialises it.
Each family's freshness is surfaced as a separate timestamp so a
client can tell what is stale.

## Idempotency and crash-safety

- **`processed_blocks` as a fact table.** The fee ingester never
  computes a value it has already written; duplicate slot visits are
  ignored by the primary-key conflict.
- **Delta updates, not setters.** `block_fees_total_lamports` is
  incremented, never overwritten, so a crash between
  `INSERT processed_blocks` and `UPDATE stats` cannot rewind the
  stats total — the row will be retried against the next batch and
  the `ON CONFLICT DO NOTHING` on `processed_blocks` prevents
  double-counting.
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

- **No chain stream.** We poll RPC on timers rather than running a
  Geyser plugin. Simpler to operate; adds 30–60s of lag to the
  "current epoch" read path.
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
