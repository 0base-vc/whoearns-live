import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../../storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { Validator, VotePubkey } from '../../types/domain.js';
import { VoteOrIdentityAndEpochParamSchema } from '../schemas/requests.js';
import {
  serializeValidatorEpochSlotStats,
  type ValidatorEpochSlotStatsResponse,
} from '../serializers/leader-slots-response.js';

export interface ValidatorLeaderSlotsRoutesDeps {
  statsRepo: Pick<StatsRepository, 'findByVoteEpoch'>;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  epochsRepo: Pick<EpochsRepository, 'findByEpoch'>;
  processedBlocksRepo: Pick<ProcessedBlocksRepository, 'getValidatorEpochSlotStats'>;
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

      return serializeValidatorEpochSlotStats(slotStats, epochRow?.isClosed ?? false);
    },
  );
};

export default validatorLeaderSlotsRoutes;
