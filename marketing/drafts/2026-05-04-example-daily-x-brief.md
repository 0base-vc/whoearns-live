# Daily X Brief Example - 2026-05-04

Account: `@WhoearnsLive`

Status: draft only, manual approval required.

## Source Data

- Current epoch endpoint: `https://whoearns.live/v1/epoch/current`
- Current epoch: `966`
- Current epoch observed at: `2026-05-04T02:15:24.139Z`
- Latest closed leaderboard endpoint: `https://whoearns.live/v1/leaderboard?limit=10&sort=performance`
- Latest closed epoch: `965`
- Epoch closed at: `2026-05-03T12:20:10.692Z`
- Scope: validators currently indexed by WhoEarns.
- Returned rows: `6`

## Suggested Image

Use:

`marketing/assets/2026-05-04-epoch-965-performance-ranking.png`

Alt text:

> WhoEarns closed epoch 965 performance ranking snapshot. Top five validators currently indexed by WhoEarns ranked by total income per scheduled slot, with per-slot income, total income, and skip rate columns.

## Single Post Candidates

### Candidate A - Ranking Snapshot

Closed epoch 965 snapshot:

Among validators currently indexed by WhoEarns, Crypto Plant ranked #1 by income per scheduled slot at ◎0.024841/slot.

Data only, not investment advice.

https://whoearns.live

### Candidate B - Methodology First

WhoEarns ranks validator performance by income per scheduled slot, not raw total income.

That keeps the view less stake-biased and easier to compare across operators.

Closed epoch 965 data:
https://whoearns.live

### Candidate C - Live Epoch Caution

Live epoch 966 is still provisional.

Closed epoch 965 is the latest finalized ranking view on WhoEarns. Current-epoch numbers are useful, but they can change until epoch close.

https://whoearns.live

## Short Thread Draft

### Post 1

Closed epoch 965 is finalized on WhoEarns.

We ranked currently indexed validators by total income per scheduled slot, with total income and skip rate shown for context.

Data only, not investment advice.

https://whoearns.live

### Post 2

Why per scheduled slot?

Raw total income usually favors larger stake. Income per scheduled slot is a cleaner operator-side comparison of block fee + Jito tip capture for the slots a validator was assigned.

### Post 3

Live epoch 966 is still in progress.

Use live numbers as `so far` data only. Closed-epoch views are the safer source for recap posts and ranking cards.

## Safety Review

- Postable after human review: yes.
- No `@mentions`.
- No investment/yield recommendation language.
- Uses `validators currently indexed by WhoEarns`, not `all Solana validators`.
- Uses closed epoch for ranking claims.
- Image and text both say `Data only, not investment advice`.
