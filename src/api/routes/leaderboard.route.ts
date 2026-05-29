import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError, NotFoundError, ValidationError } from '../../core/errors.js';
import { LAMPORTS_PER_SOL, lamportsToSol, lamportsToString } from '../../core/lamports.js';
import { TtlCache } from '../../core/ttl-cache.js';
import { normaliseHttpUrlOrNull } from '../../core/url.js';
import { narrowToDocumentedKind } from '../../services/client-kind.js';
import type { AggregatesRepository } from '../../storage/repositories/aggregates.repo.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../../storage/repositories/processed-blocks.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type {
  LeaderboardWindow,
  LeaderboardWindowEpoch,
  LeaderboardWindowSort,
  StatsRepository,
  WindowedLeaderboardStats,
} from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { EpochInfo, IdentityPubkey } from '../../types/domain.js';
import { setClientReadCache } from '../cache-headers.js';
import { unwrap } from '../zod-helpers.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MIN_WINDOW_SLOTS = 4;
const LEADERBOARD_CACHE_TTL_MS = 10_000;
const LEADERBOARD_CACHE_MAX_ENTRIES = 256;
const DECADE_EPOCH_COUNT = 10;
const DECADE_RANK_LIMIT = 3;

/**
 * Bracket filter (operator-primary leaderboard) — narrows the
 * candidate set BEFORE ranking so a small operator can be "#1 among
 * small validators". Uses only data already present in the store; no
 * new ingest. Region brackets are deliberately absent (no geo data).
 */
const CLIENT_BRACKET_PREFIX = 'client:';
/** Activated-stake ceilings, in SOL, for the small-operator brackets. */
const STAKE_BRACKET_CEILING_SOL: Record<'stake_lt_100k' | 'stake_lt_500k', bigint> = {
  stake_lt_100k: 100_000n,
  stake_lt_500k: 500_000n,
};
/**
 * Newcomer window, in epochs. A validator is a "newcomer" when its
 * genesis-preferred tenure origin (`COALESCE(genesis_epoch,
 * first_seen_epoch)`, mirroring `summariseTenure`) is within this many
 * epochs of the current epoch — i.e. `activeEpochs <= 30`.
 */
const NEWCOMER_WINDOW_EPOCHS = 30;

const WindowEnumSchema = z.enum([
  'live_trend',
  'current_only',
  'stable_trend',
  'final_epoch',
  'decade_epoch',
]);

const SortEnumSchema = z.preprocess(
  (value) => {
    switch (value) {
      case 'performance':
      case 'income_per_stake':
        return 'income_per_slot';
      case 'median_fee':
        return 'fees';
      default:
        return value;
    }
  },
  z
    .enum(['income_per_slot', 'total_income', 'mev_tips', 'fees', 'skip_rate', 'compute_units'])
    .default('income_per_slot'),
);

/**
 * Bracket filter. Either one of the fixed tokens or a
 * `client:<kind>` form whose `<kind>` is one of the 14 documented,
 * non-`unknown` client kinds (validated via `narrowToDocumentedKind`
 * — its single source of truth is `client-kind.ts`'s documented set,
 * so no kind list is duplicated here). Any other value — including a
 * bare `client:`, `client:unknown`, or an unrecognised kind — fails
 * validation and surfaces as `validation_error`. Defaults to `all`
 * (no filter, the historical behaviour).
 */
const BracketSchema = z
  .string()
  .default('all')
  .refine(
    (value) => {
      if (value === 'all' || value === 'newcomer') return true;
      if (value === 'stake_lt_100k' || value === 'stake_lt_500k') return true;
      if (value.startsWith(CLIENT_BRACKET_PREFIX)) {
        const kind = value.slice(CLIENT_BRACKET_PREFIX.length);
        return kind !== 'unknown' && narrowToDocumentedKind(kind) === kind;
      }
      return false;
    },
    {
      message:
        "bracket must be 'all', 'stake_lt_100k', 'stake_lt_500k', 'newcomer', or 'client:<kind>' for a documented client kind",
    },
  );

const LeaderboardQuerySchema = z
  .object({
    epoch: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
    minWindowSlots: z.coerce.number().int().positive().max(500).default(DEFAULT_MIN_WINDOW_SLOTS),
    sort: SortEnumSchema,
    window: WindowEnumSchema.optional(),
    bracket: BracketSchema,
  })
  .transform((query) => ({
    ...query,
    window: query.window ?? (query.epoch === undefined ? 'live_trend' : 'final_epoch'),
  }));

export interface LeaderboardRoutesDeps {
  statsRepo: Pick<StatsRepository, 'findTopNByWindow'>;
  epochsRepo: Pick<
    EpochsRepository,
    'findCurrent' | 'findByEpoch' | 'findLatestClosedEpochs' | 'findLatestCompleteClosedEpochBlock'
  >;
  aggregatesRepo: Pick<AggregatesRepository, 'findByEpochTopN'>;
  /**
   * Compute-unit aggregator. Powers the per-row `windowedCu` field —
   * each validator's producedBlock-count-weighted average CU across
   * the active window's epoch set, resolved by per-epoch identity so
   * it stays correct across identity rotation. Derived from
   * `processed_blocks` joined to `epoch_validator_stats`; no new
   * ingestion path.
   */
  processedBlocksRepo: Pick<ProcessedBlocksRepository, 'getWindowedComputeUnitsByVote'>;
  validatorsRepo?: Pick<ValidatorsRepository, 'getInfosByIdentities' | 'findVotesForBracket'>;
  profilesRepo?: Pick<ProfilesRepository, 'findOptedOutVotes'>;
  claimsRepo?: Pick<ClaimsRepository, 'findClaimedVotes'>;
}

type SampleStatus = 'low' | 'medium' | 'normal';
type DecadeRank = 1 | 2 | 3;

interface DecadeBadge {
  epochStart: number;
  epochEnd: number;
  rank: DecadeRank;
}

interface LeaderboardRow {
  rank: number;
  vote: string;
  identity: string;
  name: string | null;
  iconUrl: string | null;
  website: string | null;
  slotsAssigned: number;
  slotsElapsedAssigned: number;
  slotsProduced: number;
  slotsSkipped: number;
  skipRate: number | null;
  blockFeesTotalLamports: string;
  blockFeesTotalSol: string;
  blockTipsTotalLamports: string;
  blockTipsTotalSol: string;
  totalIncomeLamports: string;
  totalIncomeSol: string;
  performanceLamportsPerSlot: string | null;
  performanceSolPerSlot: string | null;
  windowSlots: number;
  windowIncomeLamports: string;
  windowIncomeSol: string;
  incomeLamportsPerSlot: string | null;
  incomeSolPerSlot: string | null;
  currentElapsedAssignedSlots: number;
  currentIncomeLamports: string;
  currentIncomeSol: string;
  closedEpochsIncluded: number;
  sampleStatus: SampleStatus;
  slotWindowLastSlot: number | null;
  slotWindowUpdatedAt: string | null;
  lastUpdatedAt: string | null;
  activatedStakeLamports: string | null;
  activatedStakeSol: string | null;
  incomePerStake: number | null;
  claimed: boolean;
  decadeEpochStart: number | null;
  decadeEpochEnd: number | null;
  decadeRank: DecadeRank | null;
  /**
   * Average compute units per produced block for the active window,
   * stringified. Single-epoch windows (`current_only`, `final_epoch`)
   * expose that epoch's average; multi-epoch windows (`live_trend`,
   * `stable_trend`, `decade_epoch`) expose the producedBlock-count-
   * weighted average across the window. `null` when the validator
   * produced no blocks in the window. Additive — Phase: compute-unit
   * exposure.
   */
  windowedCu: string | null;
}

interface LeaderboardResponse {
  epoch: number;
  epochClosedAt: string | null;
  window: LeaderboardWindow;
  sort: LeaderboardWindowSort;
  isFinal: boolean;
  currentEpoch: number | null;
  closedEpochsIncluded: number[];
  asOfSlot: number | null;
  safeUpperSlot: number | null;
  slotDenominator: 'window_slots';
  samplePolicy: {
    minWindowSlots: number;
    lowBelow: number;
    mediumBelow: number;
  };
  count: number;
  /**
   * Echo of the applied bracket filter. `all` when unfiltered;
   * otherwise the normalised bracket token (e.g. `stake_lt_100k`,
   * `newcomer`, `client:firedancer`). Additive — operator-primary
   * bracket leaderboard.
   */
  bracket: string;
  /**
   * Number of validators in this bracket with rankable data in the
   * active window — i.e. the size of the bracket-relative candidate
   * pool the ranking drew from, independent of `limit` (bounded by
   * the repo's internal 500-row ceiling). For `bracket=all` this
   * equals `count` (no over-fetch is performed on the default path).
   * Lets the UI render "N validators in this bracket".
   */
  bracketCount: number;
  limit: number;
  items: LeaderboardRow[];
  cluster: {
    topN: number;
    sampleValidators: number;
    medianBlockFeeLamports: string | null;
    medianBlockTipLamports: string | null;
  } | null;
}

function sampleStatus(slots: number): SampleStatus {
  if (slots < 16) return 'low';
  if (slots < 64) return 'medium';
  return 'normal';
}

function toRow(
  stats: WindowedLeaderboardStats,
  rank: number,
  info: { name: string | null; iconUrl: string | null; website: string | null } | undefined,
  claimed: boolean,
  decadeBadge: DecadeBadge | undefined,
  windowedCu: bigint | null,
): LeaderboardRow {
  const total = stats.blockFeesTotalLamports + stats.blockTipsTotalLamports;
  const perSlot = stats.windowSlots > 0 ? total / BigInt(stats.windowSlots) : null;
  const skipRate = stats.windowSlots > 0 ? stats.slotsSkipped / stats.windowSlots : null;
  const stake = stats.activatedStakeLamports;
  const incomePerStake = stake !== null && stake > 0n ? Number(total) / Number(stake) : null;

  return {
    rank,
    vote: stats.votePubkey,
    identity: stats.identityPubkey,
    name: info?.name ?? null,
    iconUrl: normaliseHttpUrlOrNull(info?.iconUrl),
    website: normaliseHttpUrlOrNull(info?.website),
    slotsAssigned: stats.slotsAssigned,
    slotsElapsedAssigned: stats.slotsElapsedAssigned,
    slotsProduced: stats.slotsProduced,
    slotsSkipped: stats.slotsSkipped,
    skipRate,
    blockFeesTotalLamports: stats.blockFeesTotalLamports.toString(),
    blockFeesTotalSol: lamportsToSol(stats.blockFeesTotalLamports),
    blockTipsTotalLamports: stats.blockTipsTotalLamports.toString(),
    blockTipsTotalSol: lamportsToSol(stats.blockTipsTotalLamports),
    totalIncomeLamports: total.toString(),
    totalIncomeSol: lamportsToSol(total),
    performanceLamportsPerSlot: perSlot === null ? null : perSlot.toString(),
    performanceSolPerSlot: perSlot === null ? null : lamportsToSol(perSlot),
    windowSlots: stats.windowSlots,
    windowIncomeLamports: total.toString(),
    windowIncomeSol: lamportsToSol(total),
    incomeLamportsPerSlot: perSlot === null ? null : perSlot.toString(),
    incomeSolPerSlot: perSlot === null ? null : lamportsToSol(perSlot),
    currentElapsedAssignedSlots: stats.currentElapsedAssignedSlots,
    currentIncomeLamports: stats.currentIncomeLamports.toString(),
    currentIncomeSol: lamportsToSol(stats.currentIncomeLamports),
    closedEpochsIncluded: stats.closedEpochsIncluded,
    sampleStatus: sampleStatus(stats.windowSlots),
    slotWindowLastSlot: stats.slotWindowLastSlot,
    slotWindowUpdatedAt:
      stats.slotWindowUpdatedAt === null ? null : stats.slotWindowUpdatedAt.toISOString(),
    lastUpdatedAt: stats.lastUpdatedAt === null ? null : stats.lastUpdatedAt.toISOString(),
    activatedStakeLamports: stake === null ? null : stake.toString(),
    activatedStakeSol: stake === null ? null : lamportsToSol(stake),
    incomePerStake,
    claimed,
    decadeEpochStart: decadeBadge?.epochStart ?? null,
    decadeEpochEnd: decadeBadge?.epochEnd ?? null,
    decadeRank: decadeBadge?.rank ?? null,
    windowedCu: windowedCu === null ? null : windowedCu.toString(),
  };
}

function toDecadeRank(rank: number): DecadeRank | null {
  return rank === 1 || rank === 2 || rank === 3 ? rank : null;
}

async function resolveLatestCompleteDecade(
  epochsRepo: Pick<EpochsRepository, 'findLatestCompleteClosedEpochBlock'>,
): Promise<EpochInfo[]> {
  return epochsRepo.findLatestCompleteClosedEpochBlock(DECADE_EPOCH_COUNT);
}

function buildDecadeRankMapFromRows(
  rows: WindowedLeaderboardStats[],
  closed: EpochInfo[],
): Map<string, DecadeBadge> {
  if (closed.length !== DECADE_EPOCH_COUNT) return new Map();
  const epochEnd = closed[0]!.epoch;
  const epochStart = closed[closed.length - 1]!.epoch;
  const out = new Map<string, DecadeBadge>();
  rows
    .filter((row) => row.closedEpochsIncluded === DECADE_EPOCH_COUNT)
    .slice(0, DECADE_RANK_LIMIT)
    .forEach((row, index) => {
      const rank = toDecadeRank(index + 1);
      if (rank === null) return;
      out.set(row.votePubkey, { epochStart, epochEnd, rank });
    });
  return out;
}

async function buildDecadeRankMap(
  statsRepo: Pick<StatsRepository, 'findTopNByWindow'>,
  epochsRepo: Pick<EpochsRepository, 'findLatestCompleteClosedEpochBlock'>,
  optedOutVotes: Set<string>,
  minWindowSlots: number,
): Promise<Map<string, DecadeBadge>> {
  const closed = await resolveLatestCompleteDecade(epochsRepo);
  if (closed.length !== DECADE_EPOCH_COUNT) return new Map();

  const rows = await statsRepo.findTopNByWindow({
    epochs: closed.map((row) => ({ epoch: row.epoch, isCurrent: false })),
    limit: MAX_LIMIT,
    sort: 'income_per_slot',
    minWindowSlots,
    requiredClosedEpochs: DECADE_EPOCH_COUNT,
    excludedVotes: Array.from(optedOutVotes),
  });
  return buildDecadeRankMapFromRows(rows, closed);
}

function closedCountForWindow(window: LeaderboardWindow): number {
  switch (window) {
    case 'stable_trend':
      return 2;
    case 'live_trend':
    case 'final_epoch':
      return 1;
    case 'decade_epoch':
    case 'current_only':
    default:
      return 0;
  }
}

function requiredClosedEpochsForWindow(window: LeaderboardWindow): number {
  return window === 'decade_epoch' ? DECADE_EPOCH_COUNT : closedCountForWindow(window);
}

async function resolveWindowEpochs(
  window: LeaderboardWindow,
  epochOverride: number | undefined,
  epochsRepo: Pick<
    EpochsRepository,
    'findCurrent' | 'findByEpoch' | 'findLatestClosedEpochs' | 'findLatestCompleteClosedEpochBlock'
  >,
): Promise<{
  epochs: LeaderboardWindowEpoch[];
  current: EpochInfo | null;
  closed: EpochInfo[];
  epochClosedAt: string | null;
}> {
  if (epochOverride !== undefined && window !== 'final_epoch') {
    throw new AppError(
      'invalid_leaderboard_window',
      'epoch override is only supported with window=final_epoch',
      400,
      { epoch: epochOverride, window },
    );
  }

  if (epochOverride !== undefined) {
    const epoch = await epochsRepo.findByEpoch(epochOverride);
    if (epoch === null) throw new NotFoundError('epoch', String(epochOverride));
    if (!epoch.isClosed) {
      throw new AppError(
        'epoch_not_closed',
        'explicit leaderboard epoch is still open; use a live window instead',
        409,
        { epoch: epochOverride },
      );
    }
    return {
      epochs: [{ epoch: epoch.epoch, isCurrent: false }],
      current: null,
      closed: [epoch],
      epochClosedAt: epoch.closedAt?.toISOString() ?? null,
    };
  }

  if (window === 'decade_epoch') {
    const closed = await resolveLatestCompleteDecade(epochsRepo);
    return {
      epochs: closed.map((row) => ({ epoch: row.epoch, isCurrent: false })),
      current: null,
      closed,
      epochClosedAt: closed[0]?.closedAt?.toISOString() ?? null,
    };
  }

  const closedCount = closedCountForWindow(window);
  const [current, closed] = await Promise.all([
    epochsRepo.findCurrent(),
    closedCount > 0 ? epochsRepo.findLatestClosedEpochs(closedCount) : Promise.resolve([]),
  ]);

  const out: LeaderboardWindowEpoch[] = [];
  if (window !== 'final_epoch' && current !== null && !current.isClosed) {
    out.push({ epoch: current.epoch, isCurrent: true });
  }
  for (const row of closed) {
    out.push({ epoch: row.epoch, isCurrent: false });
  }

  return {
    epochs: out,
    current,
    closed,
    epochClosedAt: closed[0]?.closedAt?.toISOString() ?? null,
  };
}

/**
 * Bracket params passed through to `StatsRepository.findTopNByWindow`.
 * A stake bracket sets `maxActivatedStakeLamports`; a candidate
 * bracket (`newcomer` / `client:<kind>`) sets `candidateVotes` to an
 * allowlist. `bracket=all` sets neither. Exactly one (or neither) is
 * ever populated.
 */
interface BracketFilter {
  maxActivatedStakeLamports?: bigint;
  candidateVotes?: readonly string[] | null;
}

/**
 * Resolve a validated bracket token into the candidate-narrowing
 * params for `findTopNByWindow`. Stake brackets convert their SOL
 * ceiling to lamports; candidate brackets (`newcomer`, `client:<kind>`)
 * resolve a vote allowlist from `validators`.
 *
 * `currentEpoch` anchors the `newcomer` window. When the validators
 * repo is unavailable a candidate bracket resolves to an empty
 * allowlist (no members) rather than silently falling back to the
 * global set — a `newcomer`/`client` query must never leak
 * out-of-bracket validators.
 */
async function resolveBracketFilter(
  bracket: string,
  currentEpoch: number,
  validatorsRepo: Pick<ValidatorsRepository, 'findVotesForBracket'> | undefined,
): Promise<BracketFilter> {
  if (bracket === 'all') return {};
  if (bracket === 'stake_lt_100k' || bracket === 'stake_lt_500k') {
    return {
      maxActivatedStakeLamports: STAKE_BRACKET_CEILING_SOL[bracket] * LAMPORTS_PER_SOL,
    };
  }
  if (validatorsRepo === undefined) return { candidateVotes: [] };
  if (bracket === 'newcomer') {
    // Genesis-preferred tenure origin within the last
    // NEWCOMER_WINDOW_EPOCHS epochs (inclusive), mirroring
    // `summariseTenure`'s `activeEpochs <= 30` semantics. `Math.max`
    // floors the threshold at 0 for very-early-epoch environments.
    const newcomerFromEpoch = Math.max(0, currentEpoch - NEWCOMER_WINDOW_EPOCHS);
    return { candidateVotes: await validatorsRepo.findVotesForBracket({ newcomerFromEpoch }) };
  }
  if (bracket.startsWith(CLIENT_BRACKET_PREFIX)) {
    const clientKind = bracket.slice(CLIENT_BRACKET_PREFIX.length);
    return { candidateVotes: await validatorsRepo.findVotesForBracket({ clientKind }) };
  }
  // Unreachable: BracketSchema rejects everything else with a
  // validation_error before we get here. Defend anyway so a future
  // schema-widen can't silently degrade to an unfiltered result.
  throw new ValidationError('unsupported bracket', { bracket });
}

const leaderboardRoutes: FastifyPluginAsync<LeaderboardRoutesDeps> = async (
  app: FastifyInstance,
  opts: LeaderboardRoutesDeps,
) => {
  const {
    statsRepo,
    epochsRepo,
    aggregatesRepo,
    processedBlocksRepo,
    validatorsRepo,
    profilesRepo,
    claimsRepo,
  } = opts;
  const responseCache = new TtlCache<string, LeaderboardResponse>(LEADERBOARD_CACHE_MAX_ENTRIES);

  app.get('/v1/leaderboard', async (request, reply): Promise<LeaderboardResponse> => {
    const query = unwrap(LeaderboardQuerySchema.safeParse(request.query), 'query parameter');
    const cacheKey = JSON.stringify(query);
    const now = Date.now();
    const cached = responseCache.get(cacheKey, now);
    if (cached !== undefined) {
      setClientReadCache(reply);
      return cached;
    }

    const resolved = await resolveWindowEpochs(query.window, query.epoch, epochsRepo);

    if (resolved.epochs.length === 0) {
      const body: LeaderboardResponse = {
        epoch: 0,
        epochClosedAt: null,
        window: query.window,
        sort: query.sort,
        isFinal: query.window === 'final_epoch' || query.window === 'decade_epoch',
        currentEpoch: null,
        closedEpochsIncluded: [],
        asOfSlot: null,
        safeUpperSlot: null,
        slotDenominator: 'window_slots',
        samplePolicy: { minWindowSlots: query.minWindowSlots, lowBelow: 16, mediumBelow: 64 },
        count: 0,
        bracket: query.bracket,
        bracketCount: 0,
        limit: query.limit,
        items: [],
        cluster: null,
      };
      responseCache.set(cacheKey, body, LEADERBOARD_CACHE_TTL_MS, now);
      setClientReadCache(reply);
      return body;
    }

    const requiredClosedEpochs = requiredClosedEpochsForWindow(query.window);
    const optedOutVotes =
      profilesRepo === undefined ? new Set<string>() : await profilesRepo.findOptedOutVotes();

    // Anchor the `newcomer` window on the true network epoch. It's
    // available on most windows via `resolved.current`; for the
    // override / final / decade paths (`current === null`) fall back
    // to `findCurrent()`. Only fetched when the bracket actually needs
    // it, so non-newcomer queries keep their round-trip count.
    let newcomerCurrentEpoch = resolved.current?.epoch ?? null;
    if (query.bracket === 'newcomer' && newcomerCurrentEpoch === null) {
      newcomerCurrentEpoch = (await epochsRepo.findCurrent())?.epoch ?? null;
    }
    const bracketFilter = await resolveBracketFilter(
      query.bracket,
      newcomerCurrentEpoch ?? 0,
      validatorsRepo,
    );

    // For the default `all` bracket, fetch exactly the requested
    // limit (unchanged hot path). For any active bracket, over-fetch
    // to the repo ceiling so `bracketCount` reflects the full
    // bracket-relative pool, then slice to `limit` for the rows we
    // render.
    const fetchLimit = query.bracket === 'all' ? query.limit : MAX_LIMIT;
    const rows = await statsRepo.findTopNByWindow({
      epochs: resolved.epochs,
      limit: fetchLimit,
      sort: query.sort,
      minWindowSlots: query.minWindowSlots,
      requiredClosedEpochs,
      excludedVotes: Array.from(optedOutVotes),
      // Spread so `exactOptionalPropertyTypes` is honoured — only the
      // keys the bracket actually sets are present, never `undefined`.
      ...bracketFilter,
    });
    const bracketCount = rows.length;
    const visibleRows = rows.slice(0, query.limit);

    const identities = Array.from(new Set(visibleRows.map((r) => r.identityPubkey)));
    const votes = visibleRows.map((r) => r.votePubkey);
    // Decade badges are an ABSOLUTE all-time-top-3 achievement, so
    // they stay cluster-wide even under a bracket filter. The
    // build-from-rows fast path is only valid when the fetched `rows`
    // ARE the full cluster ranking — i.e. the default `all` bracket;
    // otherwise fall back to the dedicated unfiltered decade query.
    const decadeRanksPromise =
      query.window === 'decade_epoch' && query.sort === 'income_per_slot' && query.bracket === 'all'
        ? Promise.resolve(buildDecadeRankMapFromRows(rows, resolved.closed))
        : buildDecadeRankMap(statsRepo, epochsRepo, optedOutVotes, query.minWindowSlots);
    const [infoByIdentity, claimedVotes, decadeRanks, windowedCuByVote] = await Promise.all([
      validatorsRepo !== undefined && identities.length > 0
        ? validatorsRepo.getInfosByIdentities(identities)
        : Promise.resolve(
            new Map<
              IdentityPubkey,
              { name: string | null; iconUrl: string | null; website: string | null }
            >(),
          ),
      claimsRepo !== undefined && votes.length > 0
        ? claimsRepo.findClaimedVotes(votes)
        : Promise.resolve(new Set<string>()),
      decadeRanksPromise,
      // Per-row windowed CU: producedBlock-weighted average compute
      // units across the resolved window epochs, keyed by vote.
      // Restricted to the visible votes so the aggregation only
      // touches shown rows.
      processedBlocksRepo.getWindowedComputeUnitsByVote(
        resolved.epochs.map((e) => e.epoch),
        votes,
      ),
    ]);

    const items = visibleRows.map((row, i) =>
      toRow(
        row,
        i + 1,
        infoByIdentity.get(row.identityPubkey),
        claimedVotes.has(row.votePubkey),
        decadeRanks.get(row.votePubkey),
        windowedCuByVote.get(row.votePubkey) ?? null,
      ),
    );

    const finalEpoch = resolved.closed[0];
    const clusterAgg =
      query.window === 'final_epoch' && finalEpoch !== undefined
        ? await aggregatesRepo.findByEpochTopN(finalEpoch.epoch, 100)
        : null;
    const cluster: LeaderboardResponse['cluster'] =
      clusterAgg === null
        ? null
        : {
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
          };

    const currentEpoch =
      resolved.current !== null && !resolved.current.isClosed ? resolved.current : null;
    const safeUpperSlot = items.reduce<number | null>((max, row) => {
      if (row.slotWindowLastSlot === null) return max;
      return max === null || row.slotWindowLastSlot > max ? row.slotWindowLastSlot : max;
    }, null);

    const body: LeaderboardResponse = {
      epoch:
        query.window === 'final_epoch' || query.window === 'decade_epoch'
          ? (finalEpoch?.epoch ?? 0)
          : (currentEpoch?.epoch ?? 0),
      epochClosedAt:
        query.window === 'final_epoch' || query.window === 'decade_epoch'
          ? resolved.epochClosedAt
          : null,
      window: query.window,
      sort: query.sort,
      isFinal: query.window === 'final_epoch' || query.window === 'decade_epoch',
      currentEpoch: currentEpoch?.epoch ?? null,
      closedEpochsIncluded: resolved.closed.map((row) => row.epoch),
      asOfSlot: currentEpoch?.currentSlot ?? null,
      safeUpperSlot,
      slotDenominator: 'window_slots',
      samplePolicy: { minWindowSlots: query.minWindowSlots, lowBelow: 16, mediumBelow: 64 },
      count: items.length,
      bracket: query.bracket,
      bracketCount,
      limit: query.limit,
      items,
      cluster,
    };
    responseCache.set(cacheKey, body, LEADERBOARD_CACHE_TTL_MS, now);
    setClientReadCache(reply);
    return body;
  });
};

export default leaderboardRoutes;
