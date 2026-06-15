import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError } from '../../core/errors.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { OperatorWalletsRepository } from '../../storage/repositories/operator-wallets.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { SimdDiscussionsRepository } from '../../storage/repositories/simd-discussions.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { TierSnapshotsRepository } from '../../storage/repositories/tier-snapshots.repo.js';
import type { ValidatorGithubRepository } from '../../storage/repositories/validator-github.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { WalletActivityRepository } from '../../storage/repositories/wallet-activity.repo.js';
import { cacheControl } from '../cache-control.js';
import { VoteOrIdentityParamSchema } from '../schemas/requests.js';
import { unwrap } from '../zod-helpers.js';
import {
  type BadgesResponse,
  type TierBody,
  findValidatorByVoteOrIdentity,
  resolveTierForValidator,
  tenureClientBlocks,
  tierBodyFromResolved,
  trendFromSnapshots,
} from './validators.route.js';
import { type OaiComponents, resolveOaiForValidator } from './operator-activity-index.route.js';

/**
 * REST-M8 — `/scoring` aggregate endpoint deps.
 *
 * The union of the validators-route deps (validatorsRepo, statsRepo,
 * epochsRepo — what the tier + tenure/client blocks need) AND the
 * OAI-route deps (claimsRepo, profilesRepo, validatorGithubRepo,
 * operatorWalletsRepo, walletActivityRepo, simdDiscussionsRepo). Kept
 * as its OWN interface rather than widening `ValidatorsRoutesDeps`
 * with the OAI repos — `/tier` and `/badges` have no business
 * carrying the governance/wallet repos in their dependency surface.
 */
export interface ScoringRoutesDeps {
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  statsRepo: Pick<
    StatsRepository,
    'findHistoryByVote' | 'findEconomicPercentile' | 'findEconomicCohortVotes'
  >;
  epochsRepo: Pick<EpochsRepository, 'findCurrent'>;
  claimsRepo: Pick<ClaimsRepository, 'findByVote'>;
  profilesRepo: Pick<ProfilesRepository, 'findOptedOutVotes'>;
  validatorGithubRepo: Pick<ValidatorGithubRepository, 'findActiveByVote'>;
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listActiveByVote'>;
  walletActivityRepo: Pick<WalletActivityRepository, 'listRecentForWallets' | 'hasAnyFeeData'>;
  simdDiscussionsRepo: Pick<SimdDiscussionsRepository, 'statsByUsername' | 'hasAnyData'>;
  /**
   * Per-(epoch, vote) tier snapshots (migration 0045). Optional — when
   * unwired the nested `tier.trend` degrades to `null`. Drives the tier
   * trend delta embedded in the aggregate `tier` block (the separate
   * `/tier/history` endpoint is not part of this aggregate).
   */
  tierSnapshotsRepo?: Pick<TierSnapshotsRepository, 'findLatestTwo'>;
}

/**
 * The `/scoring` aggregate response. A UNION of the three sibling
 * endpoints' payloads with NO duplication:
 *   - `tier`   — the full `/tier` body (`window` + `tier` +
 *                `composite` + `components`), minus `vote` /
 *                `identity`.
 *   - `tenure` / `client` — the tenure + client blocks of `/badges`.
 *                The `/badges` payload ALSO nests a `tier` summary,
 *                but `/scoring` already carries the FULL tier object
 *                at top level, so the badges tier summary is
 *                deliberately dropped — it would be a strict subset
 *                of `tier` above.
 *   - `oai`    — the `/operator-activity-index` payload minus `vote`
 *                / `identity`, OR `null` when the validator is known
 *                but gated out of the OAI surface (unclaimed /
 *                identity-drift). `null` means "OAI not available for
 *                this validator", distinct from a broken endpoint.
 *                Opted-out validators are hidden by a route-level 404.
 */
interface ScoringResponse {
  vote: string;
  identity: string;
  tier: TierBody;
  tenure: BadgesResponse['tenure'];
  client: BadgesResponse['client'];
  oai: OaiComponents | null;
}

/**
 * GET /v1/validators/:idOrVote/scoring
 *
 * The profile-page "one round-trip" aggregate: a profile render
 * needs the Node Tier, the tenure/client badges, AND the Operator
 * Activity Index, and all three sibling endpoints repeat the same
 * `findByVote` + `findByIdentity` validator lookup. `/scoring` does
 * that lookup ONCE and returns all three.
 *
 * ADDITIVE — `/tier`, `/badges`, and `/operator-activity-index` all
 * stay live and unchanged. They were deferred-from-consolidation
 * originally to preserve their independent per-component CDN
 * caching; keeping them as granular routes preserves exactly that
 * for any consumer who wants one component, while `/scoring` serves
 * the profile-page case.
 *
 * Status codes:
 *   - 200 — validator is known and has not opted out. `tier` +
 *           `tenure` + `client` are always populated; `oai` is the
 *           OAI payload, OR `null` when the validator is known but
 *           unclaimed / identity-drifted (the OAI route 404s those
 *           cases — here they collapse to `oai: null` so the rest of
 *           the body still renders).
 *   - 400 — pubkey validation fails.
 *   - 404 — pubkey is unknown to the indexer OR the validator has
 *           opted out of public scoring surfaces.
 */
const scoringRoutes: FastifyPluginAsync<ScoringRoutesDeps> = async (
  app: FastifyInstance,
  opts: ScoringRoutesDeps,
) => {
  const { statsRepo, epochsRepo, validatorsRepo, tierSnapshotsRepo } = opts;

  // Return type is `ScoringResponse | void`: the GET path resolves
  // the structured body, the HEAD short-circuit calls
  // `reply.send('')` and resolves `void`. The union keeps the HEAD
  // path honest — no `as unknown as ScoringResponse` cast claiming
  // an empty string is a typed object (mirrors /tier + /badges).
  app.get(
    '/v1/validators/:idOrVote/scoring',
    async (request, reply): Promise<ScoringResponse | void> => {
      const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameters');
      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }
      const optedOutVotes = await opts.profilesRepo.findOptedOutVotes();
      if (optedOutVotes.has(validator.votePubkey)) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      // HEAD short-circuit AFTER the existence + opt-out checks (so
      // HEAD still returns the right 404 for unknown or opted-out
      // pubkeys) but BEFORE the
      // tier history read + OAI repo fan-out a HEAD response would
      // throw away. The handler resolves `void` here — the
      // `Promise<ScoringResponse | void>` return type makes that
      // honest without an `as unknown as ScoringResponse` cast.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', cacheControl('SCORING')).send('');
        return;
      }

      // Tier resolution and OAI resolution are independent given the
      // already-resolved validator, so run them concurrently. Each
      // is the SAME shared helper the granular route uses —
      // `resolveTierForValidator` (also drives /tier + /badges) and
      // `resolveOaiForValidator` (also drives the OAI route) — so
      // `/scoring` can't drift from the granular endpoints.
      //
      // `resolveTierForValidator` itself fetches the current epoch
      // (for closed-epoch windowing); we fetch it AGAIN here for the
      // tenure summary. That's one extra `findCurrent` read — the
      // same two-read shape `/badges` already has — kept rather than
      // threading the epoch out of the tier resolver, which would
      // leak the resolver's internals across the helper boundary.
      const [resolvedTier, currentEpoch, oai, latestTwoSnapshots] = await Promise.all([
        resolveTierForValidator(statsRepo, epochsRepo, validator.votePubkey),
        epochsRepo.findCurrent(),
        resolveOaiForValidator(opts, validator),
        tierSnapshotsRepo?.findLatestTwo(validator.votePubkey) ?? Promise.resolve([]),
      ]);

      const { tenure, client } = tenureClientBlocks(validator, currentEpoch);

      // Layer the tier trend onto the nested tier body — same helper +
      // shape as the granular `/tier` endpoint so the two can't drift.
      // The separate `/tier/history` endpoint is NOT part of this
      // aggregate (it's a list, not a per-render summary).
      const tier = tierBodyFromResolved(resolvedTier, validator);
      tier.trend = trendFromSnapshots(
        tier.composite,
        latestTwoSnapshots,
        latestTwoSnapshots.length,
      );

      // SCORING cache tier. `/scoring` BUNDLES the OAI — the
      // shortest-lived of the three components in freshness terms —
      // so the whole aggregate caches at the SCORING tier (5 min
      // client / 30 min CDN), which is also what the OAI route
      // itself uses. A consumer that wants the (notionally) longer-
      // lived tier/badges caching should hit `/tier` or `/badges`
      // directly; today all three happen to share the SCORING tier
      // anyway, but `/scoring` pins to it on PURPOSE so a future
      // tier/badges cache bump doesn't silently over-cache the OAI
      // half here.
      void reply.header('cache-control', cacheControl('SCORING'));
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        tier,
        tenure,
        client,
        // `null` when the validator is gated out of the OAI surface
        // (unclaimed / identity-drift) — see `resolveOaiForValidator`.
        // Opted-out validators are hidden by the route-level 404 above.
        oai,
      };
    },
  );
};

export default scoringRoutes;
