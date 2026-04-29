import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { ValidatorService } from '../../services/validator.service.js';
import type { AggregatesRepository } from '../../storage/repositories/aggregates.repo.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import type { EpochsRepository } from '../../storage/repositories/epochs.repo.js';
import type { ProfilesRepository } from '../../storage/repositories/profiles.repo.js';
import type { StatsRepository } from '../../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../../storage/repositories/watched-dynamic.repo.js';
import type {
  EpochAggregate,
  EpochInfo,
  ValidatorCurrentEpochResponse,
} from '../../types/domain.js';
import { HistoryQuerySchema, VoteOrIdentityParamSchema } from '../schemas/requests.js';
import { serializeValidator } from '../serializers/validator-response.js';

/**
 * Sample size used when joining the cluster benchmark onto history rows.
 * Matches the `topN` the aggregates-computer job writes at (top-100 by
 * activated stake). If we ever offer multiple samples, widen this to a
 * query parameter.
 */
const DEFAULT_CLUSTER_TOP_N = 100;

export interface ValidatorsHistoryRoutesDeps {
  statsRepo: Pick<StatsRepository, 'findHistoryByVote'>;
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  epochsRepo: Pick<EpochsRepository, 'findByEpoch' | 'findCurrent'>;
  aggregatesRepo: Pick<AggregatesRepository, 'findManyByEpochsTopN'>;
  watchedDynamicRepo: Pick<WatchedDynamicRepository, 'touchLookup'>;
  validatorService: Pick<ValidatorService, 'trackOnDemand'>;
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

function unwrap<T>(
  result: { success: true; data: T } | { success: false; error: unknown },
  context: string,
): T {
  if (result.success) return result.data;
  throw new ValidationError(`${context} failed validation`, {
    issues: (result.error as { issues?: unknown[] }).issues ?? [result.error],
  });
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
    watchedDynamicRepo,
    validatorService,
    profilesRepo,
    claimsRepo,
  } = opts;
  const serialCtx = {};

  app.get('/v1/validators/:idOrVote/history', async (request, _reply): Promise<HistoryResponse> => {
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

    // Validators can land in the `validators` table via
    // `refreshFromRpc` (which mirrors the entire cluster) WITHOUT
    // ever being registered in `watched_validators_dynamic`. If a
    // user visits /income/:vote for such a validator, the prior
    // flow only bumped touchLookup and returned empty history —
    // because the fee/slot ingester union (config ∪ dynamic) didn't
    // include this vote, stats never got written. Fire another
    // `trackOnDemand` to guarantee the watched set contains them.
    //
    // `trackOnDemand` is fully idempotent:
    //   - vote already in dynamic watched → `add` ON CONFLICT bumps
    //     lookup_count only (no-op stats-wise)
    //   - vote NOT in dynamic watched → inserts with stake-floor
    //     check and fires the moniker fetch
    //
    // Runs fire-and-forget so the user's history response isn't
    // gated on stake resolution or the moniker RPC roundtrip.
    void validatorService.trackOnDemand(validator.votePubkey).catch((err) => {
      request.log.warn(
        { err, vote: validator.votePubkey },
        'validators-history: ensure-watched trackOnDemand failed (non-fatal)',
      );
    });

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
    // the serializer to set isFinal/isCurrentEpoch) AND fetch the cluster
    // benchmark (used to render "% of cluster median" on the UI chart
    // and table). Both are bulk-fetched by distinct epoch to keep the
    // round-trip count at O(1) per response regardless of `limit`.
    const distinctEpochs = Array.from(new Set(rows.map((r) => r.epoch)));
    const [epochInfos, aggregates] = await Promise.all([
      Promise.all(distinctEpochs.map((e) => epochsRepo.findByEpoch(e))),
      aggregatesRepo.findManyByEpochsTopN(distinctEpochs, DEFAULT_CLUSTER_TOP_N),
    ]);
    const epochByNumber = new Map<number, EpochInfo>();
    distinctEpochs.forEach((e, i) => {
      const info = epochInfos[i];
      epochByNumber.set(e, info ?? synthEpochInfo(e));
    });
    const aggregateByEpoch = new Map<number, EpochAggregate>(aggregates.map((a) => [a.epoch, a]));

    const items = rows.map((row) => {
      const info = epochByNumber.get(row.epoch) ?? synthEpochInfo(row.epoch);
      const aggregate = aggregateByEpoch.get(row.epoch) ?? null;
      return serializeValidator(row, info, serialCtx, aggregate);
    });

    // Moniker comes straight off the `validators` row the lookup
    // returned — no extra query. `validatorsRepo.findByVote/Identity`
    // now includes the info columns, so we just plumb them through.
    // Profile block (Phase 3) is attached when present so the UI
    // can show the operator's Twitter link and honour the footer
    // mute. Absent = never-claimed OR claimed-but-never-edited —
    // UI treats both identically (no overrides).
    return {
      vote: validator.votePubkey,
      identity: validator.identityPubkey,
      name: validator.name,
      iconUrl: validator.iconUrl,
      website: validator.website,
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
