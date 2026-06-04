import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError } from '../../core/errors.js';
import { LAMPORTS_PER_SOL } from '../../core/lamports.js';
import { normaliseHttpUrlOrNull } from '../../core/url.js';
import type { ValidatorService } from '../../services/validator.service.js';
import type { AggregatesRepository } from '../../storage/repositories/aggregates.repo.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProcessedBlocksRepository } from '../../storage/repositories/processed-blocks.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../../storage/repositories/watched-dynamic.repo.js';
import type {
  EpochAggregate,
  EpochInfo,
  EpochPeerBenchmark,
  ValidatorCurrentEpochResponse,
} from '../../types/domain.js';
import { cacheControl } from '../cache-control.js';
import { setNoStoreCache } from '../cache-headers.js';
import { validatorDynamicWatchAttemptsTotal } from '../metrics.js';
import { HistoryQuerySchema, VoteOrIdentityParamSchema } from '../schemas/requests.js';
import { serializeValidator } from '../serializers/validator-response.js';
import { unwrap } from '../zod-helpers.js';

/**
 * Sample size used when joining the cluster benchmark onto history rows.
 * Matches the `topN` the aggregates-computer job writes at (top-100 by
 * activated stake). If we ever offer multiple samples, widen this to a
 * query parameter.
 */
const DEFAULT_CLUSTER_TOP_N = 100;
const DYNAMIC_WATCH_MIN_ACTIVATED_STAKE_LAMPORTS = LAMPORTS_PER_SOL;

export interface ValidatorsHistoryRoutesDeps {
  statsRepo: Pick<StatsRepository, 'findHistoryByVote' | 'findIndexedIncomePerSlotBenchmarks'>;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  epochsRepo: Pick<EpochsRepository, 'findByEpoch' | 'findCurrent'>;
  aggregatesRepo: Pick<AggregatesRepository, 'findManyByEpochsTopN'>;
  /**
   * Compute-unit aggregator. Powers the per-epoch
   * `avgComputeUnitsPerProducedBlock` (this validator), `serviceAverageCu`
   * (all tracked validators — NOT the whole cluster; `processed_blocks`
   * only covers tracked validators' leader slots), and `sameClientAverageCu`
   * (tracked validators sharing this one's client) fields on the history
   * response — the income-page CU chart's three series. All derived from
   * `processed_blocks`; no new ingestion path.
   */
  processedBlocksRepo: Pick<
    ProcessedBlocksRepository,
    | 'getEpochComputeUnitsByVote'
    | 'getEpochComputeUnitsServiceWide'
    | 'getEpochComputeUnitsByClient'
  >;
  watchedDynamicRepo: Pick<WatchedDynamicRepository, 'touchLookup' | 'add'>;
  validatorService: Pick<ValidatorService, 'trackOnDemand' | 'ensureActivatedStakeLamports'>;
  /**
   * Phase 3 profile decoration. When present, the response merges
   * `twitter_handle` + `hide_footer_cta` + `opted_out` onto the top-
   * level response body so the income page renders them without a
   * separate round-trip. Optional — test harnesses and legacy
   * callers can omit and get null values back.
   */
  profilesRepo?: Pick<ProfilesRepository, 'findByVote'>;
  /**
   * Phase 3 claim lookup — surfaces a `claimed: boolean` flag on the
   * response so the income page can render the same "verified"
   * badge the leaderboard does. Distinct from `profile`: a
   * validator can be claimed but never have edited their profile
   * (state B), and the badge should still render in that case.
   */
  claimsRepo?: Pick<ClaimsRepository, 'findByVote'>;
}

/**
 * Phase 3 profile block surfaced on the history response. Present
 * with the operator-edited values when a profile row exists, else
 * absent — the UI treats missing as "no overrides set".
 *
 * `optedOut: true` is handled specially at the route level: we
 * return a stub instead of the full stats so the operator's opt-out
 * is respected even for direct-link hits.
 */
interface ProfileBlock {
  twitterHandle: string | null;
  hideFooterCta: boolean;
  optedOut: boolean;
  narrativeOverride: string | null;
}

interface HistoryResponse {
  vote: string;
  identity: string;
  /**
   * On-chain validator moniker (from `solana validator-info publish`).
   * Null when the validator has no info record, or the info-refresh
   * job hasn't run against this identity yet. `iconUrl` and `website`
   * mirror the same source for UI convenience.
   */
  name: string | null;
  iconUrl: string | null;
  website: string | null;
  items: ValidatorCurrentEpochResponse[];
  /**
   * Set to `true` when this response came from an auto-track on a
   * previously-unknown pubkey. `items` will be empty; the UI uses
   * this flag to render a "tracking started, data appears shortly"
   * state instead of a hard empty state.
   */
  tracking?: boolean;
  trackingMessage?: string;
  /**
   * Phase 3 operator-edited decoration. Absent when the validator
   * has no profile row (never claimed OR claimed but never edited).
   */
  profile?: ProfileBlock;
  /**
   * Phase 3: `true` when this validator's operator has gone through
   * the Ed25519 claim flow at least once. Independent from `profile`
   * presence — claim row can exist without a profile row (state B).
   * Used by the UI to render the "verified" badge.
   */
  claimed: boolean;
}

function synthEpochInfo(epoch: number): EpochInfo {
  return {
    epoch,
    firstSlot: 0,
    lastSlot: 0,
    slotCount: 0,
    currentSlot: null,
    isClosed: true,
    observedAt: new Date(0),
    closedAt: null,
  };
}

/**
 * GET /v1/validators/:idOrVote/history?limit=N
 *
 * Returns the most recent N epochs of stats for the validator. Accepts
 * either a vote pubkey or an identity pubkey in the path parameter —
 * identity is looked up against the `validators` table. The UI income
 * page renders the history table directly from this response.
 */
const validatorsHistoryRoutes: FastifyPluginAsync<ValidatorsHistoryRoutesDeps> = async (
  app: FastifyInstance,
  opts: ValidatorsHistoryRoutesDeps,
) => {
  const {
    statsRepo,
    validatorsRepo,
    epochsRepo,
    aggregatesRepo,
    processedBlocksRepo,
    watchedDynamicRepo,
    validatorService,
    profilesRepo,
    claimsRepo,
  } = opts;
  const serialCtx = {};

  app.get('/v1/validators/:idOrVote/history', async (request, reply): Promise<HistoryResponse> => {
    const params = unwrap(VoteOrIdentityParamSchema.safeParse(request.params), 'path parameter');
    const query = unwrap(HistoryQuerySchema.safeParse(request.query), 'query parameter');

    // Try vote first, then fall back to identity. Both paths resolve to
    // the `validators` row — we need its vote/identity pair to call the
    // stats repo and to include both in the response.
    let validator = await validatorsRepo.findByVote(params.idOrVote);
    if (validator === null) {
      validator = await validatorsRepo.findByIdentity(params.idOrVote);
    }

    // Unknown pubkey → attempt auto-track. Resolves via RPC, enforces
    // the stake floor (`assessClaimEligibility`-grade policy), upserts
    // the validator, and registers it into the dynamic watched set so
    // the fee-ingester picks it up on the next tick. Returns an empty
    // history with `tracking: true` so the UI can render a "tracking
    // now" state — no retry-loop required.
    if (validator === null) {
      const result = await validatorService.trackOnDemand(params.idOrVote);
      if (!result.ok) {
        throw new NotFoundError('validator', `${params.idOrVote}: ${result.reason}`);
      }
      // Freshly-tracked validator — no info record has been fetched
      // yet (that happens on the next validator-info-refresh tick).
      // UI falls back to pubkey display.
      setNoStoreCache(reply);
      return {
        vote: result.votePubkey,
        identity: result.identityPubkey,
        name: null,
        iconUrl: null,
        website: null,
        items: [],
        tracking: true,
        trackingMessage: result.newlyTracked
          ? 'Tracking started. First data point appears after the next fee-ingester tick (≤ 1 minute).'
          : 'Already tracking — data is accumulating. Refresh in a few minutes.',
        // Just-tracked validators are by definition unclaimed.
        claimed: false,
      };
    }

    // Known validator path: bump the dynamic-watched lookup counter if
    // this pubkey happens to live in the dynamic set (harmless no-op
    // for config-watched validators). Fire-and-forget so the response
    // isn't slowed by bookkeeping.
    void watchedDynamicRepo.touchLookup(validator.votePubkey);

    // Known-validator dynamic-watch ensure. The API process's
    // ValidatorService cache is never primed by the periodic refresh job
    // (that's worker-only), so `ensureActivatedStakeLamports` lazily
    // populates it via one throttled, in-flight-deduped RPC on cache miss.
    // The discriminated return tells us why we either added or skipped.
    //
    // Before this change (pre PR #25 + #26), nearly every direct hit took
    // the unknown path through `trackOnDemand`, which had its own refresh.
    // The bulk-info-ingester (PR #25) flipped ~554 validators to the known
    // path and exposed a permanent cache miss in the API process — the
    // route silently skipped registration, so the fee-ingester never picked
    // them up.
    const ensured = await validatorService.ensureActivatedStakeLamports(validator.votePubkey);
    const baseLog = {
      event: 'ensure_watched_dynamic',
      source: 'validators-history.known-path',
      vote: validator.votePubkey,
      identity: validator.identityPubkey,
    };

    if (ensured.source === 'refresh-failed') {
      validatorDynamicWatchAttemptsTotal.inc({ outcome: 'refresh_failed' });
      request.log.warn(
        { ...baseLog, outcome: 'refresh_failed', err: ensured.error },
        'ensure-watched-dynamic: lazy refresh failed; validator not registered this tick',
      );
    } else if (ensured.source === 'unknown-vote') {
      // DB has the row, RPC dropped it. Skip silently — no counter, no log.
      // Re-tries are bounded by the success cooldown inside the service.
    } else if (ensured.lamports < DYNAMIC_WATCH_MIN_ACTIVATED_STAKE_LAMPORTS) {
      validatorDynamicWatchAttemptsTotal.inc({ outcome: 'below_stake_floor' });
      request.log.debug(
        {
          ...baseLog,
          outcome: 'below_stake_floor',
          source_kind: ensured.source,
          activatedStakeLamports: ensured.lamports.toString(),
          floorLamports: DYNAMIC_WATCH_MIN_ACTIVATED_STAKE_LAMPORTS.toString(),
        },
        'ensure-watched-dynamic: stake below floor; intentional skip',
      );
    } else {
      const stake = ensured.lamports;
      const wasColdMiss = ensured.source === 'refresh';
      void watchedDynamicRepo
        .add({ votePubkey: validator.votePubkey, activatedStakeLamportsAtAdd: stake })
        .then(() => {
          if (wasColdMiss) {
            validatorDynamicWatchAttemptsTotal.inc({ outcome: 'cold_miss_refreshed' });
            request.log.info(
              {
                ...baseLog,
                outcome: 'cold_miss_refreshed',
                activatedStakeLamports: stake.toString(),
              },
              'ensure-watched-dynamic: cold cache miss lazily filled; validator registered',
            );
          }
          // cache-hit + add success path stays log-quiet (SCORING-tier traffic).
        })
        .catch((err: unknown) => {
          validatorDynamicWatchAttemptsTotal.inc({ outcome: 'db_add_failed' });
          const pgCode = (err as { code?: string } | null)?.code;
          const fields = {
            ...baseLog,
            outcome: 'db_add_failed',
            pgCode,
            activatedStakeLamports: stake.toString(),
            err,
          };
          if (pgCode === '23503') {
            // FK violation: validators row vanished between findByVote() above
            // and this add(). That's a hard consistency bug — emit at error.
            request.log.error(
              fields,
              'ensure-watched-dynamic: FK violation — validators row missing (consistency bug)',
            );
          } else {
            request.log.warn(
              fields,
              'ensure-watched-dynamic: dynamic-watch upsert failed (non-fatal)',
            );
          }
        });
    }

    // Phase 3: pull the validator's profile + claim in parallel with
    // history. If the operator has opted out, the short-circuit
    // below returns a stub — so we ALWAYS need the profile lookup.
    // The claim lookup gives us the `claimed: boolean` flag the
    // income page uses for the verified badge.
    const profilePromise =
      profilesRepo === undefined
        ? Promise.resolve(null)
        : profilesRepo.findByVote(validator.votePubkey);
    const claimPromise =
      claimsRepo === undefined
        ? Promise.resolve(null)
        : claimsRepo.findByVote(validator.votePubkey);

    const [rows, profile, claim] = await Promise.all([
      statsRepo.findHistoryByVote(validator.votePubkey, query.limit),
      profilePromise,
      claimPromise,
    ]);
    const claimed = claim !== null;

    // Respect opt-out on direct hits. We return identity info (so
    // bookmarks don't 404 mid-session) but strip the history items
    // and surface `profile.optedOut = true` so the UI renders the
    // appropriate empty-state copy. Metadata (name/icon/website)
    // is blanked too — we're not going to advertise a validator
    // that asked not to be advertised, even if their on-chain
    // validator-info publish is public.
    if (profile !== null && profile.optedOut) {
      setNoStoreCache(reply);
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        name: null,
        iconUrl: null,
        website: null,
        items: [],
        profile: {
          twitterHandle: null,
          hideFooterCta: false,
          optedOut: true,
          narrativeOverride: null,
        },
        // Opted-out validators are by definition claimed (you have
        // to claim before you can edit a profile, and `optedOut`
        // is a profile field).
        claimed: true,
      };
    }

    // For each row, determine whether the epoch is closed (needed by
    // the serializer to set isFinal/isCurrentEpoch) and fetch the
    // benchmark blocks. Both are bulk-fetched by distinct epoch to keep
    // the round-trip count at O(1) per response regardless of `limit`.
    const distinctEpochs = Array.from(new Set(rows.map((r) => r.epoch)));
    // Same-client cohort key: this validator's current client, unless
    // unclassified ('unknown') — pooling all "unknown" validators would
    // be a meaningless cohort, so pass null and the same-client series
    // simply doesn't render.
    const targetClientKind =
      validator.clientKind && validator.clientKind !== 'unknown' ? validator.clientKind : null;
    const [epochInfos, aggregates, validatorCuByEpoch, serviceCuByEpoch, sameClientCuByEpoch] =
      await Promise.all([
        Promise.all(distinctEpochs.map((e) => epochsRepo.findByEpoch(e))),
        aggregatesRepo.findManyByEpochsTopN(distinctEpochs, DEFAULT_CLUSTER_TOP_N),
        // Per-epoch validator CU, keyed by VOTE. The repo resolves the
        // set of identity keys the vote ran across `distinctEpochs`, so
        // an epoch produced under two identities (a mid-epoch identity
        // rotation) — or a window spanning an ordinary cross-epoch
        // rotation — folds every block, not just the one identity a
        // given history row happens to carry.
        processedBlocksRepo.getEpochComputeUnitsByVote(validator.votePubkey, distinctEpochs),
        // Service-wide average it is plotted against — keyed by epoch;
        // absent / zero-produced-block epochs collapse to `null`.
        processedBlocksRepo.getEpochComputeUnitsServiceWide(distinctEpochs),
        // Same-client average — the subset of tracked validators running
        // `targetClientKind`. Empty map when the target client is unknown.
        processedBlocksRepo.getEpochComputeUnitsByClient(distinctEpochs, targetClientKind),
      ]);
    const epochByNumber = new Map<number, EpochInfo>();
    distinctEpochs.forEach((e, i) => {
      const info = epochInfos[i];
      epochByNumber.set(e, info ?? synthEpochInfo(e));
    });
    const aggregateByEpoch = new Map<number, EpochAggregate>(aggregates.map((a) => [a.epoch, a]));
    const peerBenchmarks = await statsRepo.findIndexedIncomePerSlotBenchmarks(
      distinctEpochs.map((epoch) => ({
        epoch,
        isCurrent: !(epochByNumber.get(epoch) ?? synthEpochInfo(epoch)).isClosed,
      })),
      targetClientKind,
    );
    const peerBenchmarkByEpoch = new Map<number, EpochPeerBenchmark>(
      peerBenchmarks.map((b) => [b.epoch, b]),
    );

    const items = rows.map((row) => {
      const info = epochByNumber.get(row.epoch) ?? synthEpochInfo(row.epoch);
      const aggregate = aggregateByEpoch.get(row.epoch) ?? null;
      const peerBenchmark = peerBenchmarkByEpoch.get(row.epoch) ?? null;
      const computeUnits = {
        validator: validatorCuByEpoch.get(row.epoch) ?? null,
        serviceAverage: serviceCuByEpoch.get(row.epoch) ?? null,
        sameClient: sameClientCuByEpoch.get(row.epoch) ?? null,
      };
      return serializeValidator(row, info, serialCtx, aggregate, peerBenchmark, computeUnits);
    });

    // Moniker comes straight off the `validators` row the lookup
    // returned — no extra query. `validatorsRepo.findByVote/Identity`
    // now includes the info columns, so we just plumb them through.
    // Profile block (Phase 3) is attached when present so the UI
    // can show the operator's Twitter link and honour the footer
    // mute. Absent = never-claimed OR claimed-but-never-edited —
    // UI treats both identically (no overrides).
    //
    // Cache: SCORING tier (5min client / 30min CDN). The running-
    // epoch row inside `items` does flux, but at minute-grain the
    // delta is dominated by fee-ingester ticks every ~30s; SCORING
    // tolerates that without staling the CDN-cached value beyond
    // freshness budget. The hub `/v/[vote]` SSR (PR3) and income
    // page both fetch this; without a cache header every leaderboard
    // click-through was hitting Postgres with a 30-row scan + peer-
    // benchmark fan-out.
    void reply.header('cache-control', cacheControl('SCORING'));
    return {
      vote: validator.votePubkey,
      identity: validator.identityPubkey,
      name: validator.name,
      iconUrl: normaliseHttpUrlOrNull(validator.iconUrl),
      website: normaliseHttpUrlOrNull(validator.website),
      items,
      claimed,
      ...(profile !== null
        ? {
            profile: {
              twitterHandle: profile.twitterHandle,
              hideFooterCta: profile.hideFooterCta,
              optedOut: profile.optedOut,
              narrativeOverride: profile.narrativeOverride,
            },
          }
        : {}),
    };
  });
};

export default validatorsHistoryRoutes;
