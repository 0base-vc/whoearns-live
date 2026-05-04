import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { lamportsToSol, lamportsToString } from '../../core/lamports.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { normaliseHttpUrlOrNull } from '../../core/url.js';
import type { AggregatesRepository } from '../../storage/repositories/aggregates.repo.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { LeaderboardSort, StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { Epoch, EpochValidatorStats, IdentityPubkey } from '../../types/domain.js';

/**
 * Cluster top-N leaderboard — ranked validators for a given closed
 * epoch, by total leader income (block fees + on-chain Jito tips).
 *
 * Used by the homepage to replace the old "search your validator"
 * single-shot flow with a populated landscape view. Same data path as
 * `/v1/validators/:idOrVote/current-epoch` but aggregated into one row
 * per validator across the cluster instead of per-validator per-epoch.
 *
 * Two important constraints:
 *
 *   1. Ranks against the MOST RECENT CLOSED EPOCH. Ranking during a
 *      running epoch is meaningless because every leader is still
 *      accumulating income. The route looks up `findLatestClosed` and
 *      uses that as the default; callers can force an epoch via
 *      `?epoch=N`.
 *
 *   2. Only returns rows where `fees_updated_at IS NOT NULL`. The
 *      watched validator set might be a strict subset of the cluster
 *      (e.g. `top:100`) — we don't pad the response with placeholder
 *      rows for validators we haven't ingested yet.
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * API-surface sort values mirror the repo enum 1:1. Zod enum gives us
 * server-side validation + a 400 with a helpful message if the client
 * passes `sort=bogus`. Default is `performance` (income per assigned
 * slot) — the stake-neutral + commission-neutral skill metric. See
 * the `LeaderboardSort` comment in stats.repo.ts for the full
 * derivation.
 */
const SortEnumSchema = z.enum([
  'performance',
  'total_income',
  'income_per_stake',
  'skip_rate',
  'median_fee',
]);

const LeaderboardQuerySchema = z.object({
  epoch: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
  sort: SortEnumSchema.default('performance'),
});

export interface LeaderboardRoutesDeps {
  statsRepo: Pick<StatsRepository, 'findTopNByEpoch'>;
  epochsRepo: Pick<EpochsRepository, 'findLatestClosed' | 'findByEpoch'>;
  aggregatesRepo: Pick<AggregatesRepository, 'findByEpochTopN'>;
  /**
   * Validator metadata lookup (name / icon / website). Optional — the
   * route degrades gracefully when the repo is omitted, returning null
   * for all info fields. Keeping it optional means test harnesses and
   * legacy callers don't need to wire it just to exercise the ranking
   * logic.
   */
  validatorsRepo?: Pick<ValidatorsRepository, 'getInfosByIdentities'>;
  /**
   * Phase 3 profile decoration. Used ONLY to exclude validators that
   * have opted out (`opted_out = TRUE`) from the leaderboard —
   * twitter / hideFooter etc. are not relevant to a cluster
   * ranking. Optional for the same reason as `validatorsRepo`:
   * a test can stub without wiring the full profile layer.
   */
  profilesRepo?: Pick<ProfilesRepository, 'findOptedOutVotes'>;
  /**
   * Phase 3 claim lookup. Used to mark each row with a `claimed:
   * boolean` flag — the UI renders a small "verified" badge next
   * to claimed validators so visitors can see operator-attested
   * legitimacy at a glance. Optional, same reason as the others.
   */
  claimsRepo?: Pick<ClaimsRepository, 'findClaimedVotes'>;
}

interface LeaderboardRow {
  rank: number;
  vote: string;
  identity: string;
  /**
   * On-chain validator moniker — from `solana validator-info publish`.
   * Null when the validator hasn't published an info record, or
   * when the info-refresh job hasn't seen it yet.
   */
  name: string | null;
  iconUrl: string | null;
  website: string | null;
  slotsAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  skipRate: number | null;
  blockFeesTotalLamports: string;
  blockFeesTotalSol: string;
  blockTipsTotalLamports: string;
  blockTipsTotalSol: string;
  /**
   * `blockFees + blockTips` in lamports. This is the rank key — surfacing
   * it on the row saves clients from re-computing it for display.
   */
  totalIncomeLamports: string;
  totalIncomeSol: string;
  /**
   * Performance — `(block_fees + block_tips) / slots_assigned` in lamports
   * per assigned slot. Stake-neutral and commission-neutral; captures
   * operational skill (block quality + Jito-tip capture + reliability) in
   * a single number. `null` when `slots_assigned === 0` (placeholder
   * rows) — shouldn't normally hit this path on the
   * leaderboard since rows without fees are filtered out, but kept
   * nullable for safety.
   */
  performanceLamportsPerSlot: string | null;
  performanceSolPerSlot: string | null;
  /** Per-validator median block fee (lamports + SOL). Null when the
   * ingester hasn't recorded any produced blocks yet. */
  medianFeeLamports: string | null;
  medianFeeSol: string | null;
  /** Activated stake snapshot at the time of the last slot-ingest
   * tick. Null for rows written before migration 0006 ran. */
  activatedStakeLamports: string | null;
  activatedStakeSol: string | null;
  /**
   * APR-equivalent (`total_income / activated_stake`), returned as a
   * floating point ratio (e.g. 0.000042 = 0.0042% per epoch). Null
   * when stake data is missing. Surfaced on the row so clients don't
   * have to re-compute it for display / sorting.
   */
  incomePerStake: number | null;
  /**
   * Phase 3: `true` when the validator's operator has gone through
   * the Ed25519 claim flow at least once. Drives the UI's "verified"
   * badge — a small visual cue that the operator has self-attested
   * via signed message against their on-chain identity key.
   *
   * `false` for never-claimed validators (the vast majority on a
   * fresh launch). NOT a security guarantee on its own; the
   * meaningful signal is "this validator's operator interacted
   * with the explorer", which combined with the on-chain
   * `validator-info publish` data gives delegators a richer trust
   * picture than either source alone.
   */
  claimed: boolean;
}

interface LeaderboardResponse {
  epoch: number;
  epochClosedAt: string | null;
  /** Sort mode used. Echoed back so clients can render a selected-tab
   * state without having to track the request themselves. */
  sort: LeaderboardSort;
  /** Number of validators returned (may be less than `limit`). */
  count: number;
  /** `limit` the client asked for (post-clamp). */
  limit: number;
  items: LeaderboardRow[];
  /**
   * Top-N cluster aggregates for this epoch, when published. Clients
   * use it to render a "you're X% above/below median" badge next to
   * each row without doing the math on the client.
   */
  cluster: {
    topN: number;
    sampleValidators: number;
    medianBlockFeeLamports: string | null;
    medianBlockTipLamports: string | null;
  } | null;
}

function toRow(
  stats: EpochValidatorStats,
  rank: number,
  info: { name: string | null; iconUrl: string | null; website: string | null } | undefined,
  claimed: boolean,
): LeaderboardRow {
  const blockFees = stats.blockFeesTotalLamports;
  const blockTips = stats.blockTipsTotalLamports;
  const total = blockFees + blockTips;
  const skipRate = stats.slotsAssigned > 0 ? stats.slotsSkipped / stats.slotsAssigned : null;
  const stake = stats.activatedStakeLamports;
  // Use Number division for the ratio — total and stake fit well
  // inside IEEE 754 precision at the magnitudes we care about
  // (lamports per lamport = dimensionless, < 1 by many orders of
  // magnitude). If we ever need full-precision APR, switch to a
  // decimal library.
  const incomePerStake = stake !== null && stake > 0n ? Number(total) / Number(stake) : null;
  // Performance: lamports per assigned slot. bigint division (round
  // toward zero) is fine here — the magnitudes we care about (typical
  // lamports per slot range from hundreds of thousands to tens of
  // millions) are plenty above the truncation threshold, and the
  // client uses this for display/sort, not accounting.
  const performance = stats.slotsAssigned > 0 ? total / BigInt(stats.slotsAssigned) : null;
  return {
    rank,
    vote: stats.votePubkey,
    identity: stats.identityPubkey,
    name: info?.name ?? null,
    iconUrl: normaliseHttpUrlOrNull(info?.iconUrl),
    website: normaliseHttpUrlOrNull(info?.website),
    slotsAssigned: stats.slotsAssigned,
    slotsProduced: stats.slotsProduced,
    slotsSkipped: stats.slotsSkipped,
    skipRate,
    // `lamportsToString` is typed to accept null; non-null inputs
    // always produce non-null outputs, but TS can't see through the
    // overload-less signature. Convert the bigint directly via
    // `toString()` for the lamports fields; SOL formatting still uses
    // the helper because it handles digit padding + trailing zeros.
    blockFeesTotalLamports: blockFees.toString(),
    blockFeesTotalSol: lamportsToSol(blockFees),
    blockTipsTotalLamports: blockTips.toString(),
    blockTipsTotalSol: lamportsToSol(blockTips),
    totalIncomeLamports: total.toString(),
    totalIncomeSol: lamportsToSol(total),
    performanceLamportsPerSlot: performance === null ? null : performance.toString(),
    performanceSolPerSlot: performance === null ? null : lamportsToSol(performance),
    medianFeeLamports: stats.medianFeeLamports === null ? null : stats.medianFeeLamports.toString(),
    medianFeeSol: stats.medianFeeLamports === null ? null : lamportsToSol(stats.medianFeeLamports),
    activatedStakeLamports: stake === null ? null : stake.toString(),
    activatedStakeSol: stake === null ? null : lamportsToSol(stake),
    incomePerStake,
    claimed,
  };
}

function unwrap<T>(
  result: { success: true; data: T } | { success: false; error: unknown },
  context: string,
): T {
  if (result.success) return result.data;
  throw new ValidationError(`${context} failed validation`, {
    issues: (result.error as { issues?: unknown[] }).issues ?? [result.error],
  });
}

const leaderboardRoutes: FastifyPluginAsync<LeaderboardRoutesDeps> = async (
  app: FastifyInstance,
  opts: LeaderboardRoutesDeps,
) => {
  const { statsRepo, epochsRepo, aggregatesRepo, validatorsRepo, profilesRepo, claimsRepo } = opts;

  app.get('/v1/leaderboard', async (request, _reply): Promise<LeaderboardResponse> => {
    const query = unwrap(LeaderboardQuerySchema.safeParse(request.query), 'query parameter');

    // Resolve target epoch: explicit `?epoch=` beats the default.
    let targetEpoch: Epoch;
    let epochClosedAt: string | null = null;
    if (query.epoch !== undefined) {
      const epochInfo = await epochsRepo.findByEpoch(query.epoch);
      if (epochInfo === null) {
        throw new NotFoundError('epoch', String(query.epoch));
      }
      targetEpoch = epochInfo.epoch;
      epochClosedAt = epochInfo.closedAt?.toISOString() ?? null;
    } else {
      const latest = await epochsRepo.findLatestClosed();
      if (latest === null) {
        // No closed epoch observed yet — first-boot state. Return an
        // empty list rather than a 404 so the UI can render its own
        // "no data yet" empty state.
        return {
          epoch: 0,
          epochClosedAt: null,
          sort: query.sort,
          count: 0,
          limit: query.limit,
          items: [],
          cluster: null,
        };
      }
      targetEpoch = latest.epoch;
      epochClosedAt = latest.closedAt?.toISOString() ?? null;
    }

    // Pull the opt-out set in parallel with the main query. A
    // validator that has set `profile.optedOut = true` should not
    // appear in the cluster ranking (the operator has explicitly
    // asked us not to show them); we over-fetch from stats and
    // drop the hidden rows client-side. Over-fetching slightly
    // (by `limit × maxOptOutRate`) keeps the filter cheap without
    // a more complex query. In practice the opt-out rate is
    // vanishingly small — partial index on `idx_validator_profiles_opted_out`
    // keeps the set lookup O(count of opted-out rows).
    const [rows, clusterAgg, optedOutVotes] = await Promise.all([
      statsRepo.findTopNByEpoch(targetEpoch, query.limit, query.sort),
      aggregatesRepo.findByEpochTopN(targetEpoch, 100),
      profilesRepo === undefined
        ? Promise.resolve(new Set<string>())
        : profilesRepo.findOptedOutVotes(),
    ]);

    // Filter out opted-out validators AFTER the repo returned its
    // sorted list so the ranking stays stable — if we excluded
    // inside the SQL, borderline ranks would shift around opt-outs
    // which is confusing for return visitors.
    const visibleRows =
      optedOutVotes.size === 0 ? rows : rows.filter((r) => !optedOutVotes.has(r.votePubkey));

    // Batch-fetch validator monikers for the rows we're about to
    // return, keyed by identity. A single query even for the full
    // 500-row ceiling; cheaper than joining in the stats query
    // because info is served by a tiny table (~1-2k rows).
    let infoByIdentity = new Map<
      IdentityPubkey,
      { name: string | null; iconUrl: string | null; website: string | null }
    >();
    if (validatorsRepo !== undefined && visibleRows.length > 0) {
      const identities = Array.from(new Set(visibleRows.map((r) => r.identityPubkey)));
      infoByIdentity = await validatorsRepo.getInfosByIdentities(identities);
    }

    // Phase 3 — pull the set of claimed votes among the visible
    // rows. Single round-trip, scoped to the limited window we're
    // about to return. Skipped entirely when no `claimsRepo` is
    // wired (legacy harnesses) — every row gets `claimed: false`
    // by default in that case.
    let claimedVotes = new Set<string>();
    if (claimsRepo !== undefined && visibleRows.length > 0) {
      const votes = visibleRows.map((r) => r.votePubkey);
      claimedVotes = await claimsRepo.findClaimedVotes(votes);
    }

    const items = visibleRows.map((row, i) =>
      toRow(row, i + 1, infoByIdentity.get(row.identityPubkey), claimedVotes.has(row.votePubkey)),
    );
    const cluster: LeaderboardResponse['cluster'] = clusterAgg
      ? {
          topN: clusterAgg.topN,
          sampleValidators: clusterAgg.sampleValidators,
          medianBlockFeeLamports:
            clusterAgg.medianFeeLamports === null
              ? null
              : lamportsToString(clusterAgg.medianFeeLamports),
          medianBlockTipLamports:
            clusterAgg.medianTipLamports === null
              ? null
              : lamportsToString(clusterAgg.medianTipLamports),
        }
      : null;

    return {
      epoch: targetEpoch,
      epochClosedAt,
      sort: query.sort,
      count: items.length,
      limit: query.limit,
      items,
      cluster,
    };
  });
};

export default leaderboardRoutes;
