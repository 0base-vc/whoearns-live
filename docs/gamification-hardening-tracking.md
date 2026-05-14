# Gamification hardening — tracker

This document tracks the **seven-expert adversarial review** of the
`feature/gamification` branch (commits `d563bcd … d5af9d1`, Phases
P0-P6) and the follow-up hardening work that closes the open items.
The reviewers were run in parallel as a single batch, each scoped to
one domain, and produced 115 findings across 8 categories:

| Severity                                     | Count |
| -------------------------------------------- | ----- |
| HIGH (functional / correctness)              | 21    |
| MED (operability, hygiene, partial coverage) | 52    |
| LOW (nits, polish, doc drift)                | 42    |

Status legend: `[ ]` open · `[~]` in progress · `[x]` fixed
(closed in the cited commit) · `[!]` deferred with note.

The tracker is intentionally light on prose — each entry points to the
file + line and the blocker (`B#`) that captures the larger remediation.
The full per-expert reports remain in this session's transcript and
were not duplicated here to avoid drift between two sources of truth.

---

## Reviewer panel (domains)

1. **Security** — auth flows, Ed25519 verification, replay protection,
   existence-oracle surfaces, prompt-injection paths, secret handling.
2. **Database** — migration safety, trigger races, idempotency,
   integer overflow, monotone-only updates, index coverage.
3. **REST surface** — OpenAPI parity, llms.txt / robots.txt drift,
   HEAD/304 / Cache-Control invariants, query param contracts.
4. **Solana protocol** — vote credits / SIMD-0033 math, leader slot
   accounting, gossip parsing, getSignaturesForAddress pagination.
5. **TypeScript architecture** — null-vs-undefined, error mapping,
   repo / service / route layering, ESM import discipline.
6. **AI / prompt engineering** — system prompt drift, body grounding,
   injection defense, reviewer workflow auditability, temperature 0.
7. **Operations** — Helm wiring, secret patterns, observability,
   rate limiting, RPC budget vs ANTHROPIC quota interactions.

A cross-cutting integration pass on top of those seven produced the
six BLOCKER-class findings below (B1-B6). Fixing B1-B6 is the bar
for "ship-ready"; the HIGH list closes the rest of the must-fix
gap; MED/LOW items follow in a second hardening pass.

---

## Blockers

### B1 — Node Tier TVC ratio saturates to 1.0

- [x] **B1.a**: SIMD-0033 max-credit-per-vote constant. Source:
      `src/services/node-tier.ts:226` uses `* 8n`. The spec's max is **16**
      (decaying linear bonus: latency 1 → 16, latency 2 → 15, …, latency
      16+ → 1; max per timely vote = 16). Constant is half what it should be.
- [x] **B1.b**: Denominator scale mismatch. `voteCredits` accrues on
      **every vote** the validator casts (≈1 per cluster slot), but the
      denominator is `slotsAssigned × 8` (own leader slots only). A 1500-
      validator cluster has ~1500× more cluster slots than per-validator
      leader slots, so the ratio routinely exceeds 1.0 and is clamped to
      1.0 — every measured validator looks "perfect" on TVC. The Node Tier
      composite is therefore effectively binary: composite ≈ `60 + 40 ×
reliability` ∈ {60..100}, which collapses tier classification into
      `forge`/`anvil` for any non-trivial reliability.
- [x] **B1.c**: Documentation drift. `docs/scoring.md` continues to
      cite the broken denominator semantics.

Fix path (closed in the Option-A commit):

- Constant `8n` → `16n` (SIMD-0033 correct).
- Denominator switches to **cluster-relative**: `measuredEpochs ×
SOLANA_SLOTS_PER_EPOCH × 16`. This is the genuine SIMD-33 upper
  bound (vote on every cluster slot, every vote landing within 1 slot).
- `SOLANA_SLOTS_PER_EPOCH = 432_000n` (mainnet-beta / testnet).
- `docs/scoring.md` updated to match.

### B2 — Wilson direction inverted

- [x] **B2.a**: `src/services/node-tier.ts:130-131` computes
      `wilsonLowerBound(skips, trials)` then derives `reliability =
1 - lowerBound`. Lower bound of skip rate is the **optimistic**
      end; reliability = 1 − lower bound is therefore **inflated**. A
      validator with 3 leader slots and 0 skips gets `lowerBound = 0`
      → `reliability = 1.0` — the exact small-sample inflation the
      function's docstring claims to prevent.
- [x] **B2.b**: Should use the **upper** bound of skip rate (worst
      plausible skip rate) so reliability is the **lower** bound of
      success rate (pessimistic).

Fix path: export `wilsonInterval(successes, trials)` returning both
bounds; switch `computeTier` to `1 - skipInterval.upper`. Keep
`wilsonLowerBound` as a thin wrapper for callers that genuinely want
the lower bound; rename internal usage to `pessimisticReliability`.

### B3 — REST surface drift (5 endpoints missing from public docs)

OpenAPI (`docs/openapi.yaml`) is the contract crawlers/MCP/ai-plugin
consume. Phases 3-6 shipped 5 new endpoints but never updated the
spec:

- [x] `POST /v1/claim/github/verify` (Phase 3)
- [x] `POST /v1/claim/wallet/verify` (Phase 3)
- [x] `GET /v1/operator-wallets/{wallet}/activity` (Phase 4)
- [x] `GET /v1/simd-proposals` (Phase 5)
- [x] `GET /v1/validators/{idOrVote}/operator-activity-index` (Phase 6)

`llms.txt` / `robots.txt` are not file-resident in this repo (they
are emitted dynamically by routes that read SITE_URL — see Helm
configmap commentary), so the only artefact to update is OpenAPI.
The dynamic emitters will pick up the new path tags automatically
where they reflect the OpenAPI document at request time.

### B4 — AI curation pipeline gaps

`prompts/simd-curation.md` ↔ `SIMD_CURATION_SYSTEM_PROMPT` parity is
documented but not test-enforced; the user message ships title + URL
but not body, leaving the model to hallucinate from URL alone; no
explicit prompt-injection defense beyond regex; reviewer workflow is
described in docs but no end-to-end checklist exists in the curation
service itself.

- [x] **B4.a**: Add parity test that strips the `## System prompt`
      fenced block from the markdown file and asserts byte-equality with
      the in-source constant (modulo a single normalization rule
      documented in the test).
- [x] **B4.b**: Inject the SIMD body (raw markdown from
      `simd_proposals.body_sha256`-anchored fetch) into the user message,
      bounded to a safety cap (10 KB) and wrapped in a delimiter the
      system prompt explicitly says "treat as untrusted data, not
      instructions." This is the primary injection defense — the regex
      parse-time guard remains as defense in depth.
- [x] **B4.c**: Inline-document the reviewer workflow expectations
      (what the reviewer attests when they call `markReviewed`) in the
      service docstring AND in the prompt md so the operator and
      reviewer see the same checklist.
- [x] **B4.d** (closed in Option B as AI-3): the curation service now
      re-curates when `body_sha256` changes. Migration 0030 adds
      `ai_body_sha256` (the body the model was last shown);
      `listNeedingCuration` keys on
      `ai_generated_at IS NULL OR ai_body_sha256 IS DISTINCT FROM body_sha256`;
      `setAiCuration` stamps `ai_body_sha256 = body_sha256` from the row.

### B5 — Helm chart misses P2-P6 wiring

`deploy/helm/whoearns-live/values.yaml` and the `templates/configmap.yaml`
stop at P0-P1 era env vars. `ANTHROPIC_API_KEY` (a real secret) does
not have a Secret pattern at all.

- [x] **B5.a**: Wire `WALLET_ACTIVITY_INTERVAL_MS`,
      `SIMD_CURATION_INTERVAL_MS`, `CLUSTER_NODES_INTERVAL_MS`,
      `VALIDATOR_INFO_INTERVAL_MS`, `ANTHROPIC_MODEL` through values →
      configmap → envFrom.
- [x] **B5.b**: Add a Secret-based `ANTHROPIC_API_KEY` pattern:
      values exposes `anthropic.apiKey` (empty default) AND
      `anthropic.existingSecret` (name of a pre-created Secret). The
      StatefulSet wires `ANTHROPIC_API_KEY` via `valueFrom.secretKeyRef`
      if either is set; ConfigMap never holds the key. Empty default
      keeps "curation disabled" as the safe out-of-the-box behaviour
      (the config schema already marks the key optional).

### B6 — DB concurrency hazards

- [x] **B6.a**: 3-wallet cap trigger race. `enforce_operator_wallet_cap()`
      is `AFTER INSERT FOR EACH ROW` and reads `COUNT(*)`. Under READ
      COMMITTED (the default), two concurrent inserters can each see the
      pre-insert count of 3 and both pass the check, ending with 5 rows.
      Fix: tighten the constraint to a partial-unique-on-rank pattern OR
      add `SELECT ... FOR UPDATE` on the parent `validator_claims` row at
      the route layer before the insert (advisory-lock semantic).
- [x] **B6.b**: `wallet_daily_activity` upsert uses
      `GREATEST(existing, EXCLUDED)` for `tx_count` / `tx_fees_lamports`.
      Sticky-high is wrong for `tx_count`: a buggy reindex that overcounts
      once would lock the bad value in forever. Switch to
      `EXCLUDED.tx_count` (last-writer-wins) since the ingester always
      recomputes from scratch (per the existing docstring); document the
      invariant.

---

## Reconciliation note (transcript-recovered)

The first version of this tracker's HIGH section was a **reconstruction
from memory after a context compaction** — it mapped every HIGH item
onto B1-B6 and marked them all `[x]`. That was wrong. The eight raw
per-expert reports were later recovered from the session transcript
and reconciled against the three hardening commits. The corrected
itemisation below is sourced directly from those reports (agent IDs
cited per domain so the full text stays recoverable).

**Headline correction: ~10 of the 22 per-report HIGH items are still
open.** B1-B6 + the MED/LOW sweep genuinely closed 12 HIGH items;
they did NOT close the REST error-envelope items, the four TypeScript
architecture items, or the two cross-cutting OAI-semantics items. The
earlier "SEC-1 / REST-1..5 / SOL-3 / TS-1 / SEC-2" labels were invented
during the reconstruction and do not correspond to real findings —
they are replaced wholesale below.

## HIGH-severity items (itemised, per expert report)

Per-report HIGH tally: Security 0, Database 2, REST 5, Solana 2,
TypeScript 4, AI 4, Ops 2, Cross-cutting 3 = **22** (the synthesis
said 21 — it under-counted TypeScript by one).

### Database — 2 HIGH, both closed

- [x] **DB-H1**: 3-wallet cap `AFTER INSERT` trigger has an
      interleaved-commit race (`0024_operator_wallets.sql:48`). → B6.a
      (migration 0029: `BEFORE INSERT` + `pg_advisory_xact_lock`).
- [x] **DB-H2**: `GREATEST` merge in `wallet_daily_activity` blocks
      bug-fix downward corrections (`wallet-activity.repo.ts:54`). → B6.b
      (last-writer-wins).

### Solana protocol — 2 HIGH, both closed

- [x] **SOL-H1**: wrong TVC max-credit constant `8` vs SIMD-0033 `16`
      (`node-tier.ts:226`). → B1.a.
- [x] **SOL-H2**: denominator counts leader slots, numerator counts
      all votes — ~500× scale mismatch, ratio always saturates 1.0. → B1.b.
- _(Wilson-direction inversion was tagged MED by the Solana expert but
  elevated to BLOCKER B2 by the synthesis — closed in Option A.)_

### AI / prompt engineering — 4 HIGH, all closed _(agent a35c6f12)_

- [x] **AI-H1**: parity test does not exist + the two prompt copies
      already differ byte-for-byte. → B4.a.
- [x] **AI-H2**: no prompt-injection-resistance clause for untrusted
      title/body content. → B4.b (untrusted-source rule + delimiters).
- [x] **AI-H3**: model only sees title + URL, not body — output is
      pure hallucination. → B4.b (`bodyFetcher` path + 10 KB cap +
      delimiter stripping). _Partial:_ the path exists but no default
      fetcher is wired, so curation still runs URL-only until a fetcher
      is injected — tracked as **AI-M-bodyfetch** below.
- [x] **AI-H4**: reviewer workflow has no acceptance checklist. → B4.c.

### Ops / SRE — 2 HIGH, both closed _(agent a68a4fbd)_

- [x] **OPS-H1**: Helm chart templates none of the P2-P6 env vars. → B5.a.
- [x] **OPS-H2**: `ANTHROPIC_API_KEY` has no Secret pattern. → B5.b.

### REST / HTTP — 5 HIGH, 1 closed / 4 OPEN _(agent a711d2da)_

- [x] **REST-H1**: 5 P3-P6 endpoints absent from `docs/openapi.yaml`. → B3.
- [ ] **REST-H2**: `llms.txt` + `llms-full.txt` are **stale** —
      `seo.route.ts:193-345` emits them as **hand-written static
      strings** enumerating only the v0.4 surface. **The earlier
      tracker claimed these were "dynamically emitted from OpenAPI" —
      verified false.** They list none of `/badge/*`, `/tier`,
      `/badges`, `/v1/simd-proposals`, OAI, claim-v2. Fix: regenerate
      both bodies in lockstep with the OpenAPI surface.
- [ ] **REST-H3**: `robots.txt` AI-crawler allow-list
      (`seo.route.ts:154-191`) only permits GPTBot/ClaudeBot/PerplexityBot
      on `/v1/leaderboard`, `/v1/epoch/current`, `/v1/validators/search`
      — every new public GET is `Disallow`. _(Solana/REST split: the
      REST expert tagged the robots line MED and the llms lines HIGH;
      counted here with REST-H2 as the "OpenAPI/llms drift ×3" the
      report summary cites. Treated as HIGH-adjacent — fix alongside H2.)_
- [ ] **REST-H4**: inline `reply.code().send({error})` payloads omit
      the `details` field the central `error-handler.ts` supports —
      ~20 call sites in `claim.route.ts`, plus `operator-activity-index`,
      `badge`, `og`. Clients must branch on handler-envelope vs
      route-envelope. Fix: a `sendError(reply, code, status, msg, details?)`
      helper, route all inline errors through it.
- [ ] **REST-H5**: `claim/github/verify` + `claim/wallet/verify` call
      `Schema.parse()` instead of the `safeParse()` + `unwrap()` pattern
      every other claim endpoint uses — inconsistent error `code`
      (`validation_error` vs `ValidationError`) for the same failure.

### TypeScript architecture — 4 HIGH, 0 closed / 4 OPEN _(agent a1801710)_

- [ ] **TS-H1**: optional-dep facade with no actual flag. Every P3+
      repo is declared `?:` "for when the gamification flag is off" —
      but **there is no flag**; `api.ts` instantiates all five repos
      unconditionally. `requireP3Deps()` + the four
      `if (deps.repos.X !== undefined)` blocks are dead code that can
      never fire. Fix: land a real `GAMIFICATION_ENABLED` config flag
      OR collapse the `?:` to required and delete the guards.
- [ ] **TS-H2**: `as unknown as <PayloadType>` on the HEAD
      short-circuits (`validators.route.ts:413`,
      `operator-activity-index.route.ts:104`) lies about the runtime
      value (`''` typed as `BadgesResponse`/`OaiResponse`). _Note: the
      MED/LOW sweep and Option A both edited the OAI HEAD path and
      **kept** this cast._ Fix: type the handler `void`/`reply`, or
      split GET and HEAD into separate handlers.
- [ ] **TS-H3**: `claim.route.ts` is 694 lines housing two unrelated
      concerns (v1 claim + v2 Gist/wallet), with crypto-adjacent
      freshness/nonce/SQLSTATE logic inlined at the route layer. Fix:
      split `claim-v2.route.ts`, push freshness/replay into the
      verification services.
- [ ] **TS-H4**: `_fakes.ts` covers none of the five new repos
      (`ValidatorGithubRepository`, `OperatorWalletsRepository`,
      `WalletActivityRepository`, `SimdProposalsRepository`,
      `SimdDiscussionsRepository`) — each test file hand-rolls its own
      fake, free to drift from the real repo. Fix: lift the five repo
      fakes into the shared `_fakes.ts`.
- _(`TS-2` in the old tracker — "promote OAI types to domain.ts" — was
  NOT a review finding. It shipped in Option B and is harmless, but the
  TS expert actually flagged `domain.ts` as a growing **god-module**
  that should be **split** — see TS-M1 below.)_

### Cross-cutting integration — 3 HIGH, 1 closed / 2 OPEN _(agent a4264d40)_

- [x] **CROSS-H2**: `docs/api.md` + `docs/openapi.yaml` out of sync
      with shipped code. → B3 (openapi) + MED/LOW sweep (api.md got the
      missing Phase 5 + 6 sections).
- [ ] **CROSS-H1**: the documented `claim → github → wallet → OAI`
      happy-path has **no working happy-path** — OAI returns
      `composite: null` or a wallet-only number because the Discussions
      ingest job is unshipped and P4 fees are `null`. The response
      can't distinguish "linked but no comments" from "ingest not
      running." Fix: add a top-level `ingestStatus`
      (`{ governanceIngestActive, walletFeesIngestActive }`) block.
- [ ] **CROSS-H3**: the public OAI endpoint scores `governance.score: 0`
      for **every** linked validator during the pre-ingest period (real
      number, not a sentinel). A pool-delegation script filtering
      `score >= 50` silently excludes everyone. Fix: return
      `governance.score: null` until the ingest cursor has advanced;
      document the `null` semantics.

### HIGH scorecard

**12 of the 22 HIGH closed** — DB-H1, DB-H2, SOL-H1, SOL-H2,
AI-H1, AI-H2, AI-H3, AI-H4, OPS-H1, OPS-H2, REST-H1, CROSS-H2.
(Plus the Wilson-direction fix, which the Solana expert tagged MED
but the synthesis elevated to BLOCKER B2 — also closed.)

**10 of the 22 HIGH still open** — REST-H2, REST-H3, REST-H4,
REST-H5, TS-H1, TS-H2, TS-H3, TS-H4, CROSS-H1, CROSS-H3.

## MED items (itemised, per expert report)

Per-report MED tally ≈ 52. Status: a handful were incidentally closed
by the three hardening commits; **most are open.**

### Security MED _(agent a43d08ff)_ — all OPEN

- [ ] **SEC-M1**: Ed25519 verify-envelope inconsistency — `claim.service.ts`
      uses `buildOffchainMessage`, the two P3 services verify raw JSON
      bytes; no `purpose` domain-separation field on the P3 nonces.
- [ ] **SEC-M2**: race-to-link Gist replay → self-DoS (attacker scrapes
      a public Gist proof and submits first; operator gets `nonce_replay`
      on their own claim). Fix: server-issued challenge or hash-commit.
- [ ] **SEC-M3**: no length bound on `simd_proposals.title` flowing into
      the Anthropic prompt. _B4 bounded the **body** at 10 KB; the
      **title** is still unbounded_ — add `CHECK (LENGTH(title) <= 400)` + ingester truncation.
- [ ] **SEC-M4**: identity-key compromise has no audit trail / no
      notification path — re-claim / re-link / wallet-register are
      silent and immediate. Fix: immutable `validator_claim_events` log + a public `GET /v1/claim/:vote/audit`.
- [ ] **SEC-M5**: `simd_discussions.reactions_count` sums **all** GitHub
      reactions, but the OAI docstring promises "peer-validator
      reactions" — gameable with reaction bots. Fix: store a separate
      `peer_reactions_count` JOINed against `validator_github` before
      the ingester ships.

### Database MED _(agent af24bcf5)_ — all OPEN

- [ ] **DB-M1**: `signed_nonce` UNIQUE is one-way — same-vote re-claim
      with a fresh nonce passes; migration-0025 commentary is
      misleading. (Comment fix.)
- [ ] **DB-M2**: `upsertClientBatch` silently no-ops for unknown
      identity; `rowCount` returned is "changed" not "attempted" —
      masks gossip/validators divergence.
- [ ] **DB-M3**: `IS DISTINCT FROM` NULL guard on `client_kind` — a
      NULL `clientKind` would violate the NOT NULL column; add
      `COALESCE(..., 'unknown')`.
- [ ] **DB-M4**: `simd_proposals.ai_questions` CHECK enforces length
      only, not JSON validity — corrupt JSON stores and silently reads
      back as `null`. Fix: switch column to `JSONB`.
- [ ] **DB-M5**: `wallet_daily_activity` has no FK to `operator_wallets`
      — one-click unlink orphans history; GDPR purge must know both
      tables. (Document, or add admin script.)
- [ ] **DB-M6**: OAI route runs 6 **sequential** queries against a
      pool of 10 — a cache-miss burst can saturate. Fix: `Promise.all`
      the independent reads; consider pool size 20. _(Also flagged by
      REST + Ops — see REST-M / OPS-M.)_
- [ ] **DB-M7**: UNNEST batch upserts silently truncate on
      mismatched-length input arrays — add an `array_length` assertion
      (4 repos).

### REST MED _(agent a711d2da)_ — all OPEN unless noted

- [~] **REST-M-cache**: cache-control values drifted across routes
  with no rationale. _Substantially addressed_ by the MED/LOW
  sweep's `src/api/cache-control.ts` tiers; the expert's specific
  asks (OAI `s-maxage` 1800→3600, `stale-while-revalidate` on
  simd-proposals) were NOT applied.
- [ ] **REST-M1**: `robots.txt` allow-list stale (see REST-H3).
- [ ] **REST-M2**: Gist/wallet failure responses set `code` = `message`
      = the machine reason string (`{code:"fetch_failed",
    message:"fetch_failed"}`) — needs a `humanMessageFor...` lookup.
- [ ] **REST-M3**: `/v1/simd-proposals` + `/v1/operator-wallets/:wallet/activity` + `/v1/validators/:idOrVote/tier` lack HEAD short-circuits — HEAD
      pays the full DB cost.
- [ ] **REST-M4**: OAI runs 5-7 queries inside the 60/min/IP budget —
      add a tighter per-route cap (e.g. 30/min).
- [ ] **REST-M5**: `/v1/simd-proposals` returns `{proposals:[]}` while
      every other list uses `{items:[]}` / `{results:[]}` — three names
      for "list response."
- [ ] **REST-M6**: no `GET /v1/operator-wallets/:wallet` parent
      resource — the `/activity` sub-path implies a missing parent.
- [ ] **REST-M7**: `/v1/claim/*` (6 routes) argues for `/v1/claims`
      (plural collection) in a future major version.
- [ ] **REST-M8**: tier/badges/OAI should consolidate under one
      `/v1/validators/:id/scoring` to avoid 3× duplicate lookups (major
      version; note in roadmap).
- [ ] **REST-M9**: conditional-route-registration → SPA-shell-200 risk
      if the `/v1/` guard in `setNotFoundHandler` is ever relaxed; add
      a positive 404-JSON assertion test.
- [ ] **REST-M10**: tier/badges/OAI not exposed via MCP — add
      `get_validator_tier` / `get_validator_badges` MCP tools.

### Solana MED _(agent a84928cc)_ — all OPEN

- [ ] **SOL-M1**: `getSignaturesForAddress` is a single 1000-cap call
      with no `before` cursor — high-volume operator wallets are
      under-counted permanently (no per-wallet checkpoint exists).
- [ ] **SOL-M2**: `client-kind.ts` regex misses some real `sig`
      variants (`solana-sig-validator/...`, space-separated); add
      fixtures for `0.405.x-jito-frkd`.
- [ ] **SOL-M3**: several tenure landmark epochs in `tenure.ts` are
      off by 50-100 (e.g. `FIREDANCER_LAUNCH: 850` — Frankendancer-on-
      mainnet was ~712; `RECENT: 950` — May 2026 is ~epoch 1015).

### TypeScript MED _(agent a1801710)_ — all OPEN

- [ ] **TS-M1**: `domain.ts` is a 624-line god-module; split into
      `domain/{validators,claim,simd,wallet,epoch}.ts`. _(Option B's
      TS-2 grew this file further — the real finding wants it split.)_
- [ ] **TS-M2**: `BuildServerDeps` is 11+ repos with 4 conditional
      register branches — introduce a `RouteRegistry` array.
- [ ] **TS-M3**: `Pick<>` deps on the OAI route protect nothing (the
      test fakes cast `as unknown as`); pick one consistent stance.
- [ ] **TS-M4**: `aiSummary as string` post-`.filter` cast in
      `simd-proposals.route.ts` — use a type-predicate filter instead.
- [ ] **TS-M5**: `upsertClientBatch` arg shape inlined twice — add a
      named `ValidatorClientUpsertInput` type.
- [ ] **TS-M6**: inconsistent throw-vs-`reply.send` across new routes;
      Postgres SQLSTATE branching in the route layer (`claim.route.ts`)
      — push the catch-and-reclassify into the repo.
- [ ] **TS-M7**: zero per-route tests for the four P3-P6 route plugins
      (also Cross-cutting CROSS-M-tests).

### AI MED _(agent a35c6f12)_ — all OPEN

- [ ] **AI-M-bodyfetch**: no default `bodyFetcher` is wired — B4.b
      built the path but curation still runs URL-only until a fetcher
      is injected.
- [ ] **AI-M1**: parity anchor doesn't include the user-message
      template (only the system prompt is mirrored).
- [ ] **AI-M2**: `proposal.title` not length-capped before
      interpolation (overlaps SEC-M3).
- [ ] **AI-M3**: partisan blocklist misses evasions (`merits adoption`,
      `recommended to approve`, non-English summaries).
- [ ] **AI-M4**: `FORBIDDEN_CHARS` misses `` ` ``, `javascript:`,
      markdown-link injection, `data:` URIs, control chars.
- [ ] **AI-M5**: no regression test pinning model behaviour (gated on
      `ANTHROPIC_API_KEY`).
- [ ] **AI-M6**: `AnthropicClient` ignores `429` / `retry-after` —
      one rate-limit hiccup loses the whole batch.
- [ ] **AI-M7**: `reviewer` identity is a free-form string with no
      validation (depends on the not-yet-built admin route).

### Ops MED _(agent a68a4fbd)_ — all OPEN

- [ ] **OPS-M1**: `.env.example` + `docker-compose.yml` miss
      `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / `SIMD_CURATION_INTERVAL_MS`.
- [ ] **OPS-M2**: wallet-activity ingester fires its first tick AT BOOT
      — RPC burst while `/healthz` is still `degraded`. Stagger it.
- [ ] **OPS-M3**: cluster-nodes ingester first tick races the
      validator-info backfill — cold-start RPC burst, 429 on public RPC.
- [ ] **OPS-M4**: no job-level Prometheus metrics — add
      `jobs_executed_total{job,outcome}` + `jobs_tick_duration_seconds{job}`.
      The "indexer silently failing every tick" scenario has no signal.
- [ ] **OPS-M5**: wallet-activity tick logs INFO even on a no-op.
- [ ] **OPS-M6**: `docs/operations.md` + `architecture.md` untouched by
      the entire branch — no runbook for the new jobs/env, no
      FK-dependent-restore caveat.

### Cross-cutting MED _(agent a4264d40)_ — all OPEN

- [ ] **CROSS-M1**: `/v1/claim/:vote/status` doesn't surface GitHub-link
      or wallet state — a UI needs 3 extra un-batched fetches.
- [ ] **CROSS-M2**: phase-numbering drift — `scoring.md` numbers 0-7,
      `roadmap.md` numbers 1-5, `architecture.md` doesn't mention phases.
- [ ] **CROSS-M3**: cache TTL drift between `/tier` (`s-maxage=3600`)
      and `/badges` (`s-maxage=1800`) — same tier, contradictory CDN
      windows. _(The cache-control module exists now but `/tier` +
      `/badges` were not migrated onto it — see REST-M-cache.)_
- [ ] **CROSS-M4**: v1 vs v2 claim endpoints use two replay mechanisms,
      two timestamp units (`timestampSec` vs `timestampMs`), two
      freshness windows — at minimum document it.
- [ ] **CROSS-M5**: conditional route registration → SPA-200 (dup of
      REST-M9).
- [ ] **CROSS-M-tests**: zero route-level tests for any P3-P6 endpoint
      (dup of TS-M7).

## LOW items

≈ 42 LOW across the eight reports — phrasing, one-line comments, edge
cases with no behaviour impact today. Representative examples: SVG
`<title>` should also strip `U+0085/U+2028/U+2029`; narrative override
should forbid backticks + RTL-override codepoints; `idx_validators_client_kind`
is premature; `CURRENT_DATE` TZ gotcha vs UTC bucketing; tier recomputed
in two routes (drift risk); `livePortion` constant divides by 0.5 in two
places; `hasGovernanceSignal` only checks `commentCount`. Not
individually tracked — recover from the per-expert agent transcripts if
a dedicated LOW pass is scheduled.

## What the three hardening commits actually did to MED/LOW

The "MED/LOW sweep" commit was scoped against the **pre-reconciliation
cluster approximation**, not this itemised list. Mapping it honestly
onto the real findings:

- **Helm README** — real, valuable, not a numbered review finding
  (the Ops report wanted `operations.md` updated, OPS-M6 — still open).
- **cache-control module** — addresses the _substance_ of REST-M-cache
  - CROSS-M3, but `/tier` + `/badges` were never migrated onto it and
    the specific TTL asks weren't applied; REST-M-cache / CROSS-M3 stay
    partially open.
- **docstring drift** — `scoring.md` + `api.md` fixes are real and
  overlap CROSS-H2 (closed) + CROSS-M2 (phase numbering — still open).
- **import order** — touched 3 files; not a numbered finding.
- **cache-control test** — real; TS-M7 / CROSS-M-tests (route tests)
  still open.
- **OpenAPI examples** — correctly resolved-by-decision.

Net: the sweep did real work but it did **not** close the itemised
MED backlog. Treat the MED list above as the source of truth.

---

## Closure record

| Commit                                                    | Genuinely closed                                                                                                                    | Notes                                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `fix(hardening): adversarial-review Option A — B1-B6`     | B1 (SOL-H1/H2), B2 (Wilson), B3 (REST-H1 + CROSS-H2 openapi half), B4.a-c (AI-H1/H2/H4 + AI-H3 path), B5 (OPS-H1/H2), B6 (DB-H1/H2) | 11 HIGH. The bundled tracker's "REST-1..5 / SOL-3 / TS-1 / SEC-1" labels were reconstruction artefacts.                                |
| `fix(hardening): Option B — B4.d/AI-3, AI-4, OPS-2, TS-2` | B4.d/AI-3 (body-drift re-curation), AI-4 (reviewer note)                                                                            | OPS-2 (ServiceMonitor) + TS-2 (type promotion) were **self-directed**, not review findings — harmless but not in the 22 HIGH / 52 MED. |
| `docs+fix(hardening): MED/LOW sweep`                      | CROSS-H2 (api.md half), substance of REST-M-cache/CROSS-M3                                                                          | Scoped against the cluster approximation, not this itemised list — see "What the three commits actually did" above.                    |
| _pending_                                                 | REST-H2/H3/H4/H5, TS-H1/H2/H3/H4, CROSS-H1/H3 (~10 HIGH) + the MED backlog                                                          | The real remaining work. SEC-2 from the old tracker was not a finding and is dropped.                                                  |
