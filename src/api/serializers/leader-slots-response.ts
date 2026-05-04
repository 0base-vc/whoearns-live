import { lamportsToSol } from '../../core/lamports.js';
import type { ValidatorEpochSlotStats } from '../../types/domain.js';

export interface ValidatorEpochSlotStatsResponse {
  epoch: number;
  vote: string;
  identity: string;
  hasData: boolean;
  isFinal: boolean;
  quality: ValidatorEpochSlotStats['quality'];
  summary: {
    producedBlocks: number;
    totalIncomeLamports: string;
    totalIncomeSol: string;
    totalFeesLamports: string;
    totalFeesSol: string;
    totalTipsLamports: string;
    totalTipsSol: string;
    txCount: number;
    successfulTxCount: number;
    failedTxCount: number;
    unknownMetaTxCount: number;
    failedTxRate: number | null;
    signatureCount: number;
    tipTxCount: number;
    tipBearingBlockCount: number;
    tipBearingBlockRatio: number | null;
    avgPriorityFeePerProducedBlockLamports: string | null;
    avgPriorityFeePerProducedBlockSol: string | null;
    avgTipPerProducedBlockLamports: string | null;
    avgTipPerProducedBlockSol: string | null;
    maxPriorityFeeLamports: string;
    maxPriorityFeeSol: string;
    maxTipLamports: string;
    maxTipSol: string;
    computeUnitsConsumed: string;
    bestBlockSlot: number | null;
    bestBlockIncomeLamports: string | null;
    bestBlockIncomeSol: string | null;
  };
  updatedAt: string | null;
}

function lamportPair(value: bigint): { lamports: string; sol: string } {
  return { lamports: value.toString(), sol: lamportsToSol(value) };
}

function lamportPairOrNull(value: bigint | null): {
  lamports: string | null;
  sol: string | null;
} {
  if (value === null) return { lamports: null, sol: null };
  return lamportPair(value);
}

export function serializeValidatorEpochSlotStats(
  slotStats: ValidatorEpochSlotStats,
  isFinal: boolean,
): ValidatorEpochSlotStatsResponse {
  const totalIncome = lamportPair(slotStats.summary.totalIncomeLamports);
  const totalFees = lamportPair(slotStats.summary.totalFeesLamports);
  const totalTips = lamportPair(slotStats.summary.totalTipsLamports);
  const avgPriority = lamportPairOrNull(slotStats.summary.avgPriorityFeePerProducedBlockLamports);
  const avgTip = lamportPairOrNull(slotStats.summary.avgTipPerProducedBlockLamports);
  const maxPriority = lamportPair(slotStats.summary.maxPriorityFeeLamports);
  const maxTip = lamportPair(slotStats.summary.maxTipLamports);
  const bestBlock = lamportPairOrNull(slotStats.summary.bestBlockIncomeLamports);

  return {
    epoch: slotStats.epoch,
    vote: slotStats.votePubkey,
    identity: slotStats.identityPubkey,
    hasData: slotStats.hasData,
    isFinal,
    quality: slotStats.quality,
    summary: {
      producedBlocks: slotStats.summary.producedBlocks,
      totalIncomeLamports: totalIncome.lamports,
      totalIncomeSol: totalIncome.sol,
      totalFeesLamports: totalFees.lamports,
      totalFeesSol: totalFees.sol,
      totalTipsLamports: totalTips.lamports,
      totalTipsSol: totalTips.sol,
      txCount: slotStats.summary.txCount,
      successfulTxCount: slotStats.summary.successfulTxCount,
      failedTxCount: slotStats.summary.failedTxCount,
      unknownMetaTxCount: slotStats.summary.unknownMetaTxCount,
      failedTxRate: slotStats.summary.failedTxRate,
      signatureCount: slotStats.summary.signatureCount,
      tipTxCount: slotStats.summary.tipTxCount,
      tipBearingBlockCount: slotStats.summary.tipBearingBlockCount,
      tipBearingBlockRatio: slotStats.summary.tipBearingBlockRatio,
      avgPriorityFeePerProducedBlockLamports: avgPriority.lamports,
      avgPriorityFeePerProducedBlockSol: avgPriority.sol,
      avgTipPerProducedBlockLamports: avgTip.lamports,
      avgTipPerProducedBlockSol: avgTip.sol,
      maxPriorityFeeLamports: maxPriority.lamports,
      maxPriorityFeeSol: maxPriority.sol,
      maxTipLamports: maxTip.lamports,
      maxTipSol: maxTip.sol,
      computeUnitsConsumed: slotStats.summary.computeUnitsConsumed.toString(),
      bestBlockSlot: slotStats.summary.bestBlockSlot,
      bestBlockIncomeLamports: bestBlock.lamports,
      bestBlockIncomeSol: bestBlock.sol,
    },
    updatedAt: slotStats.updatedAt === null ? null : slotStats.updatedAt.toISOString(),
  };
}
