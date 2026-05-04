# Roadmap

Forward-looking plan captured from product, technical, security, UX, and
AI-operations reviews in April 2026. Each phase lists a concrete trigger for
kickoff and the specific work inside.

Treat this document as the authoritative "why we'd do X next" — if
the answer to "why aren't we doing this now?" isn't written down
below, either do it or write it down.

## Phase 1 — Infra guardrails (✅ DONE)

- [x] Production-grade primary RPC provider in place.
- [x] `SolanaRpcClient` cost-aware token-bucket rate limiter
      (`SOLANA_RPC_CREDITS_PER_SEC` config).
- [x] Removed live `getBlockProduction` from slot counters — counters now
      derive from local `processed_blocks` facts.
- [x] `/v1/*` and `/mcp` Fastify rate limiter.
- [x] `processed_blocks` partitioning by epoch range (needed before
      watched set grows > 100).
- [x] Add-time stake/activity filter for any future "add my
      validator" flow (prevents 0-stake griefing).

## Phase 2 — Public-goods core

Ships the features that turn "tool maintainer can see their own
stats" into "anyone can look up any validator + see cluster context."

- [x] Hybrid on-demand lookup: any pubkey entered by a visitor is
      queried from the DB first, falls through to an RPC-backed live
      read if not watched yet, auto-promotes to the watched set on
      the 2nd hit (so popular lookups build historical coverage).
- [x] Top-N leaderboard on `/` — pulls from `epoch_aggregates`, drives
      SEO + delegator discovery.
- [x] `/about` public-goods page (mission, license, API link).
- [x] OpenAPI spec published + docs page.

## Phase 3 — Validator engagement

Pulls validator operators into a loop where they care about the site.

- [x] `/claim/:pubkey` — Ed25519 offchain-message verification
      against validator identity key. Unlocks: moniker + Twitter
      handle registration, footer attribution controls on the
      operator's own page, and self-service opt-out.
- [ ] X rank-change bot — posts "validator X moved from #87
      to #45 this week" with an OG card image. Tagging the operator
      makes the site come to them instead of the other way around.
- [x] OG image endpoint — server-rendered `/og/income/:pubkey.png`
      with income + rank snapshot.
- [ ] AI-assisted insight drafts — generate candidate public posts from
      closed-epoch API data only, with citations to the exact sample,
      epoch, and fields used before a maintainer publishes anything.

### Phase 3 — optional Yellowstone live path

Groundwork for lower-latency updates. HTTP polling only processes watched
validators' leader slots and remains the repair path, but an optional stream
keeps the current epoch fresher when a Yellowstone endpoint is configured.

- `subscribeBlocks` via gRPC makes the "live" rank-change bot
  responsive in seconds rather than a 30-second tick.
- Scales O(1) instead of O(watched × slots) — future-proof if
  watched-set explodes.

Shipped:

- [x] `YELLOWSTONE_GRPC_URL` and optional `YELLOWSTONE_GRPC_X_TOKEN`.
- [x] Watched-leader-slot gate so streamed blocks are only accepted for
      validators the indexer is tracking.
- [x] Polling and closed-epoch reconciliation remain enabled, so stream
      disconnects are repaired by the same `processed_blocks` fact model.

Remaining:

- [ ] Measure stream latency, reconnect frequency, and polling catch-up time
      by provider.
- [ ] Add provider-quality notes once there is enough production data.

## Phase 4 — Ecosystem distribution

Moves from "useful site" to "piece of Solana infra other people
build on top of". This is the gravity-generating phase and the
strongest signal for a Solana Foundation Delegation Program
application.

- [x] Public REST API versioned under `/v1/`, OpenAPI, Scalar docs, and MCP.
- [ ] Embeddable widget — drop-in for stake pool pages or validator
      websites.
- [ ] Prometheus exporter — read the API, emit validator-level
      metrics that plug into existing Grafana dashboards.
- [ ] Webhook subscriptions — "notify me when my validator's income
      changes by +/- X%" via common webhook targets.

## Phase 5 — Foundation application materials

Once Phase 1-4 are live, package the deliverables for stake-pool /
foundation review:

- [ ] Coverage + traffic stats dashboard.
- [ ] Technical blog post describing the indexer architecture.
- [ ] SFDP proposal draft citing the site as an ecosystem
      contribution.

---

## Parked (non-goal for now)

- **Self-hosted Agave + Geyser plugin**. Would give us a free
  Yellowstone feed without external dependencies, but adding a
  plugin to a voting validator increases the risk surface for the
  live stake. Only makes sense if we dedicate a separate non-voting
  RPC node.
- **Paid Yellowstone addon.** Overkill for the current scale while a public
  endpoint plus HTTP fallback covers the same soft real-time feature space.
- **Self-signup "add my validator" flow** without a claim step.
  Security review flagged mass-add griefing as L5×I5 risk — the
  claim flow in Phase 3 is the safe on-ramp.
