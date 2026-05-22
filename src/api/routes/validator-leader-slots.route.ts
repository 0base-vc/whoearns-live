import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError } from '../../core/errors.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../../storage/repositories/processed-blocks.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { Validator, VotePubkey } from '../../types/domain.js';
import { VoteOrIdentityAndEpochParamSchema } from '../schemas/requests.js';
import {
  serializeValidatorEpochSlotStats,
  type ValidatorEpochSlotStatsResponse,
} from '../serializers/leader-slots-response.js';
import { unwrap } from '../zod-helpers.js';

export interface ValidatorLeaderSlotsRoutesDeps {
  statsRepo: Pick<StatsRepository, 'findByVoteEpoch'>;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  epochsRepo: Pick<EpochsRepository, 'findByEpoch'>;
  processedBlocksRepo: Pick<ProcessedBlocksRepository, 'getValidatorEpochSlotStats'>;
  profilesRepo: Pick<ProfilesRepository, 'findByVote'>;
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
  const { statsRepo, validatorsRepo, epochsRepo, processedBlocksRepo, profilesRepo } = opts;

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
      const profile = await profilesRepo.findByVote(validator.votePubkey);
      if (profile?.optedOut === true) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      const [stats, epochRow] = await Promise.all([
        statsRepo.findByVoteEpoch(validator.votePubkey, params.epoch),
        epochsRepo.findByEpoch(params.epoch),
      ]);
      const slotStats = await processedBlocksRepo.getValidatorEpochSlotStats({
        epoch: params.epoch,
        votePubkey: validator.votePubkey,
        // `processed_blocks` is keyed by `leader_identity`, which is
        // the identity AS OF that epoch — a validator may have rotated
        // its identity key since. Use the per-epoch identity from the
        // `epoch_validator_stats` row, falling back to the current
        // identity only when there is no row (no activity → all-zero
        // either way).
        identityPubkey: stats?.identityPubkey ?? validator.identityPubkey,
        slotsAssigned: stats?.slotsAssigned ?? 0,
        slotsProduced: stats?.slotsProduced ?? 0,
        slotsSkipped: stats?.slotsSkipped ?? 0,
      });

      return serializeValidatorEpochSlotStats(slotStats, epochRow?.isClosed ?? false);
    },
  );
};

export default validatorLeaderSlotsRoutes;
