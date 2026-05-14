import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { computeOperatorActivityIndex } from '../../services/operator-activity-index.js';
import type { OperatorWalletsRepository } from '../../storage/repositories/operator-wallets.repo.js';
import type { SimdDiscussionsRepository } from '../../storage/repositories/simd-discussions.repo.js';
import type { ValidatorGithubRepository } from '../../storage/repositories/validator-github.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { WalletActivityRepository } from '../../storage/repositories/wallet-activity.repo.js';
import { VoteOrIdentityParamSchema } from '../schemas/requests.js';

export interface OaiRoutesDeps {
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  validatorGithubRepo: Pick<ValidatorGithubRepository, 'findByVote'>;
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listByVote'>;
  walletActivityRepo: Pick<WalletActivityRepository, 'listRecent'>;
  simdDiscussionsRepo: Pick<SimdDiscussionsRepository, 'statsByUsername'>;
}

interface OaiResponse {
  vote: string;
  identity: string;
  composite: number | null;
  components: {
    walletScore: number;
    governance: {
      score: number;
      commentCount: number;
      reactionsReceived: number;
      activeWindowCount: number;
    };
  };
  /**
   * Surface the unmeasured-half flags so a UI can grey-out the
   * composite when one signal is missing entirely (e.g. operator
   * hasn't linked GitHub, or hasn't registered a wallet).
   */
  signalsAvailable: {
    github: boolean;
    wallet: boolean;
  };
}

const OAI_CACHE_MAX_AGE_SEC = 300;
const OAI_CACHE_S_MAXAGE_SEC = 1800;

/**
 * Operator Activity Index — Phase 6+7 partial release.
 *
 * Currently composes the GOVERNANCE half (GitHub Discussions comment
 * count + reactions received) with the WALLET half (active days in
 * the last 90 — Phase 4 fee data is still null until the backfill
 * pass ships). On-chain SIMD vote rate + Realms votes are PLANNED
 * components — when they ship, the governance subscore gets the
 * remaining 0.50 weight share.
 *
 * Cold-start semantics:
 *   - Validator not claimed → 404 (no claim, no OAI to publish).
 *   - Validator claimed but no GitHub link → governance half = 0,
 *     composite computed from wallet half only.
 *   - Validator claimed but no operator wallet → wallet half = 0,
 *     composite from governance only.
 *   - Both missing → composite is null (genuinely unmeasured).
 */
const oaiRoutes: FastifyPluginAsync<OaiRoutesDeps> = async (
  app: FastifyInstance,
  opts: OaiRoutesDeps,
) => {
  app.get<{ Params: { idOrVote: string } }>(
    '/v1/validators/:idOrVote/operator-activity-index',
    async (request, reply): Promise<OaiResponse> => {
      const params = VoteOrIdentityParamSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('idOrVote path parameter failed validation', {
          issues: params.error.issues,
        });
      }
      let validator = await opts.validatorsRepo.findByVote(params.data.idOrVote);
      if (validator === null) {
        validator = await opts.validatorsRepo.findByIdentity(params.data.idOrVote);
      }
      if (validator === null) {
        throw new NotFoundError('validator', params.data.idOrVote);
      }

      // Governance — only counts comments from the validator's
      // linked GitHub username. No link → no governance signal.
      const githubLink = await opts.validatorGithubRepo.findByVote(validator.votePubkey);
      const hasGithub = githubLink !== null;
      let governanceInput = { commentCount: 0, reactionsReceived: 0, activeWindowCount: 0 };
      if (hasGithub) {
        const stats = await opts.simdDiscussionsRepo.statsByUsername([githubLink.githubUsername]);
        const row = stats[0];
        if (row !== undefined) {
          governanceInput = {
            commentCount: row.commentCount,
            reactionsReceived: row.reactionsReceived,
            activeWindowCount: row.activeWindowCount,
          };
        }
      }

      // Wallet — sum active days across all registered wallets
      // (operators with multi-wallet setups get full credit). Phase
      // 4 ingester populates wallet_daily_activity.
      const wallets = await opts.operatorWalletsRepo.listByVote(validator.votePubkey);
      const hasWallet = wallets.length > 0;
      let activeDaysSet = new Set<string>();
      for (const w of wallets) {
        const rows = await opts.walletActivityRepo.listRecent(w.walletPubkey, 90);
        for (const r of rows) {
          if (r.txCount > 0) {
            activeDaysSet.add(r.activityDate.toISOString().slice(0, 10));
          }
        }
      }
      const activeDaysLast90 = activeDaysSet.size;

      const oai = computeOperatorActivityIndex({
        governance: governanceInput,
        wallet: { activeDaysLast90 },
      });

      void reply.header(
        'cache-control',
        `public, max-age=${OAI_CACHE_MAX_AGE_SEC}, s-maxage=${OAI_CACHE_S_MAXAGE_SEC}`,
      );
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        composite: oai.composite,
        components: {
          walletScore: oai.walletScore,
          governance: {
            score: oai.governance.score,
            commentCount: oai.governance.components.commentCount,
            reactionsReceived: oai.governance.components.reactionsReceived,
            activeWindowCount: oai.governance.components.activeWindowCount,
          },
        },
        signalsAvailable: {
          github: hasGithub,
          wallet: hasWallet,
        },
      };
    },
  );
};

export default oaiRoutes;
