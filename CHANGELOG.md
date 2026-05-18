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
- Validator profile gamification (Phases 0-6, see `docs/scoring.md`):
  - **Node Tier** composite — `forge` / `anvil` / `hearth` / `kindling` /
    `unrated` — from a closed-epoch TVC ratio + Wilson-pessimistic
    reliability blend, served at
    `GET /v1/validators/:idOrVote/tier` and bundled with the tenure /
    client badges at `GET /v1/validators/:idOrVote/badges`.
  - **Tenure landmarks** (Mainnet-beta launch, Cycle 1 OG, Cross-chain era,
    DeFi 2, Pre-FTX, Jito v2, Firedancer launch) and **client kind**
    classification (Agave / Jito-Solana / Firedancer / Frankendancer /
    Paladin / Sig / Unknown) on the badges payload.
  - **Operator claim flow** (Ed25519 sign-over-nonce + Keybase-style
    GitHub Gist verification + operator-wallet registration), exposed
    as `GET /v1/claims/:vote`, `PUT /v1/claims/:vote/verify`,
    `PUT /v1/claims/:vote/profile`, `PUT /v1/claims/:vote/github`,
    `POST /v1/claims/:vote/wallets`, plus an append-only forensic audit
    log at `GET /v1/claims/:vote/audit`.
  - **Wallet daily activity** for registered operator wallets — a
    heatmap and 365-day series at
    `GET /v1/operator-wallets/:wallet/activity`, with the parent
    resource at `GET /v1/operator-wallets/:wallet`.
  - **AI-curated SIMD proposals feed** with reviewer attestation at
    `GET /v1/simd-proposals`.
  - **Operator Activity Index** (governance + wallet half blended 50/50)
    at `GET /v1/validators/:idOrVote/operator-activity-index`.
  - **Aggregate scoring bundle** at `GET /v1/validators/:idOrVote/scoring`
    — the profile-page one round-trip returning tier, tenure, client,
    and OAI together. Additive; the granular routes above remain
    available.
- MCP tools `get_validator_tier` and `get_validator_badges` mirroring
  the public HTTP surface.

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
- **BREAKING** — `/v1/claim/*` (Phase 3) restructured to RESTful
  `/v1/claims/*`: paths AND methods changed (`PUT` for the idempotent
  verify / profile / GitHub-link mutations, `POST /v1/claims/:vote/wallets`
  for the wallet append). No back-compat aliases. The first-party
  SvelteKit UI is the only consumer and ships in the same deployment
  image, so the rename is atomic.
- Node Tier math corrected (`docs/scoring.md`): the SIMD-0033 max-credit
  constant is now `16` (was `8`); the TVC denominator is cluster-relative
  (`slotsAssigned × SOLANA_SLOTS_PER_EPOCH × 16`), not own-leader-slot
  count, so the ratio no longer saturates to 1.0 cluster-wide; the
  Wilson interval is consumed at its _upper_ skip-rate bound so
  reliability is the _pessimistic_ lower bound (small samples no longer
  inflate to 1.0).
- Operator Activity Index partial-release honesty: while the GitHub
  Discussions ingest is inactive `governance.score` and `composite`
  return `null` ("unknown"), not `0`, with sub-component counts and
  `walletScore` still populated. A top-level
  `ingestStatus.{governanceIngestActive, walletFeesIngestActive}` block
  self-documents the partial state.
- Closed a seven-expert adversarial review of the gamification surface:
  6 BLOCKER-class items, 22 HIGH, ~52 MED, and the LOW backlog are all
  resolved across the hardening commits on this branch.

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
