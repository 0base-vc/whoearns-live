import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError, NotFoundError } from '../../core/errors.js';
import { normaliseHttpUrlOrNull } from '../../core/url.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { TierSnapshotsRepository } from '../../storage/repositories/tier-snapshots.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type {
  EpochInfo,
  EpochValidatorStats,
  TierSnapshot,
  Validator,
  ValidatorCurrentEpochResponse,
  VotePubkey,
} from '../../types/domain.js';
import {
  BatchBodySchema,
  VoteOrIdentityAndEpochParamSchema,
  VoteOrIdentityParamSchema,
} from '../schemas/requests.js';
import {
  serializeValidator,
  serializeValidatorPlaceholder,
} from '../serializers/validator-response.js';
import { cacheControl } from '../cache-control.js';
import { unwrap } from '../zod-helpers.js';
import {
  computeTier,
  oldestIncomeFreshness,
  slotCountersFromHistory,
  SKIP_RATE_FLOOR,
  WINDOW_CLOSED_EPOCHS,
  WINDOW_FETCH_ROWS,
} from '../../services/node-tier.js';
import type { NodeTier, TierInput, TierResult } from '../../services/node-tier.js';
import {
  EMPTY_ECONOMIC_LOOKUP,
  type EconomicPercentileLookup,
} from '../../storage/repositories/stats.repo.js';
import { findEconomicCohortVotesCached, findEconomicPercentileCached } from '../tier-cache.js';
import { narrowToDocumentedKind } from '../../services/client-kind.js';
import { summariseTenure } from '../../services/tenure.js';
import { findValidatorByVoteOrIdentity } from '../validator-lookup.js';

// Re-exported so existing importers that pull `findValidatorByVoteOrIdentity`
// from this route keep working; the canonical definition now lives in
// `../validator-lookup.ts` (shared with `/scoring`).
export { findValidatorByVoteOrIdentity };

export interface ValidatorsRoutesDeps {
  statsRepo: Pick<
    StatsRepository,
    | 'findByVoteEpoch'
    | 'findManyByVotesCurrentEpoch'
    | 'findManyByVotesEpoch'
    | 'findHistoryByVote'
    | 'findEconomicPercentile'
    | 'findEconomicCohortVotes'
  >;
  validatorsRepo: Pick<
    ValidatorsRepository,
    'findByVote' | 'findByIdentity' | 'findManyByVotes' | 'searchByText'
  >;
  epochsRepo: Pick<EpochsRepository, 'findCurrent' | 'findByEpoch'>;
  profilesRepo: Pick<ProfilesRepository, 'findOptedOutVotes'>;
  claimsRepo?: Pick<ClaimsRepository, 'findClaimedVotes'>;
  /**
   * Per-(epoch, vote) tier snapshots (migration 0045). Optional so the
   * route still boots when the snapshot ingester isn't wired (the
   * `trend` block degrades to `null` and the `/tier/history` endpoint
   * returns an empty `snapshots` array). Drives the `/tier` trend delta
   * and the `/tier/history` endpoint.
   */
  tierSnapshotsRepo?: Pick<TierSnapshotsRepository, 'findByVote' | 'findLatestTwo'>;
}

interface BatchResponse {
  epoch: number;
  results: ValidatorCurrentEpochResponse[];
  missing: string[];
}

const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(96),
  limit: z
    .preprocess((value) => value ?? 10, z.coerce.number().int())
    .transform((value) => Math.min(25, Math.max(1, value))),
});

/**
 * `/tier/history?limit=N` — default 16 (≈ a month of ~2-day epochs),
 * clamped to 1..60. Same defensive `preprocess` + `transform` shape as
 * the search limit so a missing / out-of-range value never errors.
 */
const TierHistoryQuerySchema = z.object({
  limit: z
    .preprocess((value) => value ?? 16, z.coerce.number().int())
    .transform((value) => Math.min(60, Math.max(1, value))),
});

interface ValidatorSearchResponse {
  query: string;
  limit: number;
  count: number;
  items: Array<{
    vote: string;
    identity: string;
    name: string | null;
    iconUrl: string | null;
    website: string | null;
    claimed: boolean;
  }>;
}

/**
 * Synthesise the minimal EpochInfo needed by the serializer when we only
 * have the epoch number (e.g. historical lookup without the row in memory).
 */
function epochInfoOrShim(epochInfo: EpochInfo | null, epoch: number): EpochInfo {
  if (epochInfo !== null) return epochInfo;
  return {
    epoch,
    firstSlot: 0,
    lastSlot: 0,
    slotCount: 0,
    currentSlot: null,
    isClosed: true, // unknown epoch -> treat as closed for stored historical rows
    observedAt: new Date(0),
    closedAt: null,
  };
}

/**
 * Closed-epoch window bounds the economic-percentile cohort was
 * evaluated against. Surfaced on the response so a consumer can
 * cross-reference the tier with the leaderboard's current epoch and
 * detect drift between a CDN-cached tier and a fresh leaderboard.
 * `null` when the window had zero closed rows (no cohort to evaluate).
 */
export interface CohortAsOfEpoch {
  /** Oldest closed epoch in the window (inclusive). */
  fromEpoch: number;
  /** Newest closed epoch in the window (inclusive). */
  toEpoch: number;
}

/**
 * Shape returned by `resolveTierForValidator` — the computed tier plus
 * the closed-epoch rows it was derived from + the cohort context, so
 * a caller can also surface the window size and the income-freshness
 * timestamp without re-reading.
 */
export interface ResolvedTier {
  result: TierResult;
  input: TierInput;
  closedRows: EpochValidatorStats[];
  economicLookup: EconomicPercentileLookup;
  /**
   * Window bounds the percentile cohort was evaluated over. `null`
   * when `closedRows` was empty (no window to evaluate) — mirrors the
   * empty-lookup branch.
   */
  cohortAsOfEpoch: CohortAsOfEpoch | null;
  /**
   * Vote pubkeys of the economic-percentile cohort — exactly which
   * validators the `economicPercentile` rank was computed against in
   * this window (cohort disclosure). Empty when the window was empty.
   * Makes the percentile independently reproducible — descriptive only.
   */
  cohortVotes: string[];
}

/**
 * Fetch the validator's recent history, window it to the most recent
 * CLOSED epochs, look up its economic-productivity percentile against
 * the indexed cohort, and compute the Node Tier. Shared by `/tier` and
 * `/badges` and `/scoring` so the window logic + composite live in
 * exactly one place — a future fifth tier signal only needs touching
 * here.
 *
 * Closed rows are identified explicitly (`epoch < currentEpoch.epoch`)
 * rather than assuming `history[0]` is the running epoch: a validator
 * outside the current leader schedule may have its newest history row
 * pointing at a CLOSED epoch, which the old "skip row 0" rule silently
 * discarded from the window.
 *
 * The economic-percentile lookup is a separate cohort query (it ranks
 * THIS validator against every other indexed validator's median per-
 * slot income in the same window) so we run it concurrently with the
 * per-validator history fetch. When the window has zero closed rows
 * we skip the lookup entirely — there's no window to rank against —
 * and synthesise an empty cohort result that forces `unrated`.
 */
export async function resolveTierForValidator(
  statsRepo: Pick<
    StatsRepository,
    'findHistoryByVote' | 'findEconomicPercentile' | 'findEconomicCohortVotes'
  >,
  epochsRepo: Pick<EpochsRepository, 'findCurrent'>,
  votePubkey: VotePubkey,
): Promise<ResolvedTier> {
  const [history, currentEpoch] = await Promise.all([
    statsRepo.findHistoryByVote(votePubkey, WINDOW_FETCH_ROWS),
    epochsRepo.findCurrent(),
  ]);
  const closedRows =
    currentEpoch !== null
      ? history.filter((r) => r.epoch < currentEpoch.epoch).slice(0, WINDOW_CLOSED_EPOCHS)
      : history.slice(0, WINDOW_CLOSED_EPOCHS);

  // Determine the closed-epoch window bounds for the cohort query.
  // `closedRows` is sorted newest-first by the repo so [0] is the most
  // recent closed epoch and [last] is the oldest in the window.
  // When the validator has no closed history we use the canonical
  // empty lookup — `computeTier` then drops to `unrated` cleanly with
  // no DB round-trip.
  let economicLookup: EconomicPercentileLookup;
  let cohortAsOfEpoch: CohortAsOfEpoch | null;
  let cohortVotes: string[];
  if (closedRows.length === 0) {
    economicLookup = EMPTY_ECONOMIC_LOOKUP;
    cohortAsOfEpoch = null;
    cohortVotes = [];
  } else {
    const newest = closedRows[0] as EpochValidatorStats;
    const oldest = closedRows[closedRows.length - 1] as EpochValidatorStats;
    // In-process LRU memoization: the cohort CTE behind
    // `findEconomicPercentile` is identical for every validator in the
    // same window, so a 60s TTL deduplicates the hot-page burst (e.g.
    // a profile page + a leaderboard hover prefetch firing within a
    // second of each other against the same closed-epoch window). The
    // cohort vote-membership list (cohort disclosure) shares that same
    // window and is fetched concurrently — its cache is window-keyed so
    // the first validator in a window warms it for the rest.
    const [lookup, votes] = await Promise.all([
      findEconomicPercentileCached(statsRepo, votePubkey, oldest.epoch, newest.epoch),
      findEconomicCohortVotesCached(statsRepo, oldest.epoch, newest.epoch),
    ]);
    economicLookup = lookup;
    cohortVotes = votes;
    cohortAsOfEpoch = { fromEpoch: oldest.epoch, toEpoch: newest.epoch };
  }

  const slotCounters = slotCountersFromHistory(closedRows);
  const input: TierInput = {
    votePubkey,
    slotsAssigned: slotCounters.slotsAssigned,
    slotsSkipped: slotCounters.slotsSkipped,
    economicPercentile: economicLookup.percentile,
    economicCohortSize: economicLookup.cohortSize,
    economicMeasuredEpochs: economicLookup.measuredEpochs,
    // CU percentile is computed by the same cohort query as the
    // income percentile (`findEconomicPercentile`); `null` when this
    // validator produced no blocks in the window.
    cuPercentile: economicLookup.cuPercentile,
  };
  const result = computeTier(input);
  return { result, input, closedRows, economicLookup, cohortAsOfEpoch, cohortVotes };
}

/**
 * Tier MOVEMENT block (migration 0045). Sourced from the two newest
 * `tier_snapshots` rows for the validator — `[0]` the latest closed
 * epoch, `[1]` the one before. `null` (on the response) when fewer than
 * two snapshots exist, so a UI shows nothing rather than a spurious
 * "no change". Descriptive: `delta` is `composite[0] − composite[1]`.
 */
export interface TierTrend {
  /**
   * Composite at the PREVIOUS snapshot (the older of the two). `null`
   * when that snapshot's tier was `unrated` (it carries no composite).
   */
  prevComposite: number | null;
  /**
   * `latestComposite − prevComposite`. `null` when either composite is
   * null (an `unrated` endpoint can't move by a number) — the consumer
   * then falls back to the tier-name change. Positive = improved.
   */
  delta: number | null;
  /** Tier label at the previous snapshot (e.g. `anvil`). */
  prevTier: string | null;
  /**
   * How many snapshots exist for this validator total (NOT just the
   * two read here). Lets a UI say "tracked for N epochs" — sourced from
   * the count, capped at the read limit by the caller.
   */
  epochsTracked: number;
}

/**
 * Build the `/tier` trend block from the validator's snapshot history.
 * `latestComposite` is the composite the live `/tier` response just
 * computed (which, on a freshly-closed epoch, may be one epoch AHEAD of
 * the newest snapshot — the snapshot ingester runs on a cadence). We
 * compare it against the most recent PRIOR snapshot so the delta
 * reflects "this epoch vs last".
 *
 * `snapshots` is `findLatestTwo`'s result (newest-first, 0-2 rows).
 * Returns `null` when there's no prior snapshot to compare against
 * (< 1 historical row), matching the "UI shows nothing" contract.
 *
 * Pure so it's unit-testable without a DB and reusable by `/scoring`.
 */
export function trendFromSnapshots(
  latestComposite: number | null,
  snapshots: TierSnapshot[],
  totalTracked: number,
): TierTrend | null {
  // Need at least ONE historical snapshot to show movement. The newest
  // snapshot is the prior closed epoch's recorded tier; we compare the
  // live composite against it.
  const prior = snapshots[0];
  if (prior === undefined) return null;
  const prevComposite = prior.composite;
  const delta =
    latestComposite !== null && prevComposite !== null ? latestComposite - prevComposite : null;
  return {
    prevComposite,
    delta,
    prevTier: prior.tier,
    epochsTracked: totalTracked,
  };
}

/**
 * The `/tier` response body MINUS `vote` / `identity` — i.e. the
 * `{ window, tier, composite, components }` block. Built from a
 * `ResolvedTier` so `/tier` and `/scoring` produce a byte-identical
 * tier object from the exact same code (the only difference between
 * the two endpoints' tier data is that `/scoring` nests it under a
 * `tier` key and drops the top-level `vote` / `identity`).
 *
 * `trend` is layered on AFTER the pure body assembly by the handler
 * (it requires an async snapshot read), so `tierBodyFromResolved`
 * itself stays pure — see the `/tier` handler.
 */
export type TierBody = Omit<NodeTierResponse, 'vote' | 'identity'>;

/**
 * Assemble the `/tier` body block from a resolved tier. The income-
 * freshness reduce + the window numerics live here so the two routes
 * serving this object can't drift.
 *
 * `economicMedianLamportsPerSlot` is surfaced as a stringified decimal
 * (lamports per slot) for the same reason the income endpoints
 * stringify lamport totals — JSON numeric precision is unsafe past
 * 2^53. Consumers that want SOL/slot can divide by 10^9 themselves.
 */
export function tierBodyFromResolved(
  resolved: ResolvedTier,
  validator: Pick<Validator, 'commission' | 'mevCommissionBps' | 'runsJito'>,
): TierBody {
  const { result, input, closedRows, economicLookup, cohortAsOfEpoch, cohortVotes } = resolved;
  const incomeFreshness = oldestIncomeFreshness(closedRows);
  // Latest closed-epoch row carries the stake snapshot — `closedRows`
  // is sorted newest-first by the repo. Pre-stake-snapshot epochs
  // emit `null` per the migration-0006 forward-only column.
  const activatedStakeLamports =
    closedRows[0]?.activatedStakeLamports !== undefined &&
    closedRows[0].activatedStakeLamports !== null
      ? closedRows[0].activatedStakeLamports.toString()
      : null;
  // Window-total vote credits — sum across the closed rows. Each row
  // is per-epoch credits (cumulative within the epoch, reset per
  // epoch by Solana). Summing gives the window's total vote-landing
  // productivity, parallel to the income totals. Reads `null` for
  // pre-migration-0021 epochs where the column defaults to 0; the
  // sum collapses to 0 in that case which is the right answer.
  const voteCreditsTotal = closedRows
    .reduce((acc, row) => acc + (row.voteCredits ?? 0n), 0n)
    .toString();

  // ── Per-component evidence assembly ──────────────────────────────
  //
  // Reliability evidence: one entry per closed-epoch row (newest first)
  // carrying the same slot counters the Wilson computation pooled. The
  // route emits the bounds + floor info `computeTier` already derived.
  const reliabilityPerEpoch = closedRows.map((row) => ({
    epoch: row.epoch,
    slotsAssigned: row.slotsAssigned,
    slotsSkipped: row.slotsSkipped,
  }));

  // Economic-percentile evidence: per-epoch lamports per leader slot
  // (`(blockFees + blockTips) / slotsAssigned`), with `null` when the
  // row has no leader slots OR its income timestamps are missing — the
  // same exclusion `findEconomicPercentile`'s cohort filter uses,
  // surfaced here so the per-epoch breakdown matches what counted
  // toward the median. Income breakdown sums the four-way fee
  // decomposition across closed rows in the window; pre-migration-0010
  // rows surface `0n` from the `NOT NULL DEFAULT 0` columns.
  const economicPerEpoch = closedRows.map((row) => {
    const hasIncomeMeasurement =
      row.slotsAssigned > 0 && row.feesUpdatedAt !== null && row.tipsUpdatedAt !== null;
    return {
      epoch: row.epoch,
      lamportsPerSlot: hasIncomeMeasurement
        ? (
            (row.blockFeesTotalLamports + row.blockTipsTotalLamports) /
            BigInt(row.slotsAssigned)
          ).toString()
        : null,
    };
  });
  const baseFeesLamportsSum = closedRows.reduce(
    (acc, row) => acc + (row.blockBaseFeesTotalLamports ?? 0n),
    0n,
  );
  const priorityFeesLamportsSum = closedRows.reduce(
    (acc, row) => acc + (row.blockPriorityFeesTotalLamports ?? 0n),
    0n,
  );
  const jitoTipsLamportsSum = closedRows.reduce(
    (acc, row) => acc + (row.blockTipsTotalLamports ?? 0n),
    0n,
  );

  // Derived ordinal rank from `percentile × (cohortSize - 1)`.
  // PERCENT_RANK gives 0 for the lowest peer and 1 for the highest, so
  // position 1 = highest, position `of` = lowest. `Math.round` matches
  // the spec; a cohort of size 1 has an undefined ordinal so we return
  // null there too (PERCENT_RANK is 0 for that case but a rank of "1
  // of 1" carries no information).
  const economicRank =
    result.components.economicPercentile !== null && input.economicCohortSize > 1
      ? {
          position:
            Math.round(
              (1 - result.components.economicPercentile) * (input.economicCohortSize - 1),
            ) + 1,
          of: input.economicCohortSize,
        }
      : null;

  return {
    window: {
      epochs: closedRows.length,
      slotsAssigned: input.slotsAssigned,
      slotsSkipped: input.slotsSkipped,
      economicCohortSize: input.economicCohortSize,
      economicMeasuredEpochs: input.economicMeasuredEpochs,
      economicMedianLamportsPerSlot: economicLookup.medianIncomePerSlotLamports,
      incomeFreshness: incomeFreshness?.toISOString() ?? null,
      activatedStakeLamports,
      voteCreditsTotal,
      // On-chain vote-account commission (integer 0-100). Sourced
      // from `getVoteAccounts.commission` and persisted on every
      // refresh tick — see `migrations/0044_validator_commission.sql`.
      // `null` for legacy rows the refresh hasn't covered yet.
      commission: validator.commission,
      // Jito MEV commission (basis points, 0-10000) + whether the
      // validator runs Jito at all. Sourced from stakewiz via the
      // `stakewiz-tenure-ingester` (migration 0046). Surfaced beside
      // `commission` because inflation commission alone is a half-
      // truth for any validator whose income leans on MEV tips —
      // `commission` governs staking yield, `mevCommissionBps`
      // governs the tip split. Both are displayed delegator FACTS,
      // never inputs to the tier (commission-neutral by design).
      // `mevCommissionBps` is `null` (and `runsJito` false) for
      // non-Jito validators; both `null` for pre-0046 rows.
      mevCommissionBps: validator.mevCommissionBps,
      runsJito: validator.runsJito,
      // Closed-epoch window bounds the cohort was evaluated over. A
      // consumer can compare these against the leaderboard's current
      // epoch to detect drift between a CDN-cached tier and a fresh
      // leaderboard. `null` when the window was empty (no closed
      // rows) and `computeTier` already produced `unrated`.
      cohortAsOfEpoch,
    },
    tier: result.tier,
    composite: result.composite,
    // `trend` requires an async snapshot read, so this pure body
    // assembly leaves it null; the /tier + /scoring handlers layer the
    // real trend on after fetching `tierSnapshotsRepo.findLatestTwo`.
    trend: null,
    components: {
      reliability: {
        score: result.components.reliability,
        evidence: {
          wilsonSkipRateUpper: result.wilsonSkipRateUpper,
          wilsonSkipRateLower: result.wilsonSkipRateLower,
          skipRateFloor: SKIP_RATE_FLOOR,
          floorEngaged: result.floorEngaged,
          perEpoch: reliabilityPerEpoch,
        },
      },
      economicPercentile: {
        score: result.components.economicPercentile,
        evidence: {
          validatorMedianLamportsPerSlot: economicLookup.medianIncomePerSlotLamports,
          cohortMedianLamportsPerSlot: economicLookup.cohortMedianLamportsPerSlot,
          cohortP25LamportsPerSlot: economicLookup.cohortP25LamportsPerSlot,
          cohortP75LamportsPerSlot: economicLookup.cohortP75LamportsPerSlot,
          rank: economicRank,
          perEpoch: economicPerEpoch,
          incomeBreakdown: {
            baseFeesLamports: baseFeesLamportsSum.toString(),
            priorityFeesLamports: priorityFeesLamportsSum.toString(),
            jitoTipsLamports: jitoTipsLamportsSum.toString(),
          },
          // Cohort disclosure: the exact vote pubkeys the percentile was
          // ranked against in this window, so the rank is independently
          // reproducible. Empty when the window had no closed rows.
          cohortVotes,
        },
      },
      cuPercentile: {
        score: result.components.cuPercentile,
        evidence: {
          validatorAvgCuPerBlock: economicLookup.validatorAvgCuPerBlock,
          cohortMedianCuPerBlock: economicLookup.cohortMedianCuPerBlock,
        },
      },
    },
  };
}

/**
 * The `tenure` + `client` blocks of the `/badges` response — the
 * part of `/badges` that ISN'T the tier (the badges tier is just a
 * summary of the full `/tier` object, which `/scoring` already
 * carries at top level, so `/scoring` reuses ONLY this helper for
 * the tenure/client halves and skips the badges tier summary
 * entirely — no duplication).
 *
 * Pure: takes the already-fetched validator + current epoch so the
 * caller owns the DB reads (badges + scoring fetch the current
 * epoch alongside their other concurrent work).
 */
export function tenureClientBlocks(
  validator: Validator,
  currentEpoch: EpochInfo | null,
): Pick<BadgesResponse, 'tenure' | 'client'> {
  const tenure = summariseTenure(
    validator.firstSeenEpoch,
    currentEpoch !== null ? currentEpoch.epoch : validator.lastSeenEpoch,
    validator.genesisEpoch,
  );
  // Re-narrow the stored client kind to the documented enum at the
  // public boundary. The DB column is intentionally wide so a
  // future-extended classifier writes without a migration, but the
  // OpenAPI contract is the closed enum — any other value would
  // break strictly-typed SDK consumers.
  const clientKind = narrowToDocumentedKind(validator.clientKind);
  return {
    tenure: {
      firstSeenEpoch: tenure.firstSeenEpoch,
      activeEpochs: tenure.activeEpochs,
      landmark: tenure.landmark,
      badge: tenure.badge,
    },
    client: {
      kind: clientKind,
      version: validator.clientVersion,
      updatedAt: validator.clientUpdatedAt?.toISOString() ?? null,
    },
  };
}

const validatorsRoutes: FastifyPluginAsync<ValidatorsRoutesDeps> = async (
  app: FastifyInstance,
  opts: ValidatorsRoutesDeps,
) => {
  const { statsRepo, validatorsRepo, epochsRepo, profilesRepo, claimsRepo, tierSnapshotsRepo } =
    opts;
  const serialCtx = {};

  app.get('/v1/validators/search', async (request, _reply): Promise<ValidatorSearchResponse> => {
    const query = unwrap(SearchQuerySchema.safeParse(request.query), 'query parameter');
    const optedOutVotes = await profilesRepo.findOptedOutVotes();
    const rows = await validatorsRepo.searchByText(query.q, query.limit, optedOutVotes);
    const claimedVotes =
      claimsRepo === undefined || rows.length === 0
        ? new Set<string>()
        : await claimsRepo.findClaimedVotes(rows.map((r) => r.votePubkey));

    return {
      query: query.q,
      limit: query.limit,
      count: rows.length,
      items: rows.map((row) => ({
        vote: row.votePubkey,
        identity: row.identityPubkey,
        name: row.name,
        iconUrl: normaliseHttpUrlOrNull(row.iconUrl),
        website: normaliseHttpUrlOrNull(row.website),
        claimed: claimedVotes.has(row.votePubkey),
      })),
    };
  });

  /**
   * GET /v1/validators/:idOrVote/current-epoch
   *
   * Status codes:
   *   - 200 — validator is known; body always describes the current epoch.
   *           A stored row sets `hasSlots`/`hasIncome`; absence of a row
   *           produces a placeholder with null numerics.
   *   - 400 — pubkey validation fails.
   *   - 404 — pubkey is unknown to the indexer.
   *   - 503 `not_ready` — cold start; the epoch watcher hasn't recorded a
   *           row yet.
   */
  app.get(
    '/v1/validators/:idOrVote/current-epoch',
    async (request, _reply): Promise<ValidatorCurrentEpochResponse> => {
      const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameter');

      const current = await epochsRepo.findCurrent();
      if (current === null) {
        throw new AppError(
          'not_ready',
          'indexer has not observed a current epoch yet; retry shortly',
          503,
        );
      }

      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      const vote = validator.votePubkey;
      const optedOutVotes = await profilesRepo.findOptedOutVotes();
      if (optedOutVotes.has(vote)) {
        throw new NotFoundError('validator', params.idOrVote);
      }
      const stats = await statsRepo.findByVoteEpoch(vote, current.epoch);
      if (stats !== null) {
        return serializeValidator(stats, current, serialCtx);
      }
      return serializeValidatorPlaceholder({
        vote,
        identity: validator.identityPubkey,
        epoch: current.epoch,
        ctx: serialCtx,
        isCurrentEpoch: !current.isClosed,
        isFinal: current.isClosed,
      });
    },
  );

  /**
   * POST /v1/validators/current-epoch/batch
   *
   * `results` contains one record per vote that is KNOWN to the indexer.
   * Rows with no stats for the current epoch are returned as placeholders
   * with null numerics, NOT in `missing`.
   * `missing` only contains votes the indexer has never seen at all.
   */
  app.post(
    '/v1/validators/current-epoch/batch',
    async (request, _reply): Promise<BatchResponse> => {
      const body = unwrap(BatchBodySchema.safeParse(request.body), 'request body');

      const current = await epochsRepo.findCurrent();
      if (current === null) {
        throw new AppError(
          'not_ready',
          'indexer has not observed a current epoch yet; retry shortly',
          503,
        );
      }

      const knownValidators = await validatorsRepo.findManyByVotes(body.votes);
      const validatorByVote = new Map(knownValidators.map((v) => [v.votePubkey, v]));
      const optedOutVotes = await profilesRepo.findOptedOutVotes();

      const statsRows = await statsRepo.findManyByVotesCurrentEpoch(body.votes, current.epoch);
      const statsByVote = new Map(statsRows.map((r) => [r.votePubkey, r]));

      const results: ValidatorCurrentEpochResponse[] = [];
      const missing: string[] = [];
      for (const vote of body.votes) {
        const validator = validatorByVote.get(vote);
        if (!validator) {
          missing.push(vote);
          continue;
        }
        if (optedOutVotes.has(vote)) {
          missing.push(vote);
          continue;
        }
        const row = statsByVote.get(vote);
        if (row) {
          results.push(serializeValidator(row, current, serialCtx));
        } else {
          results.push(
            serializeValidatorPlaceholder({
              vote,
              identity: validator.identityPubkey,
              epoch: current.epoch,
              ctx: serialCtx,
              isCurrentEpoch: !current.isClosed,
              isFinal: current.isClosed,
            }),
          );
        }
      }

      return { epoch: current.epoch, results, missing };
    },
  );

  /**
   * GET /v1/validators/:idOrVote/epochs/:epoch
   *
   * Historical lookup. 404 only when the pubkey itself is unknown; absence of
   * a stats row at the requested epoch yields a 200 placeholder with null
   * numerics and `hasSlots=false` / `hasIncome=false`.
   */
  app.get(
    '/v1/validators/:idOrVote/epochs/:epoch',
    async (request, _reply): Promise<ValidatorCurrentEpochResponse> => {
      const params = unwrap(
        VoteOrIdentityAndEpochParamSchema.safeParse(request.params),
        'path parameters',
      );

      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      const vote = validator.votePubkey;
      const optedOutVotes = await profilesRepo.findOptedOutVotes();
      if (optedOutVotes.has(vote)) {
        throw new NotFoundError('validator', params.idOrVote);
      }
      const [stats, epochRow] = await Promise.all([
        statsRepo.findByVoteEpoch(vote, params.epoch),
        epochsRepo.findByEpoch(params.epoch),
      ]);
      const epochInfo = epochInfoOrShim(epochRow, params.epoch);

      if (stats !== null) {
        return serializeValidator(stats, epochInfo, serialCtx);
      }
      return serializeValidatorPlaceholder({
        vote,
        identity: validator.identityPubkey,
        epoch: params.epoch,
        ctx: serialCtx,
        isCurrentEpoch: !epochInfo.isClosed,
        isFinal: epochInfo.isClosed,
      });
    },
  );

  /**
   * GET /v1/validators/:idOrVote/tier
   *
   * Returns the validator's Node Tier (forge / anvil / hearth /
   * kindling / unrated) derived from the most recent 10 CLOSED
   * epochs — the running epoch is skipped because its slot/income
   * counters grow during the response cache window and would make
   * a tier ride the running-epoch values.
   *
   * P1 composite: `0.3 × reliability + 0.7 × economicScore`, where
   * `economicScore = 0.9 × economicPercentile + 0.1 × cuSubscore`.
   * `reliability` = `1 − wilsonInterval(slotsSkipped, slotsAssigned).upper`
   * (pessimistic block-production rate). `economicPercentile` =
   * `PERCENT_RANK()` of this validator's median per-leader-slot
   * income across the window, against the indexed-validator cohort.
   * Vote credits are deliberately excluded — see `docs/scoring.md`
   * Phase 1, "Why no vote credits."
   *
   * Confidence floors → `tier: "unrated"`: `slotsAssigned < 10`,
   * cohort size < 10, this validator measured in < 10 closed epochs,
   * or `economicPercentile === null`.
   *
   * Reliability floor: when `skip_rate > 0.20` the tier is hard-
   * capped at `kindling` regardless of economic percentile.
   */
  // Return type is `NodeTierResponse | void`: the GET path resolves
  // the structured body, the HEAD short-circuit calls `reply.send('')`
  // and resolves `void` — the union keeps the HEAD path honest with
  // no `as unknown as NodeTierResponse` cast (mirrors /badges).
  app.get(
    '/v1/validators/:idOrVote/tier',
    async (request, reply): Promise<NodeTierResponse | void> => {
      const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameters');
      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }
      // HEAD short-circuit AFTER the existence check (so HEAD still
      // returns the right 404 for unknown pubkeys) but BEFORE the
      // history read + tier computation a HEAD response would throw
      // away. The handler resolves `void` here — the
      // `Promise<NodeTierResponse | void>` return type makes that
      // honest without an `as unknown as NodeTierResponse` cast.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', cacheControl('SCORING')).send('');
        return;
      }
      // History fetch + closed-epoch windowing + composite — shared
      // with /badges via `resolveTierForValidator`, and the body
      // assembly itself (window numerics + oldest-credit reduce)
      // shared with /scoring via `tierBodyFromResolved`, so neither
      // the window logic nor the response shape can drift. The tier
      // snapshot read (for the trend block) is independent given the
      // resolved vote, so run it concurrently.
      const [resolved, latestTwoSnapshots] = await Promise.all([
        resolveTierForValidator(statsRepo, epochsRepo, validator.votePubkey),
        tierSnapshotsRepo?.findLatestTwo(validator.votePubkey) ?? Promise.resolve([]),
      ]);

      const body = tierBodyFromResolved(resolved, validator);
      // Layer the trend block onto the pure body. `findLatestTwo`
      // returns the two newest snapshots; we compare the live composite
      // against the most recent PRIOR snapshot. < 1 snapshot → null.
      const trend = trendFromSnapshots(
        body.composite,
        latestTwoSnapshots,
        latestTwoSnapshots.length,
      );

      // SCORING tier — tier is derived purely from CLOSED-epoch rows,
      // so it only moves on an epoch boundary (~2 days); a few minutes
      // of client staleness is harmless. Shared with /badges (same
      // closed-epoch-derived data) and the OAI route via the named
      // tier in src/api/cache-control.ts — the previous hand-rolled
      // constants drifted (tier said s-maxage 3600, badges said 1800
      // for the same data class).
      void reply.header('cache-control', cacheControl('SCORING'));
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        ...body,
        trend,
      };
    },
  );

  /**
   * GET /v1/validators/:idOrVote/tier/history?limit=N
   *
   * Newest-first list of the validator's persisted Node Tier snapshots
   * (migration 0045) — one row per CLOSED epoch the snapshot ingester
   * recorded. Backs the profile "tier over time" view. `limit` defaults
   * to 16 (≈ a month of epochs) and is capped at 60.
   *
   * FORWARD-ONLY: snapshots accumulate from the ingester's first run,
   * so a validator added recently (or a fresh DB) returns a short or
   * empty list rather than a backfilled history. Returns an empty
   * `snapshots` array when the snapshot repo isn't wired.
   *
   * Status codes mirror `/tier`: 400 invalid pubkey, 404 unknown
   * pubkey, 200 otherwise (even with zero snapshots).
   */
  app.get(
    '/v1/validators/:idOrVote/tier/history',
    async (request, reply): Promise<TierHistoryResponse> => {
      const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameters');
      const query = unwrap(TierHistoryQuerySchema.safeParse(request.query), 'query parameter');
      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      const snapshots =
        tierSnapshotsRepo === undefined
          ? []
          : await tierSnapshotsRepo.findByVote(validator.votePubkey, query.limit);

      // Same closed-epoch-derived data class as /tier — snapshots only
      // change on an epoch boundary, so the SCORING cache horizon is
      // safe here too.
      void reply.header('cache-control', cacheControl('SCORING'));
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        snapshots: snapshots.map((s) => ({
          epoch: s.epoch,
          composite: s.composite,
          tier: s.tier,
          reliability: s.reliability,
          economicPercentile: s.economicPercentile,
          cuPercentile: s.cuPercentile,
        })),
      };
    },
  );

  /**
   * GET /v1/validators/:idOrVote/badges
   *
   * Composite profile-level badges. Combines:
   *   - Tenure (first_seen_epoch → landmark)
   *   - Client kind + version (from getClusterNodes ingestion)
   *   - Node Tier (same computation as /tier — included here so UI
   *     can render the full badge row in a single round-trip)
   *
   * Cached briefly so a hot profile page doesn't N+1 the DB on every
   * visitor — but not so long that a fresh claim / client upgrade
   * stalls invisibly.
   */
  // Return type is `BadgesResponse | void`: the GET path resolves the
  // structured body, the HEAD short-circuit calls `reply.send('')` and
  // resolves `void`. Declaring the union keeps the HEAD path honest —
  // no `as unknown as BadgesResponse` cast claiming an empty string is
  // a typed object.
  app.get(
    '/v1/validators/:idOrVote/badges',
    async (request, reply): Promise<BadgesResponse | void> => {
      const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameters');
      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      // /badges also needs the current epoch for the tenure summary,
      // so fetch it alongside the shared tier resolution. The tier's
      // own closed-epoch windowing lives in `resolveTierForValidator`;
      // the tenure/client assembly lives in `tenureClientBlocks`
      // (shared with /scoring) so those blocks can't drift either.
      const [{ result: tierResult, closedRows }, currentEpoch] = await Promise.all([
        resolveTierForValidator(statsRepo, epochsRepo, validator.votePubkey),
        epochsRepo.findCurrent(),
      ]);

      // HEAD short-circuit: after the existence check the route is
      // semantically valid, so return headers without paying the
      // serialisation cost a HEAD response will throw away. The
      // handler resolves `void` here (the reply is already sent) —
      // the `Promise<BadgesResponse | void>` return type makes that
      // honest without an `as unknown as BadgesResponse` cast.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', cacheControl('SCORING')).send('');
        return;
      }

      // SCORING tier — tenure + client + tier are all closed-epoch-
      // derived; see src/api/cache-control.ts. Shared with /tier so the
      // two routes serving the same data class can no longer drift.
      void reply.header('cache-control', cacheControl('SCORING'));
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        ...tenureClientBlocks(validator, currentEpoch),
        // The badges `tier` is a SUMMARY of the full /tier object
        // (just tier + composite + windowEpochs). /scoring carries
        // the FULL /tier object instead, so it deliberately does
        // NOT reuse this summary — see scoring.route.ts.
        tier: {
          tier: tierResult.tier,
          composite: tierResult.composite,
          windowEpochs: closedRows.length,
        },
      };
    },
  );
};

export interface BadgesResponse {
  vote: string;
  identity: string;
  tenure: {
    firstSeenEpoch: number;
    activeEpochs: number;
    landmark: string;
    badge: string;
  };
  client: {
    /** Classifier output: agave / jito_solana / firedancer / frankendancer / paladin / sig / unknown. */
    kind: string;
    /** Raw gossip-advertised version string, or null when never observed. */
    version: string | null;
    updatedAt: string | null;
  };
  tier: {
    tier: NodeTier;
    composite: number | null;
    windowEpochs: number;
  };
}

export interface NodeTierResponse {
  vote: string;
  identity: string;
  window: {
    epochs: number;
    slotsAssigned: number;
    slotsSkipped: number;
    /**
     * Size of the indexed-validator cohort the economic percentile
     * was computed against, in this window. Zero when no cohort
     * could be assembled (e.g. fresh DB with no income data yet).
     */
    economicCohortSize: number;
    /**
     * How many closed epochs in the window had measurable income
     * for THIS validator. Below
     * `MIN_MEASURED_EPOCHS_FOR_ECONOMIC` (the full window by
     * default) the percentile is treated as null and the tier
     * falls to `unrated`.
     */
    economicMeasuredEpochs: number;
    /**
     * This validator's median income per leader slot across the
     * window, in lamports as a decimal-precision string. `null`
     * when no measurable income data exists for this validator in
     * the window. Stringified for the same reason income totals
     * are: lamport-scale numbers exceed JSON safe-integer range.
     */
    economicMedianLamportsPerSlot: string | null;
    /**
     * ISO-8601 timestamp of the OLDEST income-row update across
     * the window's closed epochs. `null` when no row in the window
     * has BOTH fees and tips ingested. Lets a UI grey out the tier
     * when the income ingester has stalled, without polling a
     * separate health surface.
     */
    incomeFreshness: string | null;
    /**
     * Validator's activated stake (lamports, decimal-precision
     * string) as of the most recent closed epoch in the window.
     * `null` for windows that span only pre-stake-snapshot epochs
     * (migration 0006 is forward-only — no historical backfill of
     * `getVoteAccounts`). Surfaced so a delegator hub can show
     * stake alongside the score without a second API call.
     */
    activatedStakeLamports: string | null;
    /**
     * Total vote credits earned across the closed-epoch window
     * (decimal-precision string). Each row is per-epoch credits;
     * summed gives the window's vote-landing productivity. Reads
     * 0 when none of the rows have credit data ingested.
     */
    voteCreditsTotal: string;
    /**
     * On-chain vote-account commission as an integer 0-100. Sourced
     * from `getVoteAccounts.commission` and persisted by
     * `ValidatorService.refreshFromRpc` (see migration 0044).
     * **NOTE**: WhoEarns frames operator-side income as commission-
     * NEUTRAL (see `docs/scoring.md` Phase 1 + the income FAQ);
     * delegator-yield math that USES commission is the consumer's
     * responsibility, not WhoEarns's. The field is exposed so a
     * delegator-facing surface can do the multiplication itself.
     * `null` for legacy rows the refresh tick hasn't covered yet.
     */
    commission: number | null;
    /**
     * Jito MEV commission in basis points (0-10000; 500 = 5%) — the
     * share the validator keeps from MEV tips before passing the rest
     * to delegators. Complements `commission` (which only governs
     * inflation/staking yield): a surface showing one without the
     * other tells a delegator only half the take-rate story. Sourced
     * from stakewiz (migration 0046). `null` when the validator isn't
     * a Jito participant or the row predates the column — gate display
     * on `runsJito`, never render `null` as 0%. A displayed FACT only,
     * never an input to the tier (commission-neutral by design).
     */
    mevCommissionBps: number | null;
    /**
     * Whether the validator participates in Jito MEV tip distribution.
     * Distinguishes "0% MEV commission" (`runsJito: true`, shares all
     * tips) from "no MEV commission" (`runsJito: false`, doesn't run
     * Jito). `null` for rows the stakewiz ingester hasn't covered yet.
     */
    runsJito: boolean | null;
    /**
     * Closed-epoch window bounds the percentile cohort was evaluated
     * over (`fromEpoch` = oldest closed epoch in the window,
     * `toEpoch` = newest). `null` when the window has zero closed
     * rows (and the tier is `unrated`). Lets a consumer cross-
     * reference the response with the leaderboard's current epoch to
     * detect drift between a CDN-cached tier and a fresh leaderboard.
     */
    cohortAsOfEpoch: CohortAsOfEpoch | null;
  };
  tier: NodeTier;
  /**
   * 0-100 composite. **`null` when `tier === 'unrated'`** so a UI
   * cannot accidentally display "composite: 87" alongside an
   * unrated classification.
   */
  composite: number | null;
  /**
   * Epoch-over-epoch tier MOVEMENT (migration 0045), sourced from the
   * persisted `tier_snapshots` history. `null` when fewer than one
   * prior snapshot exists (a fresh validator, or before the snapshot
   * ingester has recorded a closed epoch) OR when the snapshot repo
   * isn't wired — a UI shows nothing in that case rather than a
   * spurious "no change". When present, `delta` is the live composite
   * minus the previous snapshot's composite (positive = improved);
   * `prevTier` lets the UI describe a tier-name change even when
   * `delta` is null (an `unrated` endpoint can't move by a number).
   */
  trend: TierTrend | null;
  components: {
    /**
     * Reliability sub-component: pessimistic block-production rate
     * derived from Wilson 95% upper bound on skip rate, plus the raw
     * inputs that produced it.
     */
    reliability: {
      /**
       * 0-1, pessimistic block-production reliability — equals
       * `1 − Wilson(skipped, assigned).upper`. Always populated
       * (never null) because we always have slot counters; small-
       * sample validators get a sub-1.0 value rather than an
       * inflated 1.0.
       */
      score: number;
      evidence: {
        /** Wilson 95% UPPER bound on the window's skip rate. */
        wilsonSkipRateUpper: number;
        /** Wilson 95% LOWER bound on the window's skip rate. */
        wilsonSkipRateLower: number;
        /**
         * Hard skip-rate floor (Wilson upper bound) above which the
         * tier is capped at `kindling`. Exposed alongside the bound
         * itself so a consumer can describe the cap geometry without
         * importing the constant.
         */
        skipRateFloor: number;
        /**
         * True when `wilsonSkipRateUpper > skipRateFloor` — the
         * tier was capped at `kindling` by the reliability floor.
         */
        floorEngaged: boolean;
        /**
         * Per-closed-epoch leader slot counters that fed the Wilson
         * computation, newest epoch first (matching the
         * `findHistoryByVote` order). One entry per row in the tier
         * window; empty when the window has no closed rows.
         */
        perEpoch: Array<{
          epoch: number;
          slotsAssigned: number;
          slotsSkipped: number;
        }>;
      };
    };
    /**
     * Economic-percentile sub-component: cohort rank of median per-
     * leader-slot income plus the cohort distribution context the
     * rank was drawn from.
     */
    economicPercentile: {
      /**
       * 0-1, percentile rank of this validator's median income per
       * leader slot vs the indexed cohort. **`null`** when the
       * cohort is too small or this validator had too few measured
       * epochs — and in that case `tier === 'unrated'`.
       */
      score: number | null;
      evidence: {
        /**
         * Target validator's median income per slot, lamports as a
         * decimal-precision string. `null` when the validator has no
         * measurable income in the window. Mirrors
         * `window.economicMedianLamportsPerSlot` for per-component
         * readability.
         */
        validatorMedianLamportsPerSlot: string | null;
        /**
         * Cohort median of per-validator median per-slot income,
         * lamports as a decimal-precision string. `null` when the
         * cohort is empty.
         */
        cohortMedianLamportsPerSlot: string | null;
        /**
         * Cohort 25th percentile of per-validator median per-slot
         * income, lamports as a decimal-precision string. `null`
         * when the cohort is empty.
         */
        cohortP25LamportsPerSlot: string | null;
        /**
         * Cohort 75th percentile of per-validator median per-slot
         * income, lamports as a decimal-precision string. `null`
         * when the cohort is empty.
         */
        cohortP75LamportsPerSlot: string | null;
        /**
         * Derived rank inside the cohort. `position` is
         * `Math.round((1 - percentile) × (cohortSize - 1)) + 1` —
         * top-of-cohort = 1, bottom = `of`. `null` when `score` is
         * null OR `cohortSize <= 1` (rank is undefined).
         */
        rank: { position: number; of: number } | null;
        /**
         * Per-closed-epoch per-leader-slot income (lamports as a
         * decimal-precision string) for this validator, newest
         * epoch first. `null` for epochs with no measurable income
         * (no leader slots, or a partial-ingest row). One entry per
         * row in the tier window.
         */
        perEpoch: Array<{ epoch: number; lamportsPerSlot: string | null }>;
        /**
         * Window-total income decomposition for the target validator
         * across all closed-epoch rows in the tier window. Each
         * field is a lamports decimal-precision string summed from
         * the per-epoch facts. `priorityFeesLamports` AND
         * `baseFeesLamports` come from the four-way income
         * decomposition (migration 0010); pre-migration epochs read
         * `0` from the `NOT NULL DEFAULT 0` column.
         */
        incomeBreakdown: {
          baseFeesLamports: string;
          priorityFeesLamports: string;
          jitoTipsLamports: string;
        };
        /**
         * Cohort disclosure: the vote pubkeys of the cohort this
         * validator's economic percentile was ranked against in the
         * window — exactly the validators with measured income in the
         * same closed-epoch window (the same population
         * `findEconomicPercentile`'s `PERCENT_RANK()` ran over). Makes
         * the percentile independently reproducible: pull each member's
         * income and re-derive the rank. Bounded by the indexed set
         * (~19-200). Empty when the window had no closed rows.
         * Descriptive only.
         */
        cohortVotes: string[];
      };
    };
    /**
     * CU-percentile sub-component: cohort rank of windowed average
     * compute units per produced block plus the absolute averages
     * that drove the rank.
     */
    cuPercentile: {
      /**
       * 0-1, percentile rank of this validator's produced-block-count-
       * weighted compute units per produced block, over the same window
       * and indexed cohort as `economicPercentile` but ranked only
       * among the cohort's block-producing validators. **`null`** when
       * the validator produced no blocks in the window. Contributes 10% of the
       * composite's economic component
       * (`0.9 × economicPercentile + 0.1 × cuSubscore`); a `null` here
       * means a CU subscore of 0.
       */
      score: number | null;
      evidence: {
        /**
         * Target validator's produced-block-count-weighted average
         * compute units per produced block across the window.
         * `null` when the validator produced no blocks.
         */
        validatorAvgCuPerBlock: number | null;
        /**
         * Cohort median of per-validator avg CU per produced block.
         * `null` when no cohort validator produced any blocks.
         */
        cohortMedianCuPerBlock: number | null;
      };
    };
  };
}

/**
 * `GET /v1/validators/:idOrVote/tier/history` response. Newest-first
 * list of persisted tier snapshots (migration 0045) — each entry is the
 * tier composite + component sub-scores as they stood when the snapshot
 * ingester recorded that closed epoch. `snapshots` is empty for a
 * validator with no recorded history (recently added, fresh DB, or the
 * snapshot repo unwired).
 */
export interface TierHistoryResponse {
  vote: string;
  identity: string;
  snapshots: Array<{
    epoch: number;
    /** 0-100, or `null` when the tier was `unrated` at that epoch. */
    composite: number | null;
    /** Tier label at that epoch (forge / anvil / hearth / kindling / unrated). */
    tier: string;
    /** Reliability sub-score (0..1) at snapshot time, or `null`. */
    reliability: number | null;
    /** Economic-percentile sub-score (0..1) at snapshot time, or `null`. */
    economicPercentile: number | null;
    /** CU-percentile sub-score (0..1) at snapshot time, or `null`. */
    cuPercentile: number | null;
  }>;
}

export default validatorsRoutes;
