# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Live Trend 2.0 leaderboard windows: `live_trend` (default),
  `current_only`, `stable_trend`, `final_epoch`, and `decade_epoch`.
- Decade ranker badges for the Top 3 validators by income per leader slot
  across the latest complete 10-epoch block.
- DB-only validator search via `GET /v1/validators/search` for name,
  vote pubkey prefix, identity pubkey prefix, and keybase username lookups.
- AI-assisted positioning across public docs, SEO metadata, OpenAPI,
  `llms.txt`, and AI-agent guidance. The source-of-truth contract remains
  Solana block data, not AI-written summaries.
- Block-level slot facts for watched validator leader slots and
  `GET /v1/validators/:idOrVote/epochs/:epoch/leader-slots` for AI/X analysis.

### Changed

- `/v1/leaderboard` now defaults to
  `window=live_trend&sort=income_per_slot`; v0.3 sort aliases and bare
  `?epoch=N` remain accepted for compatibility.
- MCP `get_leaderboard` now follows the same window model as the public
  leaderboard instead of advertising latest-closed-epoch-only semantics.
- MCP `get_current_epoch.slotsElapsed` now counts the observed current slot
  and clamps to `slotCount`, matching the public epoch API semantics.
- Renamed the public Helm chart path, chart name, Docker Compose project,
  local image name, and logger service name to `whoearns-live`.
- Cleaned up public docs: moved the v0.3 API migration note under
  `docs/migrations/`, removed the Korean deployment-era API note, and
  aligned architecture/roadmap/OpenAPI wording with the current ingestion
  model.

## [0.3.0] - 2026-04-29

### Changed (API contract — breaking)

- Public income now uses Solana RPC block facts only: base-fee share,
  priority fees, on-chain Jito tips, and total income. The delayed Jito
  Kobe payout model is no longer part of the public contract.
- Removed `slotsStatus`, `feesStatus`, `mevStatus`, `mevRewardsLamports`,
  `mevRewardsSol`, `sources`, and `freshness.mevUpdatedAt` from validator
  epoch records.
- Added `hasSlots` and `hasIncome` booleans as the value gates. Numeric
  slot/income fields are `null` when the matching boolean is false, so
  missing data is not confused with true zero.
- `slotsAssigned` now returns the **full epoch leader-schedule total** for
  the validator, sourced from `getLeaderSchedule`. `slotsProduced` and
  `slotsSkipped` are running values from local per-slot facts.
- `GET /v1/validators/:vote/epochs/:epoch` returns `200` with an empty
  nullable row when the vote is known but the indexer never ingested that
  epoch. `404` now means only the vote account itself is unknown.

### Added

- `lastUpdatedAt` top-level timestamp on the validator response.
- `currentSlot` + `slotsElapsed` on `GET /v1/epoch/current`, populated
  by the epoch watcher so the API does not hit RPC synchronously.
- Block-fee ingestion via per-slot `getBlock` calls, split into base,
  priority, and on-chain Jito tip totals with idempotent
  `processed_blocks` tracking.
- Closed-epoch reconciliation that fills missed watched leader slots and
  rebuilds cached aggregate totals from `processed_blocks`.
- Optional cluster-internal Prometheus `/metrics` listener for API request
  counters, latency histograms, and Node.js process metrics.
- Read API: `GET /healthz`, `GET /v1/epoch/current`,
  `GET /v1/validators/:vote/current-epoch`,
  `POST /v1/validators/current-epoch/batch`,
  `GET /v1/validators/:vote/epochs/:epoch`,
  `GET /v1/validators/:vote/history`, and `GET /v1/leaderboard`.
- SvelteKit UI, OpenAPI YAML, and Scalar API reference page.
- Consistent error envelope (`{ error: { code, message, requestId,
details? } }`) and per-field freshness timestamps in validator
  responses.
- Helm chart at `deploy/helm/whoearns-live` with an
  all-in-one PostgreSQL/API/worker StatefulSet mode.
- Docker Compose development stack under `deploy/docker`.
- GitHub Actions CI: typecheck, lint, prettier, unit / integration /
  smoke tests with coverage gate at 80%.
- `.env.example` documenting every runtime configuration variable.

### Known limitations

- No inflation-rewards ingestion; only block fees and on-chain Jito tips
  are tracked.
- Single-network (mainnet) only.
- Worker is single-replica; no active-active HA.

## [0.1.0] - 2026-04-15

Initial prototype for Solana validator slot, fee, and income indexing.
