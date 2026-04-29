import { lamportsToSol, lamportsToString } from '../../core/lamports.js';
import type {
  Epoch,
  EpochAggregate,
  EpochInfo,
  EpochValidatorStats,
  IdentityPubkey,
  ValidatorCurrentEpochResponse,
  VotePubkey,
} from '../../types/domain.js';

export type SerializerContext = Record<string, never>;

function maxDate(...dates: (Date | null)[]): Date | null {
  let max: Date | null = null;
  for (const d of dates) {
    if (d === null) continue;
    if (max === null || d.getTime() > max.getTime()) max = d;
  }
  return max;
}

/**
 * Shape the cluster benchmark block we attach to each response, or
 * `null` if no aggregate was computed for this epoch yet.
 */
function serializeCluster(
  aggregate: EpochAggregate | null,
): ValidatorCurrentEpochResponse['cluster'] {
  if (aggregate === null) return null;
  return {
    topN: aggregate.topN,
    sampleValidators: aggregate.sampleValidators,
    sampleBlockCount: aggregate.sampleBlockCount,
    medianBlockFeeLamports:
      aggregate.medianFeeLamports === null ? null : lamportsToString(aggregate.medianFeeLamports),
    medianBlockTipLamports:
      aggregate.medianTipLamports === null ? null : lamportsToString(aggregate.medianTipLamports),
  };
}

/**
 * Serialize a stored (epoch, vote) row into the public API response.
 *
 * Income is sourced only from Solana RPC block data:
 *   block fees = leader fee reward
 *   MEV tips   = on-chain Jito tip-account balance deltas
 *   total      = block fees + MEV tips
 */
export function serializeValidator(
  stats: EpochValidatorStats,
  epoch: EpochInfo,
  _ctx?: SerializerContext,
  cluster: EpochAggregate | null = null,
): ValidatorCurrentEpochResponse {
  const hasSlots = stats.slotsUpdatedAt !== null;
  const hasIncome = stats.feesUpdatedAt !== null;
  const isFinal = epoch.isClosed;
  const isCurrentEpoch = !epoch.isClosed;

  const lastUpdated = maxDate(
    stats.slotsUpdatedAt,
    stats.feesUpdatedAt,
    stats.medianFeeUpdatedAt,
    stats.medianBaseFeeUpdatedAt,
    stats.medianPriorityFeeUpdatedAt,
    stats.tipsUpdatedAt,
    stats.medianTipUpdatedAt,
    stats.medianTotalUpdatedAt,
  );

  const medianHasData = hasIncome && stats.medianFeeLamports !== null;
  const medianBaseHasData = hasIncome && stats.medianBaseFeeLamports !== null;
  const medianPriorityHasData = hasIncome && stats.medianPriorityFeeLamports !== null;
  const medianTipHasData = hasIncome && stats.medianTipLamports !== null;
  const medianTotalHasData = hasIncome && stats.medianTotalLamports !== null;
  const totalIncome = stats.blockFeesTotalLamports + stats.blockTipsTotalLamports;

  return {
    vote: stats.votePubkey,
    identity: stats.identityPubkey,
    epoch: stats.epoch,

    isCurrentEpoch,
    isFinal,
    hasSlots,
    hasIncome,

    slotsAssigned: hasSlots ? stats.slotsAssigned : null,
    slotsProduced: hasSlots ? stats.slotsProduced : null,
    slotsSkipped: hasSlots ? stats.slotsSkipped : null,

    blockFeesTotalLamports: hasIncome ? lamportsToString(stats.blockFeesTotalLamports) : null,
    blockFeesTotalSol: hasIncome ? lamportsToSol(stats.blockFeesTotalLamports) : null,
    medianBlockFeeLamports: medianHasData ? lamportsToString(stats.medianFeeLamports) : null,
    medianBlockFeeSol:
      medianHasData && stats.medianFeeLamports !== null
        ? lamportsToSol(stats.medianFeeLamports)
        : null,

    blockBaseFeesTotalLamports: hasIncome
      ? lamportsToString(stats.blockBaseFeesTotalLamports)
      : null,
    blockBaseFeesTotalSol: hasIncome ? lamportsToSol(stats.blockBaseFeesTotalLamports) : null,
    medianBlockBaseFeeLamports: medianBaseHasData
      ? lamportsToString(stats.medianBaseFeeLamports)
      : null,
    medianBlockBaseFeeSol:
      medianBaseHasData && stats.medianBaseFeeLamports !== null
        ? lamportsToSol(stats.medianBaseFeeLamports)
        : null,

    blockPriorityFeesTotalLamports: hasIncome
      ? lamportsToString(stats.blockPriorityFeesTotalLamports)
      : null,
    blockPriorityFeesTotalSol: hasIncome
      ? lamportsToSol(stats.blockPriorityFeesTotalLamports)
      : null,
    medianBlockPriorityFeeLamports: medianPriorityHasData
      ? lamportsToString(stats.medianPriorityFeeLamports)
      : null,
    medianBlockPriorityFeeSol:
      medianPriorityHasData && stats.medianPriorityFeeLamports !== null
        ? lamportsToSol(stats.medianPriorityFeeLamports)
        : null,

    blockTipsTotalLamports: hasIncome ? lamportsToString(stats.blockTipsTotalLamports) : null,
    blockTipsTotalSol: hasIncome ? lamportsToSol(stats.blockTipsTotalLamports) : null,
    medianBlockTipLamports: medianTipHasData ? lamportsToString(stats.medianTipLamports) : null,
    medianBlockTipSol:
      medianTipHasData && stats.medianTipLamports !== null
        ? lamportsToSol(stats.medianTipLamports)
        : null,
    medianBlockTotalLamports: medianTotalHasData
      ? lamportsToString(stats.medianTotalLamports)
      : null,
    medianBlockTotalSol:
      medianTotalHasData && stats.medianTotalLamports !== null
        ? lamportsToSol(stats.medianTotalLamports)
        : null,

    totalIncomeLamports: hasIncome ? lamportsToString(totalIncome) : null,
    totalIncomeSol: hasIncome ? lamportsToSol(totalIncome) : null,

    lastUpdatedAt: lastUpdated === null ? null : lastUpdated.toISOString(),
    freshness: {
      slotsUpdatedAt: stats.slotsUpdatedAt === null ? null : stats.slotsUpdatedAt.toISOString(),
      feesUpdatedAt: stats.feesUpdatedAt === null ? null : stats.feesUpdatedAt.toISOString(),
      medianFeeUpdatedAt:
        stats.medianFeeUpdatedAt === null ? null : stats.medianFeeUpdatedAt.toISOString(),
      medianBaseFeeUpdatedAt:
        stats.medianBaseFeeUpdatedAt === null ? null : stats.medianBaseFeeUpdatedAt.toISOString(),
      medianPriorityFeeUpdatedAt:
        stats.medianPriorityFeeUpdatedAt === null
          ? null
          : stats.medianPriorityFeeUpdatedAt.toISOString(),
      tipsUpdatedAt: stats.tipsUpdatedAt === null ? null : stats.tipsUpdatedAt.toISOString(),
      medianTipUpdatedAt:
        stats.medianTipUpdatedAt === null ? null : stats.medianTipUpdatedAt.toISOString(),
      medianTotalUpdatedAt:
        stats.medianTotalUpdatedAt === null ? null : stats.medianTotalUpdatedAt.toISOString(),
    },
    cluster: serializeCluster(cluster),
  };
}

/**
 * Placeholder response for a known validator with no stored stats row at the
 * requested epoch. Numeric fields stay null; booleans make absence explicit.
 */
export function serializeValidatorPlaceholder(args: {
  vote: VotePubkey;
  identity: IdentityPubkey;
  epoch: Epoch;
  ctx?: SerializerContext;
  isCurrentEpoch?: boolean;
  isFinal?: boolean;
  cluster?: EpochAggregate | null;
}): ValidatorCurrentEpochResponse {
  return {
    vote: args.vote,
    identity: args.identity,
    epoch: args.epoch,

    isCurrentEpoch: args.isCurrentEpoch ?? false,
    isFinal: args.isFinal ?? true,
    hasSlots: false,
    hasIncome: false,

    slotsAssigned: null,
    slotsProduced: null,
    slotsSkipped: null,

    blockFeesTotalLamports: null,
    blockFeesTotalSol: null,
    medianBlockFeeLamports: null,
    medianBlockFeeSol: null,

    blockBaseFeesTotalLamports: null,
    blockBaseFeesTotalSol: null,
    medianBlockBaseFeeLamports: null,
    medianBlockBaseFeeSol: null,

    blockPriorityFeesTotalLamports: null,
    blockPriorityFeesTotalSol: null,
    medianBlockPriorityFeeLamports: null,
    medianBlockPriorityFeeSol: null,

    blockTipsTotalLamports: null,
    blockTipsTotalSol: null,
    medianBlockTipLamports: null,
    medianBlockTipSol: null,
    medianBlockTotalLamports: null,
    medianBlockTotalSol: null,

    totalIncomeLamports: null,
    totalIncomeSol: null,

    lastUpdatedAt: null,
    freshness: {
      slotsUpdatedAt: null,
      feesUpdatedAt: null,
      medianFeeUpdatedAt: null,
      medianBaseFeeUpdatedAt: null,
      medianPriorityFeeUpdatedAt: null,
      tipsUpdatedAt: null,
      medianTipUpdatedAt: null,
      medianTotalUpdatedAt: null,
    },
    cluster: serializeCluster(args.cluster ?? null),
  };
}
