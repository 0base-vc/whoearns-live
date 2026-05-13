import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError, NotFoundError, ValidationError } from '../../core/errors.js';
import { lamportsToSol, lamportsToString } from '../../core/lamports.js';
import { TtlCache } from '../../core/ttl-cache.js';
import { normaliseHttpUrlOrNull } from '../../core/url.js';
import type { AggregatesRepository } from '../../storage/repositories/aggregates.repo.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MIN_WINDOW_SLOTS = 4;
const LEADERBOARD_CACHE_TTL_MS = 10_000;
const LEADERBOARD_CACHE_MAX_ENTRIES = 256;
const DECADE_EPOCH_COUNT = 10;
const DECADE_RANK_LIMIT = 3;

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
    .enum(['income_per_slot', 'total_income', 'mev_tips', 'fees', 'skip_rate'])
    .default('income_per_slot'),
);

const LeaderboardQuerySchema = z
  .object({
    epoch: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
    minWindowSlots: z.coerce.number().int().positive().max(500).default(DEFAULT_MIN_WINDOW_SLOTS),
    sort: SortEnumSchema,
    window: WindowEnumSchema.optional(),
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
  validatorsRepo?: Pick<ValidatorsRepository, 'getInfosByIdentities'>;
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
  limit: number;
  items: LeaderboardRow[];
  cluster: {
    topN: number;
    sampleValidators: number;
    medianBlockFeeLamports: string | null;
    medianBlockTipLamports: string | null;
  } | null;
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

const leaderboardRoutes: FastifyPluginAsync<LeaderboardRoutesDeps> = async (
  app: FastifyInstance,
  opts: LeaderboardRoutesDeps,
) => {
  const { statsRepo, epochsRepo, aggregatesRepo, validatorsRepo, profilesRepo, claimsRepo } = opts;
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
    const rows = await statsRepo.findTopNByWindow({
      epochs: resolved.epochs,
      limit: query.limit,
      sort: query.sort,
      minWindowSlots: query.minWindowSlots,
      requiredClosedEpochs,
      excludedVotes: Array.from(optedOutVotes),
    });
    const visibleRows = rows.slice(0, query.limit);

    const identities = Array.from(new Set(visibleRows.map((r) => r.identityPubkey)));
    const votes = visibleRows.map((r) => r.votePubkey);
    const decadeRanksPromise =
      query.window === 'decade_epoch' && query.sort === 'income_per_slot'
        ? Promise.resolve(buildDecadeRankMapFromRows(rows, resolved.closed))
        : buildDecadeRankMap(statsRepo, epochsRepo, optedOutVotes, query.minWindowSlots);
    const [infoByIdentity, claimedVotes, decadeRanks] = await Promise.all([
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
    ]);

    const items = visibleRows.map((row, i) =>
      toRow(
        row,
        i + 1,
        infoByIdentity.get(row.identityPubkey),
        claimedVotes.has(row.votePubkey),
        decadeRanks.get(row.votePubkey),
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
