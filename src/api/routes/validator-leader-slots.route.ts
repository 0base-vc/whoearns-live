import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { lamportsToSol } from '../../core/lamports.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../../storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { Validator, ValidatorEpochSlotStats, VotePubkey } from '../../types/domain.js';
import { VoteOrIdentityAndEpochParamSchema } from '../schemas/requests.js';

export interface ValidatorLeaderSlotsRoutesDeps {
  statsRepo: Pick<StatsRepository, 'findByVoteEpoch'>;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  epochsRepo: Pick<EpochsRepository, 'findByEpoch'>;
  processedBlocksRepo: Pick<ProcessedBlocksRepository, 'getValidatorEpochSlotStats'>;
}

interface ValidatorEpochSlotStatsResponse {
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

function unwrap<T>(
  result: { success: true; data: T } | { success: false; error: unknown },
  context: string,
): T {
  if (result.success) return result.data;
  throw new ValidationError(`${context} failed validation`, {
    issues: (result.error as { issues?: unknown[] }).issues ?? [result.error],
  });
}

async function findValidatorByVoteOrIdentity(
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>,
  idOrVote: VotePubkey,
): Promise<Validator | null> {
  const byVote = await validatorsRepo.findByVote(idOrVote);
  if (byVote !== null) return byVote;
  return validatorsRepo.findByIdentity(idOrVote);
}

function lamportPair(value: bigint): { lamports: string; sol: string } {
  return { lamports: value.toString(), sol: lamportsToSol(value) };
}

function lamportPairOrNull(value: bigint | null): { lamports: string | null; sol: string | null } {
  if (value === null) return { lamports: null, sol: null };
  return lamportPair(value);
}

function serializeSlotStats(
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

const validatorLeaderSlotsRoutes: FastifyPluginAsync<ValidatorLeaderSlotsRoutesDeps> = async (
  app: FastifyInstance,
  opts: ValidatorLeaderSlotsRoutesDeps,
) => {
  const { statsRepo, validatorsRepo, epochsRepo, processedBlocksRepo } = opts;

  app.get(
    '/v1/validators/:idOrVote/epochs/:epoch/leader-slots',
    async (request, _reply): Promise<ValidatorEpochSlotStatsResponse> => {
      const params = unwrap(
        VoteOrIdentityAndEpochParamSchema.safeParse(request.params),
        'path parameters',
      );

      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      const [stats, epochRow] = await Promise.all([
        statsRepo.findByVoteEpoch(validator.votePubkey, params.epoch),
        epochsRepo.findByEpoch(params.epoch),
      ]);
      const slotStats = await processedBlocksRepo.getValidatorEpochSlotStats({
        epoch: params.epoch,
        votePubkey: validator.votePubkey,
        identityPubkey: validator.identityPubkey,
        slotsAssigned: stats?.slotsAssigned ?? 0,
        slotsProduced: stats?.slotsProduced ?? 0,
        slotsSkipped: stats?.slotsSkipped ?? 0,
      });

      return serializeSlotStats(slotStats, epochRow?.isClosed ?? false);
    },
  );
};

export default validatorLeaderSlotsRoutes;
