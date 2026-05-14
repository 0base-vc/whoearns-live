import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { computeOperatorActivityIndex } from '../../services/operator-activity-index.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { OperatorWalletsRepository } from '../../storage/repositories/operator-wallets.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { SimdDiscussionsRepository } from '../../storage/repositories/simd-discussions.repo.js';
import type { ValidatorGithubRepository } from '../../storage/repositories/validator-github.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { WalletActivityRepository } from '../../storage/repositories/wallet-activity.repo.js';
import { cacheControl } from '../cache-control.js';
import { VoteOrIdentityParamSchema } from '../schemas/requests.js';

export interface OaiRoutesDeps {
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  claimsRepo: Pick<ClaimsRepository, 'findByVote'>;
  profilesRepo: Pick<ProfilesRepository, 'findOptedOutVotes'>;
  validatorGithubRepo: Pick<ValidatorGithubRepository, 'findActiveByVote'>;
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listActiveByVote'>;
  walletActivityRepo: Pick<WalletActivityRepository, 'listRecentForWallets'>;
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
}

// SCORING tier — the OAI composite is derived from closed-epoch /
// closed-day signals + re-attestation state; minutes of staleness
// are harmless. Shared rationale: src/api/cache-control.ts.
const OAI_CACHE_CONTROL = cacheControl('SCORING');

/**
 * Operator Activity Index — Phase 6+7 partial release.
 *
 * Gates (all must clear before computation):
 *   1. Validator is known to the indexer (404 otherwise).
 *   2. Validator is CLAIMED (404 — no claim, no public OAI).
 *   3. Validator has NOT opted out of public scoring (404 mirror of
 *      the existing leaderboard / history opt-out semantics).
 *
 * Reads only ACTIVE registrations (`expires_at > NOW()`) from
 * `validator_github` and `operator_wallets`. Lapsed attestations stop
 * contributing scoring signal — matches the "re-attest quarterly"
 * promise in `docs/scoring.md`. `signalsAvailable` (linkage flags)
 * is intentionally omitted from the response to avoid leaking the
 * linked-GitHub / registered-wallet set as a public enumeration
 * oracle; clients can read `composite === null` for the cold-start
 * case where no half has data.
 */
const oaiRoutes: FastifyPluginAsync<OaiRoutesDeps> = async (
  app: FastifyInstance,
  opts: OaiRoutesDeps,
) => {
  // Return type is `OaiResponse | void`: the GET path resolves the
  // structured body, the HEAD short-circuit calls `reply.send('')` and
  // resolves `void`. The union keeps the HEAD path honest — no
  // `as unknown as OaiResponse` cast claiming an empty string is a
  // typed object.
  app.get<{ Params: { idOrVote: string } }>(
    '/v1/validators/:idOrVote/operator-activity-index',
    async (request, reply): Promise<OaiResponse | void> => {
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

      // Claim gate — no claim, no public scoring surface.
      const claim = await opts.claimsRepo.findByVote(validator.votePubkey);
      if (claim === null) {
        throw new NotFoundError('validator claim', params.data.idOrVote);
      }

      // Opt-out gate — mirrors validators-history / leaderboard
      // suppression so a validator can self-remove from scoring
      // surfaces with one switch.
      const optedOut = await opts.profilesRepo.findOptedOutVotes();
      if (optedOut.has(validator.votePubkey)) {
        throw new NotFoundError('validator', params.data.idOrVote);
      }

      // HEAD short-circuit AFTER the existence checks (so HEAD still
      // returns the right 404 for unclaimed/opted-out) but BEFORE
      // the multi-query scoring work. The handler resolves `void`
      // here (the reply is already sent) — the
      // `Promise<OaiResponse | void>` return type makes that honest
      // without an `as unknown as OaiResponse` cast.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', OAI_CACHE_CONTROL).send('');
        return;
      }

      // Governance — only counts comments from the validator's
      // ACTIVE-linked GitHub username (expired attestations excluded).
      const githubLink = await opts.validatorGithubRepo.findActiveByVote(validator.votePubkey);
      let governanceInput = { commentCount: 0, reactionsReceived: 0, activeWindowCount: 0 };
      if (githubLink !== null) {
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

      // Wallet — sum active days across all ACTIVE registered wallets
      // in a single batched query.
      const wallets = await opts.operatorWalletsRepo.listActiveByVote(validator.votePubkey);
      const walletPubkeys = wallets.map((w) => w.walletPubkey);
      const activityRows =
        walletPubkeys.length === 0
          ? []
          : await opts.walletActivityRepo.listRecentForWallets(walletPubkeys, 90);
      const activeDaysSet = new Set<string>();
      for (const r of activityRows) {
        if (r.txCount > 0) {
          activeDaysSet.add(r.activityDate.toISOString().slice(0, 10));
        }
      }
      const activeDaysLast90 = activeDaysSet.size;

      const oai = computeOperatorActivityIndex({
        governance: governanceInput,
        wallet: { activeDaysLast90 },
      });

      void reply.header('cache-control', OAI_CACHE_CONTROL);
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
      };
    },
  );
};

export default oaiRoutes;
