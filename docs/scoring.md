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
> (Phase 1 — pessimistic block-production reliability + economic
> percentile vs the indexed cohort; vote credits intentionally
> excluded — see Phase 1 section for the rationale), the **tenure + client
> badges** at `/v1/validators/:idOrVote/badges` (Phase 2 partial —
> category leaderboards still planned), **Claim v2** (Phase 3 — GitHub
> Gist + co-signed operator-wallet verification), the **wallet
> activity** read surface (Phase 4 — tx-count indexing live, fee
> anchoring planned), the **SIMD curation** scaffolding (Phase 5 —
> callable code, ingest/scheduler not yet wired), and the **Operator
> Activity Index** endpoint (Phase 6 — scoring math + endpoint live,
> Discussions ingest not yet wired). Each phase section below carries
> an explicit per-phase status line — read it before citing a
> formula; "partial release" and "scaffolding shipped" mean exactly
> what they say.

### Phase-number crosswalk (scoring.md ↔ roadmap.md)

**The word "Phase" means different things in this document and in
[`docs/roadmap.md`](./roadmap.md).** This document numbers phases by
_scoring feature_ (Phase 1 = Node Tier, Phase 2 = tenure/client
badges, …). `roadmap.md` numbers phases by _product-rollout stage_
(Phase 1 = infra guardrails, Phase 2 = public-goods core, …). They
are not the same axis and the numbers do **not** line up. When a
reader cites "Phase 3", use this table to disambiguate which axis
they mean:

| scoring.md phase                                        | roadmap.md phase that ships it                |
| ------------------------------------------------------- | --------------------------------------------- |
| Phase 1 — Node Tier (reliability + economic percentile) | Roadmap Phase 3 (Validator engagement) onward |
| Phase 2 — Tenure, Client, Categories                    | Roadmap Phase 3 (Validator engagement)        |
| Phase 3 — Claim v2 (GitHub identity + wallet)           | Roadmap Phase 3 (Validator engagement)        |
| Phase 4 — Wallet Activity (365-day grid)                | Roadmap Phase 4 (Ecosystem distribution)      |
| Phase 5 — Pending SIMD widget + AI curation             | Roadmap Phase 4 (Ecosystem distribution)      |
| Phase 6 + 7 — Governance + Operator Activity Index      | Roadmap Phase 4 (Ecosystem distribution)      |

Rule of thumb: a bare "Phase N" **in this document** is always a
scoring-feature phase (the numbered `### Phase N` sections below). A
"Phase N" in `roadmap.md` is a rollout stage. Neither document was
renumbered — too many existing cross-references — so this crosswalk
is the bridge.

## Design principles

1. **Outcome over claim.** Every signal that can be derived from
   on-chain or network-observable data is preferred over operator
   self-declaration. Self-declaration channels are restricted to facts
   the chain cannot reveal (GitHub identity, day-to-day wallet) and
   are always cryptographically anchored.
2. **Behavior reveals operator skill.** Block-production reliability
   over a long window and economic productivity per leader slot
   jointly make low-quality operations impossible to disguise — both
   are on-chain-signed facts the validator cannot fake. We do not
   ask operators what their hardware is; we let multi-epoch behavior
   reveal it.
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

### Phase 1 — Node Tier (on-chain-anchored composite)

**Status:** live. Two-signal composite over the most recent 10 closed
epochs, deliberately constructed from signals that cannot be inflated
by client mods or networking-stack patches.

#### Why no vote credits

A previous release of this tier used **Timely Vote Credits (SIMD-0033)
ratio** as the dominant signal (60% weight). That was retired because
vote-credit accrual is operator-controlled along three independent
axes — none of which a delegator can audit:

1. **Client choice.** Firedancer ships measurably faster vote
   transmission than stock Agave. The credit gap is legitimate
   engineering work; it's also not a service-quality dimension
   delegators care about, and it puts smaller operators at a
   structural disadvantage they can't close.
2. **Networking proximity.** A validator with closer peering or
   partnered RPC infrastructure lands votes at lower latency.
   Again — legitimate, but reflects capital, not stewardship.
3. **Vote-tx send-side patches.** Custom Agave forks can pre-time
   vote signatures, adjust send cadence, or shave milliseconds off
   the send path. These don't violate consensus and aren't
   slashable, but they're also not observable from outside the
   validator.

Under the old formula a top-decile TVC ratio earned a forge tier
even when the operator's actual delegator-facing economics were
unexceptional. We treat that as a class of false positive worth
designing away from rather than tuning around.

#### What we use instead

```
economicScore = 0.90 × economicPercentile + 0.10 × cuSubscore
composite     = 0.30 × reliability + 0.70 × economicScore
tier          = forge    if composite ≥ 95
                anvil    if composite ≥ 80
                hearth   if composite ≥ 40
                kindling otherwise
unrated       = slotsAssigned < 10
             OR economic cohort < MIN_COHORT_FOR_PERCENTILE
             OR this validator measured in < MIN_MEASURED_EPOCHS_FOR_ECONOMIC closed epochs
             OR economicPercentile is null
```

Both signals are on-chain-signed facts the validator can neither
inflate nor fake:

- **`reliability`** = `1 − wilsonInterval(skipsSkipped, slotsAssigned).upper`.
  A leader slot is assigned by stake-weighted RNG before the epoch
  starts; a produced block is signed by the leader's identity key
  and lives on chain. The validator cannot retroactively "produce"
  a block they missed. The Wilson **upper** bound on skip rate
  (worst-plausible-given-sample) is consumed so a small-sample
  validator with 0 measured skips does NOT register as 100%
  reliable — at N=11 the upper bound is ~25%, yielding ~75%
  reliability. The leader-slot floor of 10 still forces `unrated`
  when the sample is too small to classify at all.

- **`economicPercentile`** = cohort percentile rank, in [0, 1], of
  this validator's median per-leader-slot income across the window.
  For each epoch we compute
  `incomePerSlot = (blockFeesTotalLamports + blockTipsTotalLamports) / slotsAssigned`
  (the `blockFeesTotalLamports` field aggregates the leader's
  post-burn share of base + priority fees; tips are on-chain Jito
  tips deposited in the eight public tip accounts). We take the
  **median** of those per-epoch values per validator — median, not
  mean, so a single lucky-MEV epoch can't dominate. We then
  `PERCENT_RANK()` the medians across every indexed, non-opted-out
  validator in the same window. Income is signed, on-chain, and
  cannot be minted by a client mod.

The weighting is intentionally economic-heavy: reliability is the
hygiene check (necessary for stewardship but ceilinged at "doesn't
miss blocks"), while economic productivity is the dimension that
translates directly into delegator returns and is the harder
signal to optimise for at the validator level. A top-economic
validator who's also flaking out on block production gets demoted —
but only by the reliability weight, not by a synthetic
"vote-quality" axis they can game.

Floors:

- **`MIN_LEADER_SLOTS_FOR_TIER = 10`** — below this the sample is
  too thin for reliability to mean anything.
- **`MIN_MEASURED_EPOCHS_FOR_ECONOMIC = 10`** — the full window; a
  tier needs a complete 10-epoch income record, so a validator
  missing any epoch (or still warming up) stays `unrated`.
- **`MIN_COHORT_FOR_PERCENTILE = 10`** — below this the rank is
  drawn against too few peers to be meaningful (a `PERCENT_RANK` of
  0.8 against 4 peers is not the same signal as against 1,500).

`composite` is `null` when `tier === 'unrated'` — no half-shown
scores. The window response surfaces `economicCohortSize`,
`economicMeasuredEpochs`, `economicMedianLamportsPerSlot`,
`incomeFreshness` (oldest of `feesUpdatedAt` / `tipsUpdatedAt`
across the window), and `cohortAsOfEpoch` (the `{fromEpoch, toEpoch}`
range the cohort percentile was sampled over, or `null` when the
window had no closed-epoch data) so a client can tell exactly which
gate fired, how stale the underlying income data is, and which
closed-epoch range the percentile reflects.

#### Compute units in the economic score

The economic half of the composite is itself a blend of income
productivity and compute-unit productivity:

```
economicScore = 0.90 × economicPercentile + 0.10 × cuSubscore
```

- **`cuSubscore`** is `cuPercentile` for a validator that produced
  at least one block in the window. For a validator with no produced
  blocks (a `null` `cuPercentile`), `cuSubscore` falls back to that
  validator's own `economicPercentile`, so `economicScore` collapses
  to `economicPercentile` — a non-producer is judged purely on the
  income it posts, never penalised for a CU metric it has no way to
  produce. The CU side never, on its own, forces `unrated`; only the
  income side does.
- **`cuPercentile`** is the `PERCENT_RANK()` of the validator's
  produced-block-count-weighted compute units per produced block,
  computed over the SAME indexed cohort and closed-epoch window as
  `economicPercentile` (one query — `findEconomicPercentile`).
  Windowed CU is `SUM(compute_units_consumed) / COUNT(produced
blocks)` across the window's epochs; validators with no produced
  blocks are excluded from the CU ranking. A validator's produced
  blocks are resolved by the full set of identity keys it ran across
  the window, so an operator that rotates its identity key — even
  mid-epoch — is not under-counted, provided the rotated-to/-from key
  appears somewhere in the measured window.

The 10% weight is deliberately small: income productivity is what
delegators actually receive and stays the dominant economic signal,
while compute-unit throughput is a secondary nudge rewarding
validators that pack more work into each produced block. CU is read
from `processed_blocks` — the same fact table the income figures
come from — so it adds no new ingestion path. `composite` surfaces
`cuPercentile` alongside `economicPercentile` in `components` for a
per-component breakdown.

#### Reliability floor

Regardless of how high `economicPercentile` is, **a validator whose
Wilson 95% upper bound on `skip_rate` exceeds `0.20` is hard-capped
at the `kindling` tier**. The Wilson _upper_ bound — not the raw
`slotsSkipped / slotsAssigned` point estimate — is used so a thin
sample cannot duck the floor, matching the pessimistic direction the
`reliability` component itself is built on. This is a
hygiene check, not a bypassable signal: a top earner who lets a
fifth of their assigned blocks drop is not a top-tier operator
regardless of how much fee + tip income they bank when they DO
land a block. The floor is a tier cap, not a composite cap — the
0.3 × reliability weight in the composite already pushes
high-skip-rate validators down, but the cap ensures they cannot
cross the 40 `hearth` threshold by economic mass alone.

#### Cohort scope

The `economicPercentile` cohort is **the INDEXED-VALIDATOR set**,
not the full Solana cluster. WhoEarns indexes a watched set
controlled by the deployment's `WatchMode` — `top:N` (the
default, e.g. `top:1000`), an explicit list of validators, or
`*` (every active validator in the leader schedule). The
response's `window.economicCohortSize` lets a consumer see the
pool size the percentile was drawn against; `cohortAsOfEpoch`
identifies the exact closed-epoch range it was sampled over.

This is a deliberate choice. A percentile against the full cluster
would mask `WatchMode=top:N` deployments — a validator that's
median-of-top-N looks middling here, but is in the top decile
globally; a delegator reading our tier should know that the
ranking is "vs the cohort we measure," not "vs all of Solana."
Operators reading their tier on a `top:500` deployment should
also know that a `forge` tier means top of the watched-500, not
top of all 2,000+ active validators.

#### Known limitations

- **Self-priority-fee inflation.** A validator can pay themselves
  priority fees on their own blocks to inflate their per-slot
  income. Today's income aggregation does NOT filter
  self-directed priority fees out of `blockFeesTotalLamports`.
  Flagged for future work — the on-chain fee-payer address is
  available, so a tx-level filter is feasible but expensive.
- **Stake fragmentation Sybil.** A large operator splitting their
  stake across many small identities can over-represent in the
  cohort and shift everyone else's percentile. Mitigation
  (Sybil-resistance cohort definitions) is flagged for future
  work; the current design assumes the indexed-validator set is
  honestly distinct identities.
- **Commission is NOT part of the tier.** A validator's
  commission percentage is invisible to this composite. A `forge`
  tier with 100% commission earns the operator a lot and earns
  the delegator nothing. Delegators must check commission
  separately — surfaced on the validator profile but never
  composed into the tier (commission has its own gameability
  problems: see "Anti-patterns" below for why "lowest
  commission" is not a leaderboard).
- **Cohort scope depends on `WatchMode`.** A validator's
  percentile against `top:500` and against `*` are different
  numbers. The cohort size is reported in every response;
  consumers comparing tiers across deployments should anchor on
  `cohortAsOfEpoch` + `economicCohortSize` rather than the raw
  percentile.
- **Opt-out as cohort manipulator.** A validator opting out
  shrinks the cohort by 1, shifting every remaining validator's
  percentile slightly. At cohort sizes of 1000+ the effect is
  small (≤0.1%); coordinated opt-outs could nudge percentile
  ranks near a cutoff. Mitigation flagged for future work.

#### Vote credits in the rest of the API

Vote credits are still persisted (`epoch_validator_stats.voteCredits`)
because they remain a protocol-level quantity — inflation rewards
distribution, SFDP delegation tier eligibility, and stake-pool
selection algorithms all read them. We just don't surface them on
the public _tier_ because we don't trust them as a delegation
signal for the reasons above. A future `/v1/validators/:id/anza-grade`
or similar endpoint could expose the raw TVC ratio against the
SIMD-0033 upper bound for operators who want to see where they
stand on Anza's published reward axis; that surface would be
deliberately separate from the tier.

### Phase 2 — Tenure, Client, Categories

**Status:** partial — tenure + client badges live; category leaderboards planned.

#### Live now

- **Tenure.** Derived from `validators.first_seen_epoch`. Returned by
  `GET /v1/validators/:idOrVote/badges` with one of 8 landmark
  classifications (Genesis Operator → Recent Operator). The oldest
  landmark the validator predates wins (no double-counting).
- **Client identification.** Single-source via
  `validators-app-client-ingester` (2 h cadence). validators.app
  runs a gossip CRDS listener and decodes the 16-bit
  `ContactInfo.version.client` field that JSON-RPC
  `getClusterNodes` drops — the canonical Solana Foundation
  client ID, per the
  `solana-foundation/solana-validator-client-ids` registry. This
  source distinguishes all 14 registered variants (Solana Labs,
  Jito Labs, Frankendancer, Agave, Paladin, Firedancer, Agave
  BAM, Sig, Rakurai, HarmonicFiredancer, HarmonicAgave,
  HarmonicFrankendancer, FireBAM, Raiku).
- **Why not two sources.** An earlier revision ran a
  `cluster-nodes-ingester` alongside (30 min cadence,
  `getClusterNodes.version` string + `services/client-kind.ts`
  regex). The regex can only emit 7 base kinds and was
  overwriting validators.app's specific variants — a node
  classified as `agave_bam` (validators.app) became `agave`
  (regex) within 30 minutes, then back to `agave_bam` 6 h later,
  then `agave` again 30 min after that. Average steady state
  was wrong because the regex job runs 12× more often. The
  cluster-nodes job is disabled (code retained for future
  toggle) so the canonical source is the only writer.
- Surfaced on `/badges` and persisted on `validators.client_kind`
  for future category leaderboards.

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

**Status:** partial — Gist + co-signed wallet verification live; profile surfacing + reverse lookup + Squads support planned.

#### Live now

- `PUT /v1/claims/:vote/github` accepts a public Gist URL whose
  body contains the canonical nonce + a base58 Ed25519 signature.
  The Gist URL's username must match the requested
  `githubUsername` (prevents publishing under someone else's
  account). Verification is stateless on the WhoEarns side — no
  OAuth token retained, GitHub never sees a callback.
- `POST /v1/claims/:vote/wallets` accepts co-signatures from BOTH
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
- Squads multisig support: threshold-of-members signatures plus
  on-chain member-set read.

### Phase 4 — Wallet Activity (365-day grid)

**Status:** partial — tx-count indexing + read endpoint + per-day fee
backfill live; cohort-percentile activity score (the OAI walletScore
overhaul) still planned.

#### Live now

- `wallet_daily_activity` table backed by a `getSignaturesForAddress`-
  driven worker job (`wallet-activity-ingester`, default 6 h cadence).
- `GET /v1/operator-wallets/:wallet/activity?days=365` returns daily
  tx counts for the requested window. UTC-bucketed. Sparse — zero-
  activity days are omitted, clients zero-fill at render time.
- Operator wallets in the table feed directly from Phase 3
  registrations.

> **Day-boundary uncertainty (accepted).** UTC bucketing uses Solana
> `blockTime`, a leader-reported wall-clock with documented ±minutes
> drift, so a tx landing within ~2 min of UTC midnight can bucket
> into the adjacent day. This is accepted, not a bug: the grid shows
> aggregate per-day counts, a single mis-bucketed tx is invisible at
> that scale, and the drift averages out.

#### Live now (Phase 4-extension)

- `WalletActivityIngesterService` + `wallet-activity-ingester` job
  — single source of truth for the wallet-activity heatmap. Walks
  each registered wallet's `getSignaturesForAddress` history
  newest-first, calls `getTransactionFeeAndPayer(sig)` per
  signature, **filters to outgoing-only via `feePayer ===
walletPubkey`**, and writes `tx_count` + `tx_fees_lamports` in
  one upsert. Two-cursor checkpoint:
  - `newestSignature` — newest sig EVER processed (regardless of
    outgoing/incoming filter outcome)
  - `backfillFrontier` — set when the previous tick hit the
    per-tick ceiling OR encountered per-sig misses (RPC missed
    slot, malformed meta), seeds the next-tick backfill walk
- Outgoing-only is the operator-activity contract: "what did THIS
  wallet do" not "what touched this wallet". Incoming and
  reference-only sigs (someone else paid the fee) are counted in
  the `signatures observed` metric for telemetry but don't
  contribute to `tx_count` or `tx_fees_lamports`. Both columns
  reflect the same outgoing-only set, so a delegator reading the
  heatmap can trust that "30 days of activity" means 30 days
  where the operator paid for a tx, not 30 days where someone
  sent them a dust airdrop.
- Tiered RPC routing keeps cost predictable. Public archive
  endpoints (publicnode) retain only ~60h of signature history —
  too short for the initial 365-day walk but more than enough
  for routine incremental polling. So the service picks the RPC
  per cursor state:
  - cursor null (fresh wallet) → primary RPC (`SOLANA_RPC_URL`,
    full history), runs once per wallet
  - cursor set, no frontier (steady-state incremental walk) →
    archive RPC (`SOLANA_ARCHIVE_RPC_URL`, ~60h window
    sufficient since cursor is at most a few hours old)
  - frontier set (paginating deeper than archive's retention) →
    primary RPC again
    Per-walk choice is logged at `wallet-activity-ingester: tick
complete` via `rpcModeCounts` so operators see the routing mix
    at a glance. When `SOLANA_ARCHIVE_RPC_URL` is unset the
    service falls back to "primary for everything" — functional,
    just more expensive on the paid endpoint.
- Per-tick `getTransactionFeeAndPayer` budget is
  `WALLET_FEE_BACKFILL_PER_TICK_LIMIT` (default 500). Earlier
  revisions of this code shipped as a separate
  `WalletActivityIndexerService` (cheap `getSignaturesForAddress`-
  only, no fee data, counted incoming + outgoing) plus a
  `WalletFeeBackfillService` (fee data only); they were merged
  because the per-sig `getTransaction` call needed for fees ALSO
  gives the fee payer for free, making the outgoing-only filter
  free to apply across both columns.
- `OperatorActivityIndex.ingestStatus.walletFeesIngestActive` flips
  on once any `wallet_daily_activity` row has a positive fee value
  (`WalletActivityRepository.hasAnyFeeData()`). The UI heatmap
  reads this flag to switch intensity binding from log-bucketed
  tx-count to log-bucketed lamports/day; the tooltip surfaces both
  the daily fee sum AND the avg lamports/tx so a viewer can spot a
  spam pattern (large count, tiny avg).

#### Planned next

- **Cohort-percentile activity score**: today the heatmap intensity
  uses fixed log-bucket thresholds for cross-wallet comparability;
  the OAI `walletScore` still uses `saturate(activeDaysLast90, 30)`
  (the count-based proxy that shipped in Phase 6). The intended end-
  state is `walletScore = log10(daily_tx_fees_lamports + 1)`
  percentile within the cohort of claimed operator wallets, which
  needs a small claimed-wallet population before it's a meaningful
  signal. The fee data exists now — the swap is purely the
  computation in `services/operator-activity-index.ts` plus a new
  repo query for the cohort distribution.

### Phase 5 — Pending SIMD widget + AI curation

**Status:** partial — curation service + read endpoint are callable, but the GitHub mirror job + curation scheduler + admin review endpoint are unshipped, so the pipeline has no automatic data flow yet.

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
  method but no HTTP route exposes it; it needs an admin-auth
  boundary that doesn't exist yet. Until the GitHub mirror +
  curation scheduler + this endpoint all ship, the public endpoint
  returns `{ "proposals": [] }` on every call.

Operators reading scoring.md should treat Phase 5 as "the
plumbing exists, the water isn't running yet." What DID land in the
hardening pass: a byte-equality parity test between the published
prompt and the runtime constant, an untrusted-body delimiter rule

- body-injection path, body-drift re-curation, and the Helm Secret
  wiring for `ANTHROPIC_API_KEY` (so a helm deploy _can_ enable
  curation once the missing jobs ship).

Curation contract, for reference: each curated SIMD gets a Claude
Sonnet–generated 50-word _neutral_ summary plus 3-5 discussion
questions tailored to validator operators (cost, risk, asymmetric
impact); the system prompt lives in `prompts/simd-curation.md`; no
AI output reaches the public endpoint until a human reviewer signs
off. Operator answers are posted by the operator personally on
simd.watch (GitHub Discussions via Giscus) — WhoEarns never proxies
the post.

### Phase 6 + 7 — Governance + Operator Activity Index

**Status:** partial — OAI scoring math + endpoint + mirror table/repo live; GitHub Discussions ingest job, `active_window` classifier, on-chain SIMD votes, and Realms votes not yet wired.

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
- **Partial-release honesty.** Because the GitHub Discussions
  ingest is unshipped (see "NOT yet live" below),
  `simd_discussion_comments` is empty in every real deployment, so
  the endpoint reports `components.governance.score: null` — "we
  genuinely don't know yet" — rather than `0`, which would be
  indistinguishable from "linked but has no comments" and would
  silently drop every linked validator from a `score >= N` filter.
  `composite` is then also `null` (an honest 50/50 blend can't be
  reported with one half unknowable). The governance sub-component
  counts and `walletScore` stay populated. A top-level
  `ingestStatus: { governanceIngestActive, walletFeesIngestActive }`
  block makes the partial state explicit — both flags are `false`
  today and flip when their respective ingests ship. Exact response
  shape: `docs/api.md`.

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
  ships the table stays empty, so the endpoint reports
  `governance.score: null` (not `0`) and `ingestStatus
.governanceIngestActive: false` for every validator — see the
  "Partial-release honesty" bullet above.
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
documents both the LIVE subset and the documented final shape (see
the "Documented final shape" block above — not repeated here to
avoid two drifting copies). As the missing components land, the
file's `livePortion` constant shifts and the existing tests catch
any regression.

When the GitHub Discussions ingest job ships it will read
simd.watch's discussion repo and attribute comments + reactions to
claimed validators by GitHub username. The OAI is always rendered
with its per-component breakdown and is never used as a single
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
  rewards co-located low-latency operation. We measure operator
  performance through on-chain outcomes (block-production reliability
  and per-leader-slot income — see Phase 1) rather than a
  geographic-spread penalty, and we never publish a hard
  "closer-is-better" ranking that would encourage Frankfurt-piling.
  Regional leaderboards keep being best-in-region a separate, valid
  flex.

## See also

- [`docs/architecture.md`](./architecture.md) — runtime topology, jobs.
- [`docs/api.md`](./api.md) — HTTP API reference.
- [`docs/roadmap.md`](./roadmap.md) — phased rollout, motivation per
  phase, security review notes.
