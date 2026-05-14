import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError, NotFoundError, ValidationError } from '../../core/errors.js';
import { normaliseHttpUrlOrNull } from '../../core/url.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
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
import {
  computeTier,
  tierInputFromHistory,
  WINDOW_CLOSED_EPOCHS,
  WINDOW_FETCH_ROWS,
} from '../../services/node-tier.js';
import { narrowToDocumentedKind } from '../../services/client-kind.js';
import { summariseTenure } from '../../services/tenure.js';

export interface ValidatorsRoutesDeps {
  statsRepo: Pick<
    StatsRepository,
    'findByVoteEpoch' | 'findManyByVotesCurrentEpoch' | 'findManyByVotesEpoch' | 'findHistoryByVote'
  >;
  validatorsRepo: Pick<
    ValidatorsRepository,
    'findByVote' | 'findByIdentity' | 'findManyByVotes' | 'searchByText'
  >;
  epochsRepo: Pick<EpochsRepository, 'findCurrent' | 'findByEpoch'>;
  profilesRepo: Pick<ProfilesRepository, 'findOptedOutVotes'>;
  claimsRepo?: Pick<ClaimsRepository, 'findClaimedVotes'>;
}

interface BatchResponse {
  epoch: number;
  results: ValidatorCurrentEpochResponse[];
  missing: string[];
}

const SearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(96),
  limit: z
    .preprocess((value) => value ?? 10, z.coerce.number().int())
    .transform((value) => Math.min(25, Math.max(1, value))),
});

interface ValidatorSearchResponse {
  query: string;
  limit: number;
  count: number;
  items: Array<{
    vote: string;
    identity: string;
    name: string | null;
    iconUrl: string | null;
    website: string | null;
    claimed: boolean;
  }>;
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
  const { statsRepo, validatorsRepo, epochsRepo, profilesRepo, claimsRepo } = opts;
  const serialCtx = {};

  app.get('/v1/validators/search', async (request, _reply): Promise<ValidatorSearchResponse> => {
    const query = unwrap(SearchQuerySchema.safeParse(request.query), 'query parameter');
    const optedOutVotes = await profilesRepo.findOptedOutVotes();
    const rows = await validatorsRepo.searchByText(query.q, query.limit, optedOutVotes);
    const claimedVotes =
      claimsRepo === undefined || rows.length === 0
        ? new Set<string>()
        : await claimsRepo.findClaimedVotes(rows.map((r) => r.votePubkey));

    return {
      query: query.q,
      limit: query.limit,
      count: rows.length,
      items: rows.map((row) => ({
        vote: row.votePubkey,
        identity: row.identityPubkey,
        name: row.name,
        iconUrl: normaliseHttpUrlOrNull(row.iconUrl),
        website: normaliseHttpUrlOrNull(row.website),
        claimed: claimedVotes.has(row.votePubkey),
      })),
    };
  });

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

  /**
   * GET /v1/validators/:idOrVote/tier
   *
   * Returns the validator's Node Tier (forge / anvil / hearth /
   * kindling / unrated) derived from the most recent 5 CLOSED
   * epochs — the running epoch is skipped because its slot/credit
   * counters grow during the response cache window and would make
   * a tier ride the running-epoch values.
   *
   * Two-signal P1 composite: 0.6 × TVC ratio + 0.4 × (1 − Wilson
   * lower bound on skip rate). Full four-signal composite (with vote-
   * latency p99 + congestion CU) is documented in `docs/scoring.md`
   * and shipping in a later phase once the underlying signals are
   * indexed.
   *
   * Confidence floor: returns `tier: "unrated"` when the validator
   * has < 10 leader slots in the window, irrespective of the
   * computed composite.
   */
  app.get('/v1/validators/:idOrVote/tier', async (request, reply): Promise<NodeTierResponse> => {
    const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameters');
    const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
    if (validator === null) {
      throw new NotFoundError('validator', params.idOrVote);
    }
    // Identify closed rows explicitly rather than assuming `history[0]`
    // is the running epoch. A validator outside the current leader
    // schedule may have its newest history row pointing at a CLOSED
    // epoch, in which case the previous "skip row 0" rule silently
    // discarded a legitimate closed-epoch row from the window.
    const [history, currentEpoch] = await Promise.all([
      statsRepo.findHistoryByVote(validator.votePubkey, WINDOW_FETCH_ROWS),
      epochsRepo.findCurrent(),
    ]);
    const closedRows =
      currentEpoch !== null
        ? history.filter((r) => r.epoch < currentEpoch.epoch).slice(0, WINDOW_CLOSED_EPOCHS)
        : history.slice(0, WINDOW_CLOSED_EPOCHS);
    const input = tierInputFromHistory(validator.votePubkey, closedRows);
    const result = computeTier(input);
    // Surface the staleness of the oldest credit timestamp so a UI
    // can grey out the tier when ingestion has stalled. `null` when
    // the window has no credit-bearing rows.
    const voteCreditsUpdatedAt = closedRows
      .map((r) => r.voteCreditsUpdatedAt)
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>((oldest, cur) => (oldest === null || cur < oldest ? cur : oldest), null);

    void reply.header(
      'cache-control',
      `public, max-age=${TIER_CACHE_MAX_AGE_SEC}, s-maxage=${TIER_CACHE_S_MAXAGE_SEC}`,
    );
    return {
      vote: validator.votePubkey,
      identity: validator.identityPubkey,
      window: {
        epochs: closedRows.length,
        slotsAssigned: input.slotsAssigned,
        slotsSkipped: input.slotsSkipped,
        voteCredits: input.voteCredits.toString(),
        maxCredits: input.maxCredits.toString(),
        voteCreditsUpdatedAt: voteCreditsUpdatedAt?.toISOString() ?? null,
      },
      tier: result.tier,
      composite: result.composite,
      components: {
        tvcRatio: result.components.tvcRatio,
        wilsonSkipRate: result.components.wilsonSkipRate,
      },
    };
  });

  /**
   * GET /v1/validators/:idOrVote/badges
   *
   * Composite profile-level badges. Combines:
   *   - Tenure (first_seen_epoch → landmark)
   *   - Client kind + version (from getClusterNodes ingestion)
   *   - Node Tier (same computation as /tier — included here so UI
   *     can render the full badge row in a single round-trip)
   *
   * Cached briefly so a hot profile page doesn't N+1 the DB on every
   * visitor — but not so long that a fresh claim / client upgrade
   * stalls invisibly.
   */
  // Return type is `BadgesResponse | void`: the GET path resolves the
  // structured body, the HEAD short-circuit calls `reply.send('')` and
  // resolves `void`. Declaring the union keeps the HEAD path honest —
  // no `as unknown as BadgesResponse` cast claiming an empty string is
  // a typed object.
  app.get(
    '/v1/validators/:idOrVote/badges',
    async (request, reply): Promise<BadgesResponse | void> => {
      const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameters');
      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }

      const [history, currentEpoch] = await Promise.all([
        statsRepo.findHistoryByVote(validator.votePubkey, WINDOW_FETCH_ROWS),
        epochsRepo.findCurrent(),
      ]);
      const closedRows =
        currentEpoch !== null
          ? history.filter((r) => r.epoch < currentEpoch.epoch).slice(0, WINDOW_CLOSED_EPOCHS)
          : history.slice(0, WINDOW_CLOSED_EPOCHS);
      const tierInput = tierInputFromHistory(validator.votePubkey, closedRows);
      const tierResult = computeTier(tierInput);

      const tenure = summariseTenure(
        validator.firstSeenEpoch,
        currentEpoch !== null ? currentEpoch.epoch : validator.lastSeenEpoch,
      );

      // Re-narrow the stored client kind to the documented enum at the
      // public boundary. The DB column is intentionally wide so a
      // future-extended classifier writes without a migration, but the
      // OpenAPI contract is the closed enum — any other value would
      // break strictly-typed SDK consumers.
      const clientKind = narrowToDocumentedKind(validator.clientKind);

      // HEAD short-circuit: after the existence check the route is
      // semantically valid, so return headers without paying the
      // serialisation cost a HEAD response will throw away. The
      // handler resolves `void` here (the reply is already sent) —
      // the `Promise<BadgesResponse | void>` return type makes that
      // honest without an `as unknown as BadgesResponse` cast.
      if (request.method === 'HEAD') {
        void reply
          .code(200)
          .header(
            'cache-control',
            `public, max-age=${BADGES_CACHE_MAX_AGE_SEC}, s-maxage=${BADGES_CACHE_S_MAXAGE_SEC}`,
          )
          .send('');
        return;
      }

      void reply.header(
        'cache-control',
        `public, max-age=${BADGES_CACHE_MAX_AGE_SEC}, s-maxage=${BADGES_CACHE_S_MAXAGE_SEC}`,
      );
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        tenure: {
          firstSeenEpoch: tenure.firstSeenEpoch,
          activeEpochs: tenure.activeEpochs,
          landmark: tenure.landmark,
          badge: tenure.badge,
        },
        client: {
          kind: clientKind,
          version: validator.clientVersion,
          updatedAt: validator.clientUpdatedAt?.toISOString() ?? null,
        },
        tier: {
          tier: tierResult.tier,
          composite: tierResult.composite,
          windowEpochs: closedRows.length,
        },
      };
    },
  );
};

const BADGES_CACHE_MAX_AGE_SEC = 300;
const BADGES_CACHE_S_MAXAGE_SEC = 1800;

interface BadgesResponse {
  vote: string;
  identity: string;
  tenure: {
    firstSeenEpoch: number;
    activeEpochs: number;
    landmark: string;
    badge: string;
  };
  client: {
    /** Classifier output: agave / jito_solana / firedancer / frankendancer / paladin / sig / unknown. */
    kind: string;
    /** Raw gossip-advertised version string, or null when never observed. */
    version: string | null;
    updatedAt: string | null;
  };
  tier: {
    tier: 'forge' | 'anvil' | 'hearth' | 'kindling' | 'unrated';
    composite: number | null;
    windowEpochs: number;
  };
}

// 5-minute browser cache, 1-hour CDN cache. Closed-epoch data updates
// only on epoch boundaries (~2 days), so even the 1 h CDN cache is
// conservative. Sized to absorb a viral share without N×validator
// DB hits per visitor.
const TIER_CACHE_MAX_AGE_SEC = 300;
const TIER_CACHE_S_MAXAGE_SEC = 3600;

interface NodeTierResponse {
  vote: string;
  identity: string;
  window: {
    epochs: number;
    slotsAssigned: number;
    slotsSkipped: number;
    voteCredits: string;
    maxCredits: string;
    /**
     * ISO-8601 timestamp of the OLDEST credit-row update in the
     * window. `null` when no credit-bearing rows are present (e.g.
     * the vote-credit indexer hasn't run yet for any closed epoch).
     * Lets UI detect ingestion staleness without polling a separate
     * health surface.
     */
    voteCreditsUpdatedAt: string | null;
  };
  tier: 'forge' | 'anvil' | 'hearth' | 'kindling' | 'unrated';
  /**
   * 0-100 composite. **`null` when `tier === 'unrated'`** so a UI
   * cannot accidentally display "composite: 87" alongside an
   * unrated classification.
   */
  composite: number | null;
  components: {
    tvcRatio: number;
    wilsonSkipRate: number;
  };
}

export default validatorsRoutes;
