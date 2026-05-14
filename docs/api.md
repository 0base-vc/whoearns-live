# HTTP API

Machine-readable version: [`openapi.yaml`](./openapi.yaml).
Historical client migration note: [`migrations/v0.3-api.md`](./migrations/v0.3-api.md).

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
  and `/mcp` routes are protected by the configurable `API_RATE_LIMIT_*`
  in-process limiter; high-volume deployments should still enforce their own
  ingress/CDN controls.

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
transaction counts, max priority fee, max Jito tip, compute-unit totals,
provider cost-unit totals, and explicit ComputeBudget request aggregates
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

Returns a ranked validator list for a selected sample window. The default is
`window=live_trend&sort=income_per_slot`, which combines the running epoch so
far with the latest final epoch.

Query params:

- `window` — `live_trend` (default), `current_only`, `stable_trend`,
  `final_epoch`, or `decade_epoch`.
- `epoch` — optional closed epoch number. Only valid with `window=final_epoch`.
- `limit` — 1-500, default 100.
- `sort` — `income_per_slot` (default), `total_income`, `mev_tips`, `fees`,
  or `skip_rate`.
- `minWindowSlots` — 1-500, default 4. Rows below this denominator are
  filtered.

Compatibility notes:

- A bare `?epoch=N` request is treated as `window=final_epoch&epoch=N`.
- Legacy sort aliases are accepted: `performance` and `income_per_stake`
  map to `income_per_slot`; `median_fee` maps to `fees`.

Windows:

- `live_trend` — current epoch elapsed leader slots + latest final epoch.
- `current_only` — current epoch elapsed leader slots only.
- `stable_trend` — current epoch elapsed leader slots + two latest final
  epochs.
- `final_epoch` — latest final epoch only, or `?epoch=N` when requested.
- `decade_epoch` — latest complete 10-epoch block. Validators must have
  rows in all 10 epochs to rank.

Example:

```bash
curl "https://whoearns.live/v1/leaderboard?window=decade_epoch&sort=income_per_slot&limit=25"
```

Rows include validator identity metadata, slot counts, block fee/tip totals,
window income fields, `incomeSolPerSlot`, stake snapshot fields when
available, `sampleStatus`, and a `claimed` boolean. Rows that ranked #1-#3 by
`income_per_slot` in the latest complete 10-epoch block also include
`decadeEpochStart`, `decadeEpochEnd`, and `decadeRank`; otherwise those fields
are `null`.

## `GET /v1/validators/search`

Searches known validators from the local database. This endpoint never calls
Solana RPC and opted-out validators are excluded.

Query params:

- `q` — required, 2-96 chars. Matches vote pubkey prefix, identity pubkey
  prefix, validator name, and keybase username. Prefix matches are ranked
  first; if they under-fill `limit`, a bounded name/keybase substring fallback
  fills the remaining rows.
- `limit` — clamped to 1-25, default 10.

Response:

```json
{
  "query": "0base",
  "limit": 10,
  "count": 1,
  "items": [
    {
      "vote": "5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ",
      "identity": "zeroT6PTAEjipvZuACTh1mbGCqTHgA6i1ped9DcuidX",
      "name": "0base.vc",
      "iconUrl": "https://example.com/icon.png",
      "website": "https://example.com",
      "claimed": true
    }
  ]
}
```

## `GET /v1/validators/:idOrVote/history`

Returns newest-first per-epoch history for one validator. `idOrVote` accepts a
vote account pubkey or identity/node pubkey.

Query params:

- `limit` — 1-200, default 50.

The response wraps `items: ValidatorEpochRecord[]` with validator metadata,
claim/profile state, and a `tracking` boolean that is true when the lookup
caused the validator to be added to the watched set.

Each item also includes `peerBenchmark`, an indexed-validator median for
`totalIncome / leaderSlots` in the same epoch. Closed epochs use
`slotsAssigned`; the running epoch uses `slotsElapsedAssigned`. The benchmark
is `null` until at least three indexed validators have income/slot facts. This
benchmark is populated on the history endpoint; single-epoch endpoints that
reuse `ValidatorEpochRecord` may return `peerBenchmark: null`.

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
  "slotsElapsedAssigned": 150,
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
  },
  "peerBenchmark": null
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
    "costUnits": "1300000000",
    "computeBudgetRequestedUnits": "4200000000",
    "computeBudgetLimitTxCount": 19400,
    "computeBudgetPriceTxCount": 12100,
    "maxComputeUnitLimit": "1400000",
    "maxComputeUnitPriceMicroLamports": "50000",
    "avgComputeUnitsPerProducedBlock": "30111411",
    "avgComputeUnitsPerTransaction": "61728",
    "avgCostUnitsPerProducedBlock": "31707317",
    "avgCostUnitsPerTransaction": "65000",
    "incomeLamportsPerMillionComputeUnit": "996300",
    "incomeSolPerMillionComputeUnit": "0.0009963",
    "priorityFeeLamportsPerMillionComputeUnit": "842700",
    "priorityFeeSolPerMillionComputeUnit": "0.0008427",
    "tipLamportsPerMillionComputeUnit": "105300",
    "tipSolPerMillionComputeUnit": "0.0001053",
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

## `GET /v1/validators/:idOrVote/tier`

Returns the validator's **Node Tier** (Phase 1 release: 2-signal composite
over the most recent 5 closed epochs). See [`scoring.md`](./scoring.md)
for the full formula.

Response shape:

```json
{
  "vote": "VOTE_PUBKEY",
  "identity": "IDENTITY_PUBKEY",
  "window": {
    "epochs": 5,
    "slotsAssigned": 432,
    "slotsSkipped": 3,
    "voteCredits": "3400000",
    "maxCredits": "3456000",
    "voteCreditsUpdatedAt": "2026-05-12T08:00:00.000Z"
  },
  "tier": "forge | anvil | hearth | kindling | unrated",
  "composite": 96,
  "components": {
    "tvcRatio": 0.985,
    "wilsonSkipRate": 0.012
  }
}
```

`tier === "unrated"` when the validator has fewer than 10 leader slots
across the window OR no credit-bearing rows in the window — the
confidence floor prevents tiny-sample validators from being mis-
classified as Forge. **`composite === null` when tier is `unrated`**
so a UI cannot accidentally display a half-shown score.

`window.voteCreditsUpdatedAt` is the OLDEST credit-row freshness in
the window; `null` when no credit-bearing rows exist. Clients can
detect stalled vote-credit ingestion by comparing this timestamp to
the current epoch's expected start.

The endpoint draws from `epoch_validator_stats` only — no live RPC.
`HEAD` is supported and short-circuits after the validator existence
check, before the history read + tier computation.

Cache-Control: `public, max-age=300, s-maxage=1800` (the shared
`SCORING` tier — see `src/api/cache-control.ts`). `tier` and `badges`
serve the same closed-epoch-derived data class and now share this
single named tier.

## `GET /v1/validators/:idOrVote/badges`

Returns composite profile-level badges (Phase 2):

```json
{
  "vote": "VOTE_PUBKEY",
  "identity": "IDENTITY_PUBKEY",
  "tenure": {
    "firstSeenEpoch": 100,
    "activeEpochs": 900,
    "landmark": "CYCLE_1_OG",
    "badge": "Cycle 1 OG"
  },
  "client": {
    "kind": "firedancer",
    "version": "0.405.20218",
    "updatedAt": "2026-05-13T08:00:00.000Z"
  },
  "tier": {
    "tier": "forge",
    "composite": 96,
    "windowEpochs": 5
  }
}
```

- `tenure.landmark` is one of `MAINNET_BETA_LAUNCH`, `CYCLE_1_OG`,
  `CROSS_CHAIN_ERA`, `DEFI_2`, `PRE_FTX`, `JITO_V2`,
  `FIREDANCER_LAUNCH`, `recent_operator`. The oldest landmark the
  validator predates wins (no double-counting).
- `client.kind` enum: `agave`, `jito_solana`, `firedancer`,
  `frankendancer`, `paladin`, `sig`, `unknown`. Sourced from
  `getClusterNodes.version`; `unknown` is the neutral default before
  the cluster-nodes ingester has run.
- `tier` mirrors `GET /v1/validators/:idOrVote/tier`. Bundled here so
  a profile page renders the full badge row in one round-trip.

`HEAD` is supported and short-circuits after the validator existence
check, before the history read.

Cache-Control: `public, max-age=300, s-maxage=1800` (the shared
`SCORING` tier — see `src/api/cache-control.ts`; the same tier
`/tier` uses, so the two can no longer drift). All three sub-objects
update on independent cadences: `tenure.activeEpochs` ticks each
epoch (~2 days), `client.kind` ticks on operator upgrade cycles,
`tier` ticks on epoch close.

## Claim/profile endpoints

Validator operators can prove ownership by signing a short message with the
validator identity key. No account, cookie, or password is created.

| Method | Path                     | Purpose                                            |
| ------ | ------------------------ | -------------------------------------------------- |
| GET    | `/v1/claim/challenge`    | Returns `{ nonce, timestampSec, expiresInSec }`.   |
| GET    | `/v1/claim/:vote/status` | Public claim/profile state for a vote pubkey.      |
| GET    | `/v1/claim/:vote/audit`  | Public, append-only claim-change audit log.        |
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

### `GET /v1/claim/:vote/status`

Public, unauthenticated. The whole-claim picture for a vote pubkey in a
**single** fetch — a dashboard does not have to chase this with separate
GitHub-link and operator-wallet reads.

```json
{
  "claimed": true,
  "profile": {
    "twitterHandle": "validator_name",
    "hideFooterCta": false,
    "optedOut": false,
    "narrativeOverride": null,
    "updatedAt": "2026-05-10T12:00:00.000Z"
  },
  "githubLink": {
    "githubUsername": "alice",
    "verifiedAt": "2026-02-01T00:00:00.000Z",
    "expiresAt": "2026-05-01T00:00:00.000Z"
  },
  "wallets": {
    "count": 2,
    "capReached": false,
    "oldestExpiresAt": "2026-04-15T00:00:00.000Z"
  }
}
```

- `claimed` / `profile` — `profile` is `null` when the validator is claimed
  but has no profile edits yet, and also when never claimed (`claimed: false`).
- `githubLink` — the ACTIVE linked GitHub identity, or `null` when there is no
  link **or** the attestation has lapsed. Same "lapsed = inactive" rule the
  OAI route applies.
- `wallets` — summary of the ACTIVE (not-expired) registered operator wallets:
  `count`, whether the per-validator cap (3) is `capReached`, and
  `oldestExpiresAt` (the soonest-expiring attestation, or `null` when none are
  registered) so a dashboard can nudge "re-attest" before a wallet drops out
  of scoring.

### Claim endpoints: v1 vs v2 signing

The four claim-surface mutation endpoints split into **two signing ceremonies
with different parameters** — a library author writing one signer for all four
needs to know this up front:

| Endpoints                                            | Timestamp field | Unit                  | Freshness window                          | Replay guard                                                   |
| ---------------------------------------------------- | --------------- | --------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| **v1** — `/v1/claim/verify`, `/v1/claim/profile`     | `timestampSec`  | Unix seconds          | ±5 min (symmetric)                        | Per-claim `lastNonceUsed` (the service rejects a reused nonce) |
| **v2** — `/v1/claim/github/verify`, `/wallet/verify` | `timestampMs`   | Unix **milliseconds** | 5 min past / **60 s future** (asymmetric) | `signed_nonce` UNIQUE index (migration 0025)                   |

Why the asymmetry exists:

- **Unit.** v1 predates v2; v2's canonical nonce embeds `expiresAtMs =
timestampMs + TTL`, so it works in milliseconds end-to-end. The units are
  **not** interchangeable — sending seconds where milliseconds are expected
  (or vice versa) fails freshness, not validation.
- **Window.** v2's future-skew is deliberately tight (60 s vs v1's 5 min):
  a future timestamp asks the server to extend a signature's verifiable
  lifetime, and combined with `expiresAtMs` a generous future-skew would push
  the effective replay window out to ~35 min. v1 has no `expiresAtMs`
  derivation, so a symmetric ±5 min is safe there.
- **Replay mechanism.** v1 tracks the last nonce per claim row; v2 stores
  every canonical nonce under a UNIQUE index. Both reject resubmission within
  the freshness window — v1 with the service's nonce check, v2 with HTTP 403
  `nonce_replay` from the constraint.

This subsection is documentation only — the endpoints' behaviour is unchanged.

### `GET /v1/claim/:vote/audit`

An immutable, append-only log of every claim-surface mutation for a vote
pubkey — claims, re-claims, profile edits, GitHub links, and operator-wallet
registrations — newest first. The point is forensic: if a validator identity
key is compromised an attacker can silently re-claim, re-link GitHub, and
register a wallet, and without this log the real operator would have no way to
notice. A `reclaim` event whose `priorIdentityPubkey` is non-null is the
signal that the validator identity was rotated.

Public and unauthenticated, like `/v1/claim/:vote/status` — every field
returned is already public on-chain or operator-published. The `submitted_ip`
recorded with each event (the request IP at write time) is a forensic field
that stays in the database and is **not** included in the response. Cache:
`public, max-age=300, s-maxage=1800` (5 min browser, 30 min CDN) — audit
history only changes on a deliberate claim-surface mutation.

```json
{
  "votePubkey": "Vote111111111111111111111111111111111111111",
  "events": [
    {
      "eventType": "reclaim",
      "identityPubkey": "Node222222222222222222222222222222222222222",
      "priorIdentityPubkey": "Node111111111111111111111111111111111111111",
      "detail": null,
      "createdAt": "2026-05-14T12:00:00.000Z"
    },
    {
      "eventType": "github_link",
      "identityPubkey": "Node111111111111111111111111111111111111111",
      "priorIdentityPubkey": null,
      "detail": { "githubUsername": "alice", "priorGithubUsername": null },
      "createdAt": "2026-05-10T09:30:00.000Z"
    }
  ]
}
```

`detail` is event-specific: `{ githubUsername, priorGithubUsername }` for
`github_link`, `{ walletPubkey, label }` for `wallet_register`, and `null` for
`claim` / `reclaim` / `profile_update`. The audit write is best-effort — it
happens after the underlying mutation commits, so a transient audit-write
failure never fails the operator's claim (and, by the same token, is not yet
transactional with it).

## Image surfaces

These are public, unauthenticated, cacheable image endpoints designed to
be embedded by third parties (operator websites, GitHub READMEs, social
share previews). All three share a "latest closed epoch only" data model
— they never show running-epoch numbers, so a CDN-cached asset cannot be
caught lying when the epoch closes mid-cache.

| Method | Path               | Returns | Purpose                                                           |
| ------ | ------------------ | ------- | ----------------------------------------------------------------- |
| GET    | `/og/default.png`  | PNG     | Static brand OG card (also at `/og-default.png` for back-compat). |
| GET    | `/og/:vote.png`    | PNG     | 1200×630 per-validator OG card (vote OR identity pubkey).         |
| GET    | `/badge/:vote.svg` | SVG     | 440×76 embeddable performance badge for operator websites.        |

The SVG badge ships `<title>` + `<desc>` accessibility metadata containing
the validator name + closed-epoch summary so screen readers and search
engines can announce content the satori-rendered vector paths otherwise
hide. Cache: `public, max-age=3600, s-maxage=86400` (1 h browser, 1 day
CDN).

Embedding example:

```html
<a href="https://whoearns.live/income/VOTE">
  <img
    src="https://whoearns.live/badge/VOTE.svg"
    alt="WhoEarns live performance for VOTE"
    width="440"
    height="76"
  />
</a>
```

## Claim v2 endpoints (Phase 3)

Two additional flows on top of `POST /v1/claim/verify`:

### `POST /v1/claim/github/verify`

Links a GitHub identity to a claimed validator via a Keybase-style
public Gist. No OAuth token is retained.

Request body:

```json
{
  "votePubkey": "...",
  "identityPubkey": "...",
  "githubUsername": "alice",
  "gistUrl": "https://gist.github.com/alice/<gistId>",
  "timestampMs": 1715670000000
}
```

The Gist body must contain (and only contain) the canonical nonce
serialised by WhoEarns plus the operator's Ed25519 signature:

```
---
{"domain":"...","expiresAtMs":...,"githubUsername":"alice","identityPubkey":"...","issuedAtMs":...,"votePubkey":"..."}
---
signature: <base58 Ed25519 sig>
```

Status codes: 200 on success, 403 for nonce/sig/policy failures, 502
for upstream Gist fetch errors, 503 when the P3 feature deps are not
wired in.

### `POST /v1/claim/wallet/verify`

Registers an operator-day-to-day wallet, co-signed by validator
identity AND wallet keys, anchored by a Solana memo transaction.

Request body:

```json
{
  "votePubkey": "...",
  "identityPubkey": "...",
  "walletPubkey": "...",
  "label": "cold",
  "timestampMs": 1715670000000,
  "identitySignatureB58": "...",
  "walletSignatureB58": "...",
  "anchorTxSignature": "..."
}
```

- Cap of 3 wallets per validator (HTTP 409 `wallet_cap_reached`).
- `label` is operator-chosen (≤32 chars).
- `anchorTxSignature` is the Solana tx signature of the
  operationally-alive memo transaction the wallet published.

**Anchor tx semantics — Phase 3 scope.** The current release validates
`anchorTxSignature` for base58 shape and exactly 64 decoded bytes (a
real Solana tx signature). It does **not** yet fetch the transaction
on-chain. Full on-chain verification — `getTransaction`, memo-program
ID assertion, memo content equal to a hash of the canonical nonce, tx
signer equal to `walletPubkey` — is a planned hardening pass (see
`docs/roadmap.md`). Until that lands, the anchor functions as an
operator-side commitment + crypto-shape filter rather than a proof
of on-chain activity. Co-signed identity + wallet Ed25519 signatures
remain the primary defense.

**Replay defense.** Both endpoints store the canonical nonce under a
UNIQUE index (migration 0025). Resubmission within the freshness
window returns HTTP 403 `nonce_replay`. Future-dated `timestampMs` is
rejected with `stale_timestamp` (the freshness window is asymmetric
— 5 min past, 60 s future — so a captured request cannot extend its
own usable lifetime).

## `GET /v1/operator-wallets/:wallet`

Parent resource for the `/activity` sub-path. Returns the wallet's
registration metadata.

```json
{
  "wallet": "Wallet11...",
  "vote": "Vote111...",
  "label": "cold",
  "registeredAt": "2026-02-01T00:00:00.000Z",
  "expiresAt": "2026-05-01T00:00:00.000Z"
}
```

Gated identically to `/activity` — only ACTIVE (not-expired)
registered wallets are exposed. An unregistered or
expired-registration pubkey returns HTTP 404 (`not_found`), so the
route is not a public existence oracle for arbitrary pubkeys. The
forensic `signedNonce` / `anchorTxSignature` columns are deliberately
omitted; everything returned is operator-published or derivable from
the on-chain registration. `HEAD` is supported and short-circuits
after the existence gate.

Cache-Control: `public, max-age=300, s-maxage=1800` (the shared
`SCORING` tier — registration metadata only changes on a deliberate
claim-surface mutation).

## `GET /v1/operator-wallets/:wallet/activity`

Phase 4 read endpoint. Returns the daily on-chain activity entries
the worker has indexed for a registered operator wallet.

Query parameters:

- `days` — 1-365, default 365. Window of UTC dates to return.

Response:

```json
{
  "wallet": "Wallet11...",
  "days": 365,
  "entries": [
    { "date": "2026-05-13", "txCount": 12, "txFeesLamports": null },
    { "date": "2026-05-12", "txCount": 4, "txFeesLamports": null }
  ]
}
```

Days with zero activity are omitted; clients zero-fill at render
time. Newest-first. `txFeesLamports` is the per-day sum of tx fees
the wallet paid as `feePayer`. Phase 4 ships counts only — the
field is `null` today (not `"0"`) so a client summing fees can
detect the unavailable-data state. Backfill ships in a follow-up
indexer pass (see `docs/roadmap.md`).

The endpoint is gated on registered-wallet membership. Probes for
unregistered or expired-registration wallets return HTTP 404
(`not_found`) — the route is not a public existence oracle for
arbitrary pubkeys. `HEAD` is supported and short-circuits after the
existence gate, before the activity DB read.

Cache-Control: `public, max-age=300, s-maxage=1800` (the shared
`SCORING` tier — see `src/api/cache-control.ts`).

## `GET /v1/simd-proposals`

Phase 5 read endpoint for the Pending SIMD widget. Returns AI-curated
SIMD proposals that a human reviewer has signed off on.

Query parameters:

- `limit` — 1-25, default 20. Number of reviewed proposals to return.

Response:

```json
{
  "count": 1,
  "aiModel": "claude-sonnet-4-6",
  "items": [
    {
      "simdNumber": 228,
      "title": "Example SIMD title",
      "status": "Review",
      "sourceUrl": "https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0228-example.md",
      "aiSummary": "Neutral ~50-word plain-text summary of what the SIMD changes.",
      "aiQuestions": [
        "How does this change a validator's per-slot hardware load?",
        "What second-order effects on commission economics could land first?",
        "Which operator tiers take the asymmetric cost?"
      ],
      "reviewedAt": "2026-05-10T12:00:00.000Z"
    }
  ]
}
```

The list field is `items` (with a sibling `count`) — the same
envelope shape as every other list endpoint (`/v1/validators/search`,
`/v1/leaderboard`). Only `reviewed_at IS NOT NULL` rows surface —
AI-generated curation that hasn't been spot-checked stays hidden.
Newest-reviewed first. The curation system prompt is published
verbatim at `prompts/simd-curation.md` (byte-equality enforced
against the runtime constant by a unit test). The internal
`reviewer_note` audit field is **not** included in the response.

`aiModel` is the Anthropic model the curation pipeline is _currently
configured_ to use (the `ANTHROPIC_MODEL` config value) — a
response-level field so a consumer pinning expected curation
behaviour can detect a model migration. It is **not** per-row
attribution: it reflects the model configured right now, not the
model each individual row was curated by. True per-row attribution
would need an `ai_model` column on the proposals table and is
deferred until the curation pipeline ships. `aiSummary` is capped at
~50 words (temperature 0 minimises variance but is not a determinism
guarantee — Anthropic models drift slightly even at temp 0);
`aiQuestions` carries 2-5 questions — a trivial SIMD may yield only
two genuine operator-facing trade-offs rather than padded filler.

`HEAD` is supported and short-circuits after `limit` validation but
before the DB read.

Cache-Control: `public, max-age=600, s-maxage=3600,
stale-while-revalidate=86400` (the shared `CATALOGUE` tier plus a
24 h stale-while-revalidate window — reviewed SIMDs change on an
hours-scale human-review cadence, so a CDN edge can serve the
slightly-stale list instantly while it revalidates in the
background).

## `GET /v1/validators/:idOrVote/operator-activity-index`

Phase 6 read endpoint. Returns the Operator Activity Index (OAI) — a
0-100 composite blending governance participation (50%) with wallet
liveness (50%). See `docs/scoring.md` for the formula.

Accepts a vote OR identity pubkey. Gated on three conditions, all of
which 404 on failure (the cases are collapsed to avoid leaking claim
/ opt-out state):

- the validator is known to the indexer;
- the validator is **claimed** (Phase 3) — no claim, no public OAI;
- the validator has **not opted out** of public scoring.

Response:

```json
{
  "vote": "Vote111...",
  "identity": "Node111...",
  "composite": null,
  "components": {
    "walletScore": 70,
    "governance": {
      "score": null,
      "commentCount": 0,
      "reactionsReceived": 0,
      "activeWindowCount": 0
    }
  },
  "ingestStatus": {
    "governanceIngestActive": false,
    "walletFeesIngestActive": false
  }
}
```

The example above is the shape **every linked validator sees today**:
the GitHub Discussions ingest that feeds the governance half is
unshipped, so `simd_discussion_comments` is empty in every real
deployment. While that ingest is inactive
(`ingestStatus.governanceIngestActive: false`), `governance.score`
is `null` — "we genuinely don't know yet" — **not** `0`. A real `0`
would be indistinguishable from "linked but has no comments", which
would silently exclude every linked validator from a `score >= N`
delegation filter. Because an honest 50/50 blend can't be reported
with one half unknowable, `composite` is `null` too. Once the ingest
ships and produces rows, `governanceIngestActive` flips to `true`
and `governance.score` / `composite` become real numbers.

The governance sub-component counts (`commentCount`,
`reactionsReceived`, `activeWindowCount`) are always the real values
(all `0` today) regardless of ingest status. `components.walletScore`
is always populated, so a consumer who only wants wallet liveness can
read it even when `governance.score` is `null`.

`ingestStatus` self-documents the Phase 6+7 partial release:

- `governanceIngestActive` — has the GitHub Discussions ingest
  produced data? `false` until that worker job ships.
- `walletFeesIngestActive` — does per-day `txFeesLamports` data
  exist? P4 ships tx-counts only (`txFeesLamports` is structurally
  `null` everywhere), so `false` until the fee backfill ships.

`composite` is also `null` in the genuine cold-start case where
neither half has any signal — clients should render an empty state
rather than a half-shown score either way. Only ACTIVE (non-expired)
Phase 3 registrations contribute signal; lapsed GitHub links /
operator wallets silently drop out. `HEAD` is supported and
short-circuits before the scoring queries (`ingestStatus` does not
change `HEAD` behaviour).

**Rate limit.** This endpoint runs 5-7 DB queries per request — ~5×
the per-request DB cost of a typical `/v1/*` read — so it carries a
tighter per-route cap of **30 requests/min/IP** (half the global
60/min). A normal UI consumer rendering one OAI panel per profile
view stays well under it.

Cache-Control: `public, max-age=300, s-maxage=1800` (the shared
`SCORING` tier).

## UI integration map

Where each gamification endpoint (Phase 1-6) is intended to render in
a future WhoEarns UI. This is a planning aid — the endpoints are live
and usable today regardless of UI status; the surfaces below are not
all built yet.

| Endpoint                                           | Intended UI surface                                        |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `/v1/validators/:idOrVote/tier`                    | Profile header — Node Tier badge + composite breakdown     |
| `/v1/validators/:idOrVote/badges`                  | Profile header — tenure + client + tier badge row          |
| `/v1/validators/:idOrVote/operator-activity-index` | Profile scoring panel — OAI composite + sub-component bars |
| `/v1/claim/:vote/status`                           | Operator dashboard — claim-progress / re-attest reminders  |
| `/v1/claim/:vote/audit`                            | Operator dashboard — claim-change forensic timeline        |
| `/v1/operator-wallets/:wallet`                     | Profile wallet panel — wallet registration metadata header |
| `/v1/operator-wallets/:wallet/activity`            | Profile wallet panel — 365-day activity heatmap grid       |
| `/v1/simd-proposals`                               | Governance widget / leaderboard sidebar — pending SIMDs    |

## `POST /mcp`

Streamable HTTP MCP endpoint for AI agents. The server exposes six read-only
tools: `get_current_epoch`, `get_leaderboard`, `get_validator`,
`get_validator_leader_slots`, `get_validator_tier`, and
`get_validator_badges`. `get_leaderboard` supports the same window
model as `/v1/leaderboard`, including `decade_epoch`, and includes
`decadeEpochStart`, `decadeEpochEnd`, and `decadeRank` on rows when relevant.
`get_validator_tier` and `get_validator_badges` return the same data as
`GET /v1/validators/:idOrVote/tier` and `/badges` respectively — both take a
vote OR identity pubkey and respect operator opt-out. MCP calls use the same
public per-IP rate limit as `/v1/*`; tool schemas also cap response sizes.
The public stateless transport accepts POST only; GET/DELETE return 405 to
avoid unauthenticated long-lived stream connections.
