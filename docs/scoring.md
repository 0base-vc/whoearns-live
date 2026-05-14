# Scoring

This document is the public specification for every score, tier, and
badge WhoEarns surfaces on a validator profile. It exists because _a
score whose formula is hidden cannot be trusted as a delegation signal_
— anyone who delegates stake based on a ranking should be able to
verify the math.

The implementation lives in this repository under the MIT license. If
the docs here disagree with the code, **the code is the source of
truth and the docs need a PR**.

> **Status snapshot.** WhoEarns currently ships block-fee/tip income
> totals, skip rate, on-chain median fee benchmarks, the `performance`
> sort, OG image cards, the public `/badge/:vote.svg` SVG badge, the
> **two-signal Node Tier** at `/v1/validators/:idOrVote/tier`
> (Phase 1 partial — TVC ratio + Wilson skip lower-bound; the
> remaining two signals are planned), and the **tenure + client
> badges** at `/v1/validators/:idOrVote/badges` (Phase 2 partial —
> category leaderboards still planned). Phase 3+ formulas are
> roadmap — don't cite them until the matching phase ships.

## Design principles

1. **Outcome over claim.** Every signal that can be derived from
   on-chain or network-observable data is preferred over operator
   self-declaration. Self-declaration channels are restricted to facts
   the chain cannot reveal (GitHub identity, day-to-day wallet) and
   are always cryptographically anchored.
2. **Behavior reveals hardware.** We do not ask operators what their
   hardware is. Vote-latency tail, congestion-conditioned CU/slot,
   skip rate with a confidence floor, and timely vote credits jointly
   make low-quality hardware impossible to disguise as high-quality
   over a multi-epoch window.
3. **No single global leaderboard.** Total earnings are stake-weighted
   by definition — a single global ranking would mean the largest
   operators win every time and small-validator engagement dies.
   Bracketed and categorised rankings (small-validator, client-specific,
   regional, commission-stability) sit alongside the stake-neutral
   `performance` ranking.
4. **Commission cuts are not a competition.** WhoEarns does not feature
   "lowest commission" as a top-line ranking. Commission _stability_
   (low variance over a long window) is a legitimate signal; cutting
   commission to win a race directly damages the operator economics
   the protocol relies on.
5. **Per-component breakdown is mandatory.** Any composite score is
   rendered next to its sub-scores. A score of 84 must always show what
   it is composed of, so a reviewer can spot when one component is
   carrying the rest.
6. **Latest closed epoch only on cached artifacts.** OG images and SVG
   badges show closed-epoch numbers, never running-epoch numbers, so
   a CDN-cached asset can't be caught lying when the epoch closes
   mid-cache.

## Implemented (live today)

### Performance (the `performance` leaderboard sort)

```
performance = (block_fees_total + block_tips_total) / slots_assigned
```

Stake-neutral by construction: numerator and denominator both scale
linearly with stake, so two equally-skilled validators at different
sizes rank identically. Commission-neutral because block fees and tips
go directly to the operator identity, not through validator commission.

### Skip rate

```
skip_rate = slots_skipped / slots_assigned
```

Reported as-is on the profile. Used as an input to the Node Tier
composite (Phase 1) with the 95% Wilson **upper** bound of skip rate
to prevent small-sample "perfect skip rate" inflation. The composite
uses `1 − upperBound(skipRate)` (= the **lower** bound of success
rate) so reliability is pessimistic, not optimistic.

### Median fee / tip / total

Per-validator medians across blocks within an epoch. Used to compare a
validator's per-block packing skill against the cluster's
top-N-by-stake sample. Currently surfaced on validator detail pages
and through `/v1/validators/:id/current-epoch`.

## Planned (not yet shipping)

> _The formulas below describe future scoring. Do not cite them in
> delegation decisions until the matching phase ships. Each subsection
> is gated by an explicit phase status._

### Phase 1 — Effective Latency + Node Tier

**Status: partial release — 2 of 4 signals live.**

#### What's actually computed today (live now)

`GET /v1/validators/:idOrVote/tier` ships a **two-signal composite**
over the most recent 5 closed epochs:

```
composite = 0.60 × tvcRatio + 0.40 × (1 − wilsonSkipRate)
tier      = forge  if composite ≥ 95
            anvil  if composite ≥ 80
            hearth if composite ≥ 40
            kindling otherwise
unrated   = slotsAssigned < 10 OR maxCredits < 1 OR all rows unmeasured
```

Where:

- `tvcRatio` = `voteCredits / (measuredEpochs × 432_000 × 16)`,
  clamped to [0, 1]. Denominator is the SIMD-0033 cluster-relative
  upper bound (16 max credits/vote × one vote per cluster slot ×
  432_000 mainnet/testnet slots per epoch). The earlier denominator
  used a per-leader-slot count which off-by-≈clusterSize'd the
  scale and saturated every measured validator at 1.0 — see commit
  history if you're auditing the change. Rows with
  `voteCreditsUpdatedAt = NULL` (vote-credit indexer hasn't written
  this row yet) contribute slots **only** to the reliability signal
  — neither voteCredits nor the denominator — so ingestion lag
  cannot inflate **or** deflate the apparent ratio.
- `wilsonSkipRate` = 95% Wilson **upper** bound of `slotsSkipped /
slotsAssigned`. z = 1.959963984540054 (qnorm(0.975)). A tiny
  sample with 0 skips does NOT register as 0% skip — the upper bound
  on (0, 11) is ~25%, so a small-sample validator earns ~75%
  reliability, not 100%. The leader-slot floor of 10 still forces
  an `unrated` tier when the sample is too small to classify at all.
- `composite` is `null` when `tier === 'unrated'` (no half-shown
  scores).

The window response also surfaces `voteCreditsUpdatedAt` (oldest
credit timestamp in the window) so clients can tell when ingestion
has stalled.

#### Planned to add next (NOT live yet)

Once vote-tx parsing and congestion-conditioned CU/slot indexing
ship, the composite expands to the full four-signal formula:

- **Effective Latency percentile.** `median(landed_slot − voted_slot)`
  per validator per epoch, then ranked as a percentile against the
  eligible cohort. This is the outcome DoubleZero is engineered to
  improve and is deliberately provider-agnostic — a non-DZ validator
  with great peering scores as well as a DZ member.
- **Node Tier (final four-signal formula)** — replaces the live
  two-signal composite once the missing signals land:
  - 40% Timely-Vote-Credits ratio
  - 25% Vote-latency p99
  - 20% CU per leader slot conditioned on congestion
  - 15% Wilson-upper-bound skip rate (pessimistic reliability)
    10-epoch recency-weighted window (the live release uses a flat 5-
    closed-epoch window — extending to recency-weighted 10 ships with
    the new signals so all four are exercised on the same axis).

### Phase 2 — Tenure, Client, Categories

**Status: partial release — tenure + client badges live; category leaderboards planned.**

#### Live now

- **Tenure.** Derived from `validators.first_seen_epoch`. Returned by
  `GET /v1/validators/:idOrVote/badges` with one of 8 landmark
  classifications (Genesis Operator → Recent Operator). The oldest
  landmark the validator predates wins (no double-counting).
- **Client identification.** Pulled from `getClusterNodes.version`
  by the `cluster-nodes-ingester` worker job. Classified via
  `services/client-kind.ts` into agave / jito_solana / firedancer /
  frankendancer / paladin / sig / unknown. Surfaced on
  `/badges` and persisted on `validators.client_kind` for future
  category leaderboards.

#### Planned next

- **Category leaderboards.** Small-validator (<100k SOL stake),
  newcomer (<30 epochs active), client-specific, regional. Each
  category gets its own KOM-style leaderboard so the gamification
  rewards being best-in-bracket, not best-globally. The
  `client_kind` index and `first_seen_epoch` column already exist;
  the leaderboard route extension is the remaining work.
- **Behavioural Jito-Solana cross-check.** The on-chain
  `TipDistributionAccount` PDA is the high-confidence signal for Jito
  participation. Gossip version says "0.18.22-jito" but the PDA says
  the truth; the next iteration cross-references both.

### Phase 3 — Claim v2 (GitHub identity + operator wallet)

**Status: partial release — Gist + co-signed wallet verification live; UI surfacing planned.**

#### Live now

- `POST /v1/claim/github/verify` accepts a public Gist URL whose
  body contains the canonical nonce + a base58 Ed25519 signature.
  The Gist URL's username must match the requested
  `githubUsername` (prevents publishing under someone else's
  account). Verification is stateless on the WhoEarns side — no
  OAuth token retained, GitHub never sees a callback.
- `POST /v1/claim/wallet/verify` accepts co-signatures from BOTH
  the validator identity key AND the operator wallet key over a
  canonical nonce. An `anchorTxSignature` (Solana tx signature for
  the operator-published memo) provides the "operationally alive"
  defense-in-depth. 3 wallets per validator cap (DB trigger + route
  count check).

Storage:

- `validator_github` (one row per claimed validator; replaces on
  re-claim).
- `operator_wallets` (≤3 per claimed validator; cascade-delete on
  claim removal).

#### Planned next

- Profile surfacing on `/v1/validators/:idOrVote/badges` (GitHub
  username + wallet count + freshness).
- Reverse lookup endpoint for simd.watch governance ingest
  (`GET /v1/operator-wallets/lookup?wallet=…`).

- **GitHub identity** via Keybase-style Gist verification (no OAuth
  token retained). The Gist contains the validator-identity-signed
  registration nonce. Cross-platform: enables governance integration
  in Phase 6 + 7.
- **Operator wallet registration** via co-signed off-chain message
  (identity key signs, wallet key signs) plus an on-chain memo
  anchoring the registration nonce, proving the wallet is operationally
  alive at registration time. Capped at 3 wallets per validator,
  re-attested quarterly, one-click unlink.
- Squads multisig support: threshold-of-members signatures plus
  on-chain member-set read.

### Phase 4 — Wallet Activity (365-day grid)

**Status: partial release — tx-count indexing live; fee anchoring planned.**

#### Live now

- `wallet_daily_activity` table backed by a `getSignaturesForAddress`-
  driven worker job (`wallet-activity-ingester`, default 6 h cadence).
- `GET /v1/operator-wallets/:wallet/activity?days=365` returns daily
  tx counts for the requested window. UTC-bucketed. Sparse — zero-
  activity days are omitted, clients zero-fill at render time.
- Operator wallets in the table feed directly from Phase 3
  registrations.

#### Planned next

- **Fee anchoring**: `txFeesLamports` is reserved at zero today
  because `getSignaturesForAddress` doesn't return fee data and
  per-signature `getTransaction` would 10× the RPC cost. A
  scheduled backfill batched against the priority-fee ingester's
  existing block reads will populate fees without new round-trips.
- **Activity score**: per-day intensity = `log10(daily_fees + 1)`
  percentile within the operator-wallet cohort. The 365-day grid
  draws this directly. Cannot ship without fee data.

Daily intensity = `log10(daily_tx_fees_lamports + 1)` percentile
within the cohort of claimed operator wallets. The fee anchor makes
gaming the score cost SOL — count alone could be inflated with
1-lamport spam tx. Displayed as a GitHub-style 53×7 grid; the share
asset is a 1200×630 PNG.

### Phase 5 — Pending SIMD widget + AI curation

**Status: scaffolding shipped; pipeline not yet active.**

#### Shipped (callable code, no automatic data flow yet)

- `simd_proposals` table + repository for tracking SIMD rows with
  AI summary, AI questions, and reviewer state.
- `AnthropicClient` thin Messages-API wrapper (`claude-sonnet-4-6`
  default, 30 s timeout, no SDK lock-in).
- `SimdCurationService.runOnce()` reads un-curated rows, calls
  Anthropic, parses output, writes the result. Parser enforces
  defense-in-depth gates (length cap, partisan-phrase blocklist,
  no HTML chars).
- `prompts/simd-curation.md` mirrors the production system prompt
  as committed source — see the service file for the runtime
  copy. Two sources of truth kept aligned by a unit test.
- `GET /v1/simd-proposals?limit=N` (max 25) returns reviewed-only
  rows. Conditionally registered only when the repo dep is wired
  in.

#### NOT yet live

- **GitHub mirror job** — there's no worker job pulling the SIMD
  list from `solana-foundation/solana-improvement-documents`. The
  `simd_proposals` table stays empty until something inserts rows.
- **Curation scheduler** — `SimdCurationService.runOnce()` is
  callable but no worker tick triggers it.
- **Admin review endpoint** — `markReviewed()` exists as a repo
  method but no HTTP route exposes it. Until both ship, the public
  endpoint will return `{ "proposals": [] }` on every call.
- **Helm wiring** for `ANTHROPIC_API_KEY` — config schema accepts
  it, but the helm chart doesn't template a Secret. Deploys via
  helm will run with curation disabled.

Operators reading scoring.md should treat Phase 5 as "the
plumbing exists, the water isn't running yet."

For each active SIMD proposal:

- A Claude Sonnet–generated 50-word _neutral_ summary plus 3-5
  discussion questions tailored to validator operators (cost, risk,
  asymmetric impact).
- All prompts live in `prompts/` and all AI outputs land as PRs
  reviewed by a human before deploy.
- Operator answers are formatted as markdown by the WhoEarns UI and
  posted by the operator personally on simd.watch (GitHub
  Discussions–backed via Giscus). WhoEarns never proxies the post.

### Phase 6 + 7 — Governance + Operator Activity Index

**Status: scoring math + endpoint live; GitHub Discussions ingest job not yet wired.**

#### Documented final shape

```
OAI = 0.50 × WalletActivity  +  0.50 × Governance

WalletActivity:
  0.70 × log10(daily_fees_lamports) percentile vs cohort   [PLANNED]
  0.30 × active_days / 90                                  [LIVE]

Governance:
  0.40 × on-chain SIMD vote rate         [PLANNED]
  0.35 × GitHub Discussions comment count [LIVE — column live, ingest not yet wired]
  0.15 × peer-validator reactions count   [LIVE — column live, ingest not yet wired]
  0.10 × Realms major-DAO votes          [PLANNED]
```

#### Currently live

- Wallet half uses `100 × saturate(activeDaysLast90, 30)` —
  active-days only, no fee percentile yet (Phase 4 fee backfill
  not shipped).
- Governance half uses the comment-count + reactions-count
  saturating composite (70/30 within the live half because the
  remaining 0.40 + 0.10 = 0.50 governance weight is reserved for
  on-chain votes + Realms). `active_window` weights at 1.5× of
  stale-window comments when classified — but the classifier is
  not wired yet, so today every row reads `active_window=false`.
- Endpoint is gated on (a) validator is claimed, (b) not opted
  out of public scoring, (c) registrations are not expired.
- Composite is `null` when neither half has any signal.

#### Live now

- `simd_discussion_comments` mirror table (one row per
  Giscus-backed comment on a SIMD discussion, keyed by
  `(discussion_number, comment_id)`).
- `SimdDiscussionsRepository` — `upsertBatch` for ingest,
  `statsByUsername` for read.
- `services/operator-activity-index.ts` — pure-function composite:
  - `computeGovernance(commentCount, reactionsReceived, activeWindowCount)`
    saturating sigmoid; active-window comments weight 1.5× of
    stale-window. Returns 0-100 governance subscore.
  - `computeOperatorActivityIndex` blends governance + wallet
    halves 50/50. Returns `composite: null` when both halves have
    no signal (truly unmeasured), or composites whichever half has
    signal otherwise.
- `GET /v1/validators/:idOrVote/operator-activity-index` endpoint —
  resolves linked GitHub username via `validator_github`, aggregates
  discussion stats, sums wallet-activity active days from all
  registered operator wallets, returns the composite + breakdown.

#### NOT yet live

- **GitHub Discussions ingest job** — the table can be written
  via the repo, but no worker tick calls
  `octokit.discussions.listComments()` to feed it. Until that
  ships the table stays empty and every validator scores 0 on
  governance.
- **`active_window` classifier** — the column exists; what
  determines a "live" discussion (open vote window, recent
  upstream activity) needs definition + cross-reference with
  `simd_proposals.status`.
- **On-chain SIMD vote-by-stake ingestion** — the documented
  40% governance weight for on-chain votes. The remaining 50%
  weight is reserved.
- **Realms major-DAO votes** — documented 10% governance weight.
- **Helm + env wiring for `GITHUB_PAT`** — the ingest job will
  need GitHub API auth (5000-req/hour PAT vs ~60 unauthenticated).
  Not in chart yet.

The composite formula in `services/operator-activity-index.ts`
documents both the LIVE subset and the documented final shape. As
the missing components land, the file's `livePortion` constant
shifts and the existing tests catch any regression.

GitHub Discussions API ingest reads simd.watch's discussion repo and
attributes comments + reactions to claimed validators by GitHub
username. Composite score:

```
OperatorActivityIndex =
    0.50 × WalletActivity_90d
    0.50 × GovernanceParticipation_180d
        ├─ 0.40 × on-chain SIMD vote rate (vote-by-stake)
        ├─ 0.35 × GitHub Discussions comment count on SIMD threads
        ├─ 0.15 × peer-validator reactions received
        └─ 0.10 × Realms major-DAO votes (optional)
```

Always rendered with per-component breakdown. Never used as a single
global leaderboard.

## Anti-patterns we deliberately do not ship

- **Hollow XP / points** with no real redemption. We don't mint badges
  for the sake of badges; every badge maps to a verifiable on-chain or
  network-observable fact.
- **Follower counts that affect ranking.** DeBank-style follower
  graphs get Sybil-farmed in 48 hours. Followers can be displayed but
  never weighted.
- **Hardware specs as a tier criterion.** Self-declared specs are
  unverifiable. The Node Tier composite measures behavior — if the
  hardware is good, the behavior will demonstrate it; if it isn't,
  no amount of marketing can hide it.
- **"Lowest commission" leaderboard.** Encourages bottom-of-stack
  pricing that centralises to the deepest-pocketed operators.
- **Geographic-diversity penalty on a latency-centric L1.** Solana
  rewards co-located low-latency operation. We use **Effective Latency**
  (an outcome measurement) rather than a geographic-spread penalty —
  but never publish a hard "closer-is-better" ranking that would
  encourage Frankfurt-piling. Regional leaderboards keep being best
  in-region a separate, valid flex.

## See also

- [`docs/architecture.md`](./architecture.md) — runtime topology, jobs.
- [`docs/api.md`](./api.md) — HTTP API reference.
- [`docs/roadmap.md`](./roadmap.md) — phased rollout, motivation per
  phase, security review notes.
