import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError, NotFoundError } from '../../core/errors.js';
import { normaliseHttpUrlOrNull } from '../../core/url.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type {
  EpochInfo,
  EpochValidatorStats,
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
import { cacheControl } from '../cache-control.js';
import { unwrap } from '../zod-helpers.js';
import {
  computeTier,
  oldestIncomeFreshness,
  slotCountersFromHistory,
  WINDOW_CLOSED_EPOCHS,
  WINDOW_FETCH_ROWS,
} from '../../services/node-tier.js';
import type { NodeTier, TierInput, TierResult } from '../../services/node-tier.js';
import {
  EMPTY_ECONOMIC_LOOKUP,
  type EconomicPercentileLookup,
} from '../../storage/repositories/stats.repo.js';
import { findEconomicPercentileCached } from '../tier-cache.js';
import { narrowToDocumentedKind } from '../../services/client-kind.js';
import { summariseTenure } from '../../services/tenure.js';

export interface ValidatorsRoutesDeps {
  statsRepo: Pick<
    StatsRepository,
    | 'findByVoteEpoch'
    | 'findManyByVotesCurrentEpoch'
    | 'findManyByVotesEpoch'
    | 'findHistoryByVote'
    | 'findEconomicPercentile'
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

/**
 * Resolve a validator from a vote-OR-identity pubkey: try the vote
 * index first, fall back to the identity index. Shared by every
 * `:idOrVote` route here AND by `/scoring` (scoring.route.ts) so the
 * "vote first, then identity" lookup lives in exactly one place.
 */
export async function findValidatorByVoteOrIdentity(
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>,
  idOrVote: VotePubkey,
): Promise<Validator | null> {
  const byVote = await validatorsRepo.findByVote(idOrVote);
  if (byVote !== null) return byVote;
  return validatorsRepo.findByIdentity(idOrVote);
}

/**
 * Closed-epoch window bounds the economic-percentile cohort was
 * evaluated against. Surfaced on the response so a consumer can
 * cross-reference the tier with the leaderboard's current epoch and
 * detect drift between a CDN-cached tier and a fresh leaderboard.
 * `null` when the window had zero closed rows (no cohort to evaluate).
 */
export interface CohortAsOfEpoch {
  /** Oldest closed epoch in the window (inclusive). */
  fromEpoch: number;
  /** Newest closed epoch in the window (inclusive). */
  toEpoch: number;
}

/**
 * Shape returned by `resolveTierForValidator` — the computed tier plus
 * the closed-epoch rows it was derived from + the cohort context, so
 * a caller can also surface the window size and the income-freshness
 * timestamp without re-reading.
 */
export interface ResolvedTier {
  result: TierResult;
  input: TierInput;
  closedRows: EpochValidatorStats[];
  economicLookup: EconomicPercentileLookup;
  /**
   * Window bounds the percentile cohort was evaluated over. `null`
   * when `closedRows` was empty (no window to evaluate) — mirrors the
   * empty-lookup branch.
   */
  cohortAsOfEpoch: CohortAsOfEpoch | null;
}

/**
 * Fetch the validator's recent history, window it to the most recent
 * CLOSED epochs, look up its economic-productivity percentile against
 * the indexed cohort, and compute the Node Tier. Shared by `/tier` and
 * `/badges` and `/scoring` so the window logic + composite live in
 * exactly one place — a future fifth tier signal only needs touching
 * here.
 *
 * Closed rows are identified explicitly (`epoch < currentEpoch.epoch`)
 * rather than assuming `history[0]` is the running epoch: a validator
 * outside the current leader schedule may have its newest history row
 * pointing at a CLOSED epoch, which the old "skip row 0" rule silently
 * discarded from the window.
 *
 * The economic-percentile lookup is a separate cohort query (it ranks
 * THIS validator against every other indexed validator's median per-
 * slot income in the same window) so we run it concurrently with the
 * per-validator history fetch. When the window has zero closed rows
 * we skip the lookup entirely — there's no window to rank against —
 * and synthesise an empty cohort result that forces `unrated`.
 */
export async function resolveTierForValidator(
  statsRepo: Pick<StatsRepository, 'findHistoryByVote' | 'findEconomicPercentile'>,
  epochsRepo: Pick<EpochsRepository, 'findCurrent'>,
  votePubkey: VotePubkey,
): Promise<ResolvedTier> {
  const [history, currentEpoch] = await Promise.all([
    statsRepo.findHistoryByVote(votePubkey, WINDOW_FETCH_ROWS),
    epochsRepo.findCurrent(),
  ]);
  const closedRows =
    currentEpoch !== null
      ? history.filter((r) => r.epoch < currentEpoch.epoch).slice(0, WINDOW_CLOSED_EPOCHS)
      : history.slice(0, WINDOW_CLOSED_EPOCHS);

  // Determine the closed-epoch window bounds for the cohort query.
  // `closedRows` is sorted newest-first by the repo so [0] is the most
  // recent closed epoch and [last] is the oldest in the window.
  // When the validator has no closed history we use the canonical
  // empty lookup — `computeTier` then drops to `unrated` cleanly with
  // no DB round-trip.
  let economicLookup: EconomicPercentileLookup;
  let cohortAsOfEpoch: CohortAsOfEpoch | null;
  if (closedRows.length === 0) {
    economicLookup = EMPTY_ECONOMIC_LOOKUP;
    cohortAsOfEpoch = null;
  } else {
    const newest = closedRows[0] as EpochValidatorStats;
    const oldest = closedRows[closedRows.length - 1] as EpochValidatorStats;
    // In-process LRU memoization: the cohort CTE behind
    // `findEconomicPercentile` is identical for every validator in the
    // same window, so a 60s TTL deduplicates the hot-page burst (e.g.
    // a profile page + a leaderboard hover prefetch firing within a
    // second of each other against the same closed-epoch window).
    economicLookup = await findEconomicPercentileCached(
      statsRepo,
      votePubkey,
      oldest.epoch,
      newest.epoch,
    );
    cohortAsOfEpoch = { fromEpoch: oldest.epoch, toEpoch: newest.epoch };
  }

  const slotCounters = slotCountersFromHistory(closedRows);
  const input: TierInput = {
    votePubkey,
    slotsAssigned: slotCounters.slotsAssigned,
    slotsSkipped: slotCounters.slotsSkipped,
    economicPercentile: economicLookup.percentile,
    economicCohortSize: economicLookup.cohortSize,
    economicMeasuredEpochs: economicLookup.measuredEpochs,
  };
  const result = computeTier(input);
  return { result, input, closedRows, economicLookup, cohortAsOfEpoch };
}

/**
 * The `/tier` response body MINUS `vote` / `identity` — i.e. the
 * `{ window, tier, composite, components }` block. Built from a
 * `ResolvedTier` so `/tier` and `/scoring` produce a byte-identical
 * tier object from the exact same code (the only difference between
 * the two endpoints' tier data is that `/scoring` nests it under a
 * `tier` key and drops the top-level `vote` / `identity`).
 */
export type TierBody = Omit<NodeTierResponse, 'vote' | 'identity'>;

/**
 * Assemble the `/tier` body block from a resolved tier. The income-
 * freshness reduce + the window numerics live here so the two routes
 * serving this object can't drift.
 *
 * `economicMedianLamportsPerSlot` is surfaced as a stringified decimal
 * (lamports per slot) for the same reason the income endpoints
 * stringify lamport totals — JSON numeric precision is unsafe past
 * 2^53. Consumers that want SOL/slot can divide by 10^9 themselves.
 */
export function tierBodyFromResolved(resolved: ResolvedTier): TierBody {
  const { result, input, closedRows, economicLookup, cohortAsOfEpoch } = resolved;
  const incomeFreshness = oldestIncomeFreshness(closedRows);
  return {
    window: {
      epochs: closedRows.length,
      slotsAssigned: input.slotsAssigned,
      slotsSkipped: input.slotsSkipped,
      economicCohortSize: input.economicCohortSize,
      economicMeasuredEpochs: input.economicMeasuredEpochs,
      economicMedianLamportsPerSlot: economicLookup.medianIncomePerSlotLamports,
      incomeFreshness: incomeFreshness?.toISOString() ?? null,
      // Closed-epoch window bounds the cohort was evaluated over. A
      // consumer can compare these against the leaderboard's current
      // epoch to detect drift between a CDN-cached tier and a fresh
      // leaderboard. `null` when the window was empty (no closed
      // rows) and `computeTier` already produced `unrated`.
      cohortAsOfEpoch,
    },
    tier: result.tier,
    composite: result.composite,
    components: {
      reliability: result.components.reliability,
      economicPercentile: result.components.economicPercentile,
    },
  };
}

/**
 * The `tenure` + `client` blocks of the `/badges` response — the
 * part of `/badges` that ISN'T the tier (the badges tier is just a
 * summary of the full `/tier` object, which `/scoring` already
 * carries at top level, so `/scoring` reuses ONLY this helper for
 * the tenure/client halves and skips the badges tier summary
 * entirely — no duplication).
 *
 * Pure: takes the already-fetched validator + current epoch so the
 * caller owns the DB reads (badges + scoring fetch the current
 * epoch alongside their other concurrent work).
 */
export function tenureClientBlocks(
  validator: Validator,
  currentEpoch: EpochInfo | null,
): Pick<BadgesResponse, 'tenure' | 'client'> {
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
  return {
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
  };
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
   * epochs — the running epoch is skipped because its slot/income
   * counters grow during the response cache window and would make
   * a tier ride the running-epoch values.
   *
   * P1 composite: `0.3 × reliability + 0.7 × economicPercentile`.
   * `reliability` = `1 − wilsonInterval(slotsSkipped, slotsAssigned).upper`
   * (pessimistic block-production rate). `economicPercentile` =
   * `PERCENT_RANK()` of this validator's median per-leader-slot
   * income across the window, against the indexed-validator cohort.
   * Vote credits are deliberately excluded — see `docs/scoring.md`
   * Phase 1, "Why no vote credits."
   *
   * Confidence floors → `tier: "unrated"`: `slotsAssigned < 10`,
   * cohort size < 10, this validator measured in < 4 closed epochs,
   * or `economicPercentile === null`.
   *
   * Reliability floor: when `skip_rate > 0.20` the tier is hard-
   * capped at `kindling` regardless of economic percentile.
   */
  // Return type is `NodeTierResponse | void`: the GET path resolves
  // the structured body, the HEAD short-circuit calls `reply.send('')`
  // and resolves `void` — the union keeps the HEAD path honest with
  // no `as unknown as NodeTierResponse` cast (mirrors /badges).
  app.get(
    '/v1/validators/:idOrVote/tier',
    async (request, reply): Promise<NodeTierResponse | void> => {
      const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameters');
      const validator = await findValidatorByVoteOrIdentity(validatorsRepo, params.idOrVote);
      if (validator === null) {
        throw new NotFoundError('validator', params.idOrVote);
      }
      // HEAD short-circuit AFTER the existence check (so HEAD still
      // returns the right 404 for unknown pubkeys) but BEFORE the
      // history read + tier computation a HEAD response would throw
      // away. The handler resolves `void` here — the
      // `Promise<NodeTierResponse | void>` return type makes that
      // honest without an `as unknown as NodeTierResponse` cast.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', cacheControl('SCORING')).send('');
        return;
      }
      // History fetch + closed-epoch windowing + composite — shared
      // with /badges via `resolveTierForValidator`, and the body
      // assembly itself (window numerics + oldest-credit reduce)
      // shared with /scoring via `tierBodyFromResolved`, so neither
      // the window logic nor the response shape can drift.
      const resolved = await resolveTierForValidator(statsRepo, epochsRepo, validator.votePubkey);

      // SCORING tier — tier is derived purely from CLOSED-epoch rows,
      // so it only moves on an epoch boundary (~2 days); a few minutes
      // of client staleness is harmless. Shared with /badges (same
      // closed-epoch-derived data) and the OAI route via the named
      // tier in src/api/cache-control.ts — the previous hand-rolled
      // constants drifted (tier said s-maxage 3600, badges said 1800
      // for the same data class).
      void reply.header('cache-control', cacheControl('SCORING'));
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        ...tierBodyFromResolved(resolved),
      };
    },
  );

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

      // /badges also needs the current epoch for the tenure summary,
      // so fetch it alongside the shared tier resolution. The tier's
      // own closed-epoch windowing lives in `resolveTierForValidator`;
      // the tenure/client assembly lives in `tenureClientBlocks`
      // (shared with /scoring) so those blocks can't drift either.
      const [{ result: tierResult, closedRows }, currentEpoch] = await Promise.all([
        resolveTierForValidator(statsRepo, epochsRepo, validator.votePubkey),
        epochsRepo.findCurrent(),
      ]);

      // HEAD short-circuit: after the existence check the route is
      // semantically valid, so return headers without paying the
      // serialisation cost a HEAD response will throw away. The
      // handler resolves `void` here (the reply is already sent) —
      // the `Promise<BadgesResponse | void>` return type makes that
      // honest without an `as unknown as BadgesResponse` cast.
      if (request.method === 'HEAD') {
        void reply.code(200).header('cache-control', cacheControl('SCORING')).send('');
        return;
      }

      // SCORING tier — tenure + client + tier are all closed-epoch-
      // derived; see src/api/cache-control.ts. Shared with /tier so the
      // two routes serving the same data class can no longer drift.
      void reply.header('cache-control', cacheControl('SCORING'));
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        ...tenureClientBlocks(validator, currentEpoch),
        // The badges `tier` is a SUMMARY of the full /tier object
        // (just tier + composite + windowEpochs). /scoring carries
        // the FULL /tier object instead, so it deliberately does
        // NOT reuse this summary — see scoring.route.ts.
        tier: {
          tier: tierResult.tier,
          composite: tierResult.composite,
          windowEpochs: closedRows.length,
        },
      };
    },
  );
};

export interface BadgesResponse {
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
    tier: NodeTier;
    composite: number | null;
    windowEpochs: number;
  };
}

export interface NodeTierResponse {
  vote: string;
  identity: string;
  window: {
    epochs: number;
    slotsAssigned: number;
    slotsSkipped: number;
    /**
     * Size of the indexed-validator cohort the economic percentile
     * was computed against, in this window. Zero when no cohort
     * could be assembled (e.g. fresh DB with no income data yet).
     */
    economicCohortSize: number;
    /**
     * How many closed epochs in the window had measurable income
     * for THIS validator. Below
     * `MIN_MEASURED_EPOCHS_FOR_ECONOMIC` (4 of 5 by default) the
     * percentile is treated as null and the tier falls to
     * `unrated`.
     */
    economicMeasuredEpochs: number;
    /**
     * This validator's median income per leader slot across the
     * window, in lamports as a decimal-precision string. `null`
     * when no measurable income data exists for this validator in
     * the window. Stringified for the same reason income totals
     * are: lamport-scale numbers exceed JSON safe-integer range.
     */
    economicMedianLamportsPerSlot: string | null;
    /**
     * ISO-8601 timestamp of the OLDEST income-row update across
     * the window's closed epochs. `null` when no row in the window
     * has BOTH fees and tips ingested. Lets a UI grey out the tier
     * when the income ingester has stalled, without polling a
     * separate health surface.
     */
    incomeFreshness: string | null;
    /**
     * Closed-epoch window bounds the percentile cohort was evaluated
     * over (`fromEpoch` = oldest closed epoch in the window,
     * `toEpoch` = newest). `null` when the window has zero closed
     * rows (and the tier is `unrated`). Lets a consumer cross-
     * reference the response with the leaderboard's current epoch to
     * detect drift between a CDN-cached tier and a fresh leaderboard.
     */
    cohortAsOfEpoch: CohortAsOfEpoch | null;
  };
  tier: NodeTier;
  /**
   * 0-100 composite. **`null` when `tier === 'unrated'`** so a UI
   * cannot accidentally display "composite: 87" alongside an
   * unrated classification.
   */
  composite: number | null;
  components: {
    /**
     * 0-1, pessimistic block-production reliability — equals
     * `1 − Wilson(skipped, assigned).upper`. Always populated
     * (never null) because we always have slot counters; small-
     * sample validators get a sub-1.0 value rather than an
     * inflated 1.0.
     */
    reliability: number;
    /**
     * 0-1, percentile rank of this validator's median income per
     * leader slot vs the indexed cohort. **`null`** when the
     * cohort is too small or this validator had too few measured
     * epochs — and in that case `tier === 'unrated'`.
     */
    economicPercentile: number | null;
  };
}

export default validatorsRoutes;
