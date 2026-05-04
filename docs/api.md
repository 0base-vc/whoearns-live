# HTTP API

Machine-readable version: [`openapi.yaml`](./openapi.yaml).

WhoEarns is AI-assisted, but the HTTP API is data-first. AI may help
operators monitor freshness, spot unusual validator-income patterns, and
draft explanations, but API values are derived from stored Solana block
facts and should be treated as the reproducible source of truth.

## Conventions

- **Base URL.** No path prefix. The service sits behind an ingress.
- **Content type.** Successful responses are `application/json; charset=utf-8`.
  `POST` request bodies must be `application/json`.
- **Keys.** `camelCase`.
- **Lamport amounts.** Decimal strings, never numbers. A `u64` can exceed
  `Number.MAX_SAFE_INTEGER` — parse as `BigInt` / `decimal.js` / similar.
- **SOL amounts.** Decimal strings. `1 SOL = 10^9 lamports`.
- **Timestamps.** ISO 8601 UTC (`"2026-04-15T09:59:42.000Z"`).
- **CORS.** Disabled by default.
- **Auth / rate limiting.** Public read routes are unauthenticated. `/v1/*`
  routes are protected by the configurable `API_RATE_LIMIT_*` in-process
  limiter; high-volume deployments should still enforce their own ingress/CDN
  controls.

## Error envelope

```json
{
  "error": {
    "code": "not_found",
    "message": "validator not found: Vote111...",
    "requestId": "c0a801aa-f3bd-4b0a-9c3f-0b4e18f6c2a7",
    "details": {
      "issues": [{ "path": "vote", "message": "pubkey contains non-base58 characters" }]
    }
  }
}
```

| HTTP | `code`             | Meaning                                                      |
| ---- | ------------------ | ------------------------------------------------------------ |
| 400  | `validation_error` | Request params or body failed schema validation.             |
| 404  | `not_found`        | The requested validator pubkey is unknown to the indexer.    |
| 503  | `not_ready`        | Indexer has not yet observed a current epoch. Retry shortly. |
| 503  | _(health only)_    | `/healthz` returns 503 when the database probe fails.        |
| 500  | `internal_error`   | Unhandled server error. Server logs contain `requestId`.     |

## Data-completeness contract (read this once)

The income API has one source of truth: Solana RPC block data. It reports
three operator-income streams:

- `blockBaseFeesTotal*`: leader base-fee share from produced blocks.
- `blockPriorityFeesTotal*`: priority fees from produced blocks.
- `blockTipsTotal*`: on-chain Jito tip-account transfers found in produced
  blocks.

`blockFeesTotal*` is `blockBaseFeesTotal* + blockPriorityFeesTotal*`.
`totalIncome*` is `blockFeesTotal* + blockTipsTotal*`.

Rows expose simple booleans instead of per-stream status enums:

| Field            | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| `isCurrentEpoch` | This row belongs to the latest open epoch observed by the indexer.                 |
| `isFinal`        | The epoch is closed. Closed-epoch numbers are the final stored totals.             |
| `hasSlots`       | Slot counters were ingested. Slot numeric fields are `null` when false.            |
| `hasIncome`      | Block fee/tip counters were ingested. Income numeric fields are `null` when false. |

For the current epoch, numeric values are lower bounds and can increase until
the epoch closes. For an old epoch with no stored stats row, the API still
returns 200 for a known validator with `hasSlots=false`, `hasIncome=false`,
and nullable numeric fields set to `null`.

### Slot fields — important semantic note

`slotsAssigned` is **always the full epoch leader-schedule total** for the
validator, sourced from `getLeaderSchedule`. It does NOT grow as the
epoch progresses. `slotsProduced` and `slotsSkipped` are running values
computed from local `processed_blocks` facts, so during an open epoch
they climb toward the final total while `slotsAssigned` is stable. A
leader slot with a transient RPC error has no fact row yet and is treated
as pending, not skipped.

Invariant at all times:

```
slotsAssigned >= slotsProduced + slotsSkipped
```

Strict inequality during an open epoch (leader slots still lie beyond
`currentSlot - finalityBuffer`). Equality at epoch close means every
leader slot has a local produced/skipped fact; otherwise the gap remains
pending until reconciliation fills it.

There is no Jito Kobe payout field in the public API. Kobe publishes a
post-epoch payout number after TipRouter distribution; this indexer uses the
raw on-chain tips directly so the running epoch can be displayed without
waiting for a payout API.

### Leader-slot facts and RPC usage

The leader-slot API reads the same watched-leader-slot facts that power income
totals. It does **not** scan every Solana slot and does **not** call RPC at
request time. The worker derives tx counts, failed-tx counts, tip-bearing
transaction counts, max priority fee, max Jito tip, and compute-unit totals
from the existing `getBlock(transactionDetails='full')` response.

RPC fetch failures are stored separately from true skipped slots. That lets
clients distinguish:

- `pendingSlots`: assigned leader slots with no local fact and no unresolved
  fetch error.
- `fetchErrorSlots`: assigned leader slots where the last RPC fetch failed and
  reconciliation has not resolved it yet.
- `missingFactSlots`: legacy local rows that predate block-fact capture and
  must not be used for public fact claims.
- `slotsSkipped`: finalized leader slots confirmed as skipped.

## `GET /healthz`

```json
{
  "status": "ok" | "degraded" | "fail",
  "checks": {
    "db": "ok" | "fail",
    "rpcLastSeenAt": "<ISO8601>" | null,
    "lastEpoch": 956
  }
}
```

HTTP 503 when `db: fail`, otherwise HTTP 200. `degraded` indicates the DB is
up but RPC has not been observed yet (typical right after boot).

## `GET /v1/epoch/current`

Returns metadata for the latest observed epoch.

```json
{
  "epoch": 956,
  "firstSlot": 412992000,
  "lastSlot": 413423999,
  "slotCount": 432000,
  "currentSlot": 413310000,
  "slotsElapsed": 318001,
  "isClosed": false,
  "observedAt": "2026-04-15T08:02:05.403Z"
}
```

- `currentSlot`: chain-tip slot last recorded by the epoch watcher. `null`
  until the watcher's first tick.
- `slotsElapsed`: `min(slotCount, min(currentSlot, lastSlot) - firstSlot + 1)`.
  `null` when `currentSlot` is `null`.

Status codes: 200 once the first epoch row is written; 404 before that.

## `GET /v1/leaderboard`

Returns a ranked validator list for a closed epoch. Without `epoch`, the
endpoint uses the latest closed epoch observed by the indexer.

Query params:

- `epoch` — optional epoch number.
- `limit` — 1-500, default 100.
- `sort` — `performance` (default), `total_income`, `income_per_stake`,
  `skip_rate`, or `median_fee`.

`performance` is the recommended stake-neutral view:

```
(blockFeesTotalLamports + blockTipsTotalLamports) / slotsAssigned
```

Rows include validator identity metadata, slot counts, block fee/tip totals,
performance-per-slot fields, stake snapshot fields when available, and a
`claimed` boolean.

## `GET /v1/validators/:idOrVote/history`

Returns newest-first per-epoch history for one validator. `idOrVote` accepts a
vote account pubkey or identity/node pubkey.

Query params:

- `limit` — 1-50, default 20.

The response wraps `items: ValidatorEpochRecord[]` with validator metadata,
claim/profile state, and a `tracking` boolean that is true when the lookup
caused the validator to be added to the watched set.

## `GET /v1/validators/:idOrVote/current-epoch`

Returns the record for a validator at the current epoch. `idOrVote` accepts
either the vote account pubkey or the identity/node pubkey. Always 200 for a
known validator, even when some metric families have no data yet.

```json
{
  "vote": "5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ",
  "identity": "zeroT6PTAEjipvZuACTh1mbGCqTHgA6i1ped9DcuidX",
  "epoch": 956,

  "isCurrentEpoch": true,
  "isFinal": false,
  "hasSlots": true,
  "hasIncome": true,

  "slotsAssigned": 432,
  "slotsProduced": 120,
  "slotsSkipped": 3,

  "blockFeesTotalLamports": "123456789",
  "blockFeesTotalSol": "0.123456789",
  "blockBaseFeesTotalLamports": "3456789",
  "blockBaseFeesTotalSol": "0.003456789",
  "blockPriorityFeesTotalLamports": "120000000",
  "blockPriorityFeesTotalSol": "0.12",
  "blockTipsTotalLamports": "90000000",
  "blockTipsTotalSol": "0.09",
  "totalIncomeLamports": "213456789",
  "totalIncomeSol": "0.213456789",

  "lastUpdatedAt": "2026-04-15T08:10:00.000Z",
  "freshness": {
    "slotsUpdatedAt": "2026-04-15T08:10:00.000Z",
    "feesUpdatedAt": "2026-04-15T08:10:00.000Z",
    "tipsUpdatedAt": "2026-04-15T08:10:00.000Z"
  }
}
```

| HTTP | `code`             | When                                                              |
| ---- | ------------------ | ----------------------------------------------------------------- |
| 200  | —                  | Validator is known; body reflects whatever state the indexer has. |
| 400  | `validation_error` | Pubkey fails base58 / length check.                               |
| 404  | `not_found`        | Pubkey is unknown to the indexer.                                 |
| 503  | `not_ready`        | No epoch row yet (cold start).                                    |

## `GET /v1/validators/:idOrVote/epochs/:epoch`

Same response shape. If the validator is known but the indexer never backfilled
that epoch, the response has `hasSlots=false`, `hasIncome=false`, and nullable
numeric fields set to `null` — it does **not** 404.

| HTTP | `code`             | When                              |
| ---- | ------------------ | --------------------------------- |
| 200  | —                  | Validator is known.               |
| 400  | `validation_error` | Invalid pubkey or epoch.          |
| 404  | `not_found`        | Pubkey is unknown to the indexer. |

## `GET /v1/validators/:idOrVote/epochs/:epoch/leader-slots`

Returns epoch-level facts aggregated from a validator's assigned leader slots.
This is not an insight endpoint by itself; AI/MCP/X automation can derive
public claims from these stored slot facts while the income page stays simple.

```json
{
  "epoch": 966,
  "vote": "Vote111...",
  "identity": "Node111...",
  "hasData": true,
  "isFinal": true,
  "quality": {
    "slotsAssigned": 42,
    "slotsProduced": 41,
    "slotsSkipped": 1,
    "processedSlots": 42,
    "factCapturedSlots": 42,
    "missingFactSlots": 0,
    "pendingSlots": 0,
    "fetchErrorSlots": 0,
    "complete": true
  },
  "summary": {
    "producedBlocks": 41,
    "totalIncomeLamports": "1230000000",
    "totalIncomeSol": "1.23",
    "totalFeesLamports": "1100000000",
    "totalFeesSol": "1.1",
    "totalTipsLamports": "130000000",
    "totalTipsSol": "0.13",
    "txCount": 20000,
    "successfulTxCount": 19800,
    "failedTxCount": 200,
    "unknownMetaTxCount": 0,
    "failedTxRate": 0.01,
    "signatureCount": 23000,
    "tipTxCount": 312,
    "tipBearingBlockCount": 18,
    "tipBearingBlockRatio": 0.439024,
    "avgPriorityFeePerProducedBlockLamports": "20000000",
    "avgPriorityFeePerProducedBlockSol": "0.02",
    "avgTipPerProducedBlockLamports": "3170731",
    "avgTipPerProducedBlockSol": "0.003170731",
    "maxPriorityFeeLamports": "90000000",
    "maxPriorityFeeSol": "0.09",
    "maxTipLamports": "50000000",
    "maxTipSol": "0.05",
    "computeUnitsConsumed": "1234567890",
    "bestBlockSlot": 417000123,
    "bestBlockIncomeLamports": "142000000",
    "bestBlockIncomeSol": "0.142"
  },
  "updatedAt": "2026-05-04T10:00:00.000Z"
}
```

Use `isFinal=true` and `quality.complete=true` for public rankings or X posts.
For running epochs, treat the response as a lower-bound explanation over the
facts seen so far.

## `POST /v1/validators/current-epoch/batch`

Bulk variant of the single-vote endpoint.

### Request

```json
{ "votes": ["Vote111...", "Vote222...", "..."] }
```

Body validation:

- `votes` is required, between 1 and 200 entries.
- Each entry must satisfy the same pubkey check as the path parameter.

### Response

```json
{
  "epoch": 956,
  "results": [
    /* one ValidatorEpochRecord per KNOWN vote */
  ],
  "missing": [
    /* votes unknown to the indexer */
  ]
}
```

- Votes that are **unknown to the indexer** go into `missing`.
- Known votes always land in `results`. A known vote with no stats row for
  the current epoch yields a placeholder with `hasSlots=false`,
  `hasIncome=false`, and nullable numeric fields set to `null`.

| HTTP | `code`             | When                                                       |
| ---- | ------------------ | ---------------------------------------------------------- |
| 200  | —                  | Request accepted.                                          |
| 400  | `validation_error` | `votes` missing, empty, oversize, or contains bad entries. |
| 503  | `not_ready`        | No epoch row yet.                                          |

## Claim/profile endpoints

Validator operators can prove ownership by signing a short message with the
validator identity key. No account, cookie, or password is created.

| Method | Path                     | Purpose                                            |
| ------ | ------------------------ | -------------------------------------------------- |
| GET    | `/v1/claim/challenge`    | Returns `{ nonce, timestampSec, expiresInSec }`.   |
| GET    | `/v1/claim/:vote/status` | Public claim/profile state for a vote pubkey.      |
| POST   | `/v1/claim/verify`       | Verify a signed claim without editing profile.     |
| POST   | `/v1/claim/profile`      | Verify signature and update public profile fields. |

Mutation bodies include:

- `votePubkey`
- `identityPubkey`
- `nonce`
- `timestampSec`
- `signatureBase58`

`/v1/claim/profile` also includes `profile`:

```json
{
  "twitterHandle": "validator_name",
  "hideFooterCta": false,
  "optedOut": false,
  "narrativeOverride": "Short public operator note."
}
```

The signed payload binds the purpose (`claim` or `profile`), timestamp, nonce,
pubkeys, and profile fields, so a profile signature cannot be replayed as a
different operation.

## `GET /mcp`, `POST /mcp`, `DELETE /mcp`

Streamable HTTP MCP endpoint for AI agents. The server exposes four read-only
tools: `get_current_epoch`, `get_leaderboard`, `get_validator`, and
`get_validator_leader_slots`. MCP calls are exempt from the `/v1/*` IP rate
limit, but tool schemas cap response sizes.
