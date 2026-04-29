import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AppError, NotFoundError, ValidationError } from '../../core/errors.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type {
  EpochInfo,
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

export interface ValidatorsRoutesDeps {
  statsRepo: Pick<
    StatsRepository,
    'findByVoteEpoch' | 'findManyByVotesCurrentEpoch' | 'findManyByVotesEpoch'
  >;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity' | 'findManyByVotes'>;
  epochsRepo: Pick<EpochsRepository, 'findCurrent' | 'findByEpoch'>;
}

interface BatchResponse {
  epoch: number;
  results: ValidatorCurrentEpochResponse[];
  missing: string[];
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

async function findValidatorByVoteOrIdentity(
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>,
  idOrVote: VotePubkey,
): Promise<Validator | null> {
  const byVote = await validatorsRepo.findByVote(idOrVote);
  if (byVote !== null) return byVote;
  return validatorsRepo.findByIdentity(idOrVote);
}

const validatorsRoutes: FastifyPluginAsync<ValidatorsRoutesDeps> = async (
  app: FastifyInstance,
  opts: ValidatorsRoutesDeps,
) => {
  const { statsRepo, validatorsRepo, epochsRepo } = opts;
  const serialCtx = {};

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
};

export default validatorsRoutes;
