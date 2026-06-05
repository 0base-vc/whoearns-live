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
import type { Validator } from '../../types/domain.js';
import { cacheControl } from '../cache-control.js';
import { VoteOrIdentityParamSchema } from '../schemas/requests.js';
import { findValidatorByVoteOrIdentity } from '../validator-lookup.js';

export interface OaiRoutesDeps {
  validatorsRepo: Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'>;
  claimsRepo: Pick<ClaimsRepository, 'findByVote'>;
  profilesRepo: Pick<ProfilesRepository, 'findOptedOutVotes'>;
  validatorGithubRepo: Pick<ValidatorGithubRepository, 'findActiveByVote'>;
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listActiveByVote'>;
  walletActivityRepo: Pick<WalletActivityRepository, 'listRecentForWallets' | 'hasAnyFeeData'>;
  simdDiscussionsRepo: Pick<SimdDiscussionsRepository, 'statsByUsername' | 'hasAnyData'>;
}

/**
 * The OAI payload MINUS `vote` / `identity` — the validator-scoped
 * part `resolveOaiForValidator` computes. The route re-attaches
 * `vote` / `identity`; `/scoring` nests this under an `oai` key. The
 * full route response is `{ vote, identity } & OaiComponents`.
 */
export interface OaiComponents {
  // `null` when the governance half is unknowable (ingest inactive)
  // — an honest 50/50 blend can't be reported with one half missing.
  composite: number | null;
  components: {
    walletScore: number;
    governance: {
      // `null` while the GitHub Discussions ingest is inactive — "we
      // genuinely don't know yet", NOT 0. The sub-component counts
      // below stay as their real (currently all-0) values.
      score: number | null;
      commentCount: number;
      reactionsReceived: number;
      activeWindowCount: number;
    };
  };
  // Self-documents the Phase 6+7 partial release so a consumer can
  // tell a `null` score / composite apart from a broken endpoint.
  ingestStatus: {
    governanceIngestActive: boolean;
    walletFeesIngestActive: boolean;
  };
}

interface OaiResponse extends OaiComponents {
  vote: string;
  identity: string;
}

// SCORING tier — the OAI composite is derived from closed-epoch /
// closed-day signals + re-attestation state; minutes of staleness
// are harmless. Shared rationale: src/api/cache-control.ts.
const OAI_CACHE_CONTROL = cacheControl('SCORING');

/**
 * The OAI gate phase — claim presence, identity-drift, opt-out.
 * `true` = the validator is allowed onto the OAI surface, `false` =
 * gated out.
 *
 * Split out of `resolveOaiForValidator` so the OAI route's HEAD path
 * can run JUST these two cheap lookups (`claimsRepo.findByVote` +
 * `profilesRepo.findOptedOutVotes`) instead of the resolver's full
 * two-wave repo fan-out — preserving REST-M3's "a HEAD probe doesn't
 * pay the full DB cost" intent while still 404-ing a HEAD on a gated
 * validator. The resolver calls this first; a `false` there is its
 * `null` return.
 */
export async function passesOaiGates(
  deps: Pick<OaiRoutesDeps, 'claimsRepo' | 'profilesRepo'>,
  validator: Validator,
): Promise<boolean> {
  // Claim gate — no claim, no public scoring surface.
  const claim = await deps.claimsRepo.findByVote(validator.votePubkey);
  if (claim === null) return false;

  // Identity-drift gate — the claim binds a vote pubkey to the
  // identity pubkey that proved ownership. If the operator has since
  // rotated their on-chain identity (or the claim row is stale),
  // `validators.identityPubkey` no longer matches the claimed
  // identity, and the OAI would be serving scoring signal against an
  // identity that no longer controls the validator.
  if (validator.identityPubkey !== claim.identityPubkey) return false;

  // Opt-out gate — mirrors validators-history / leaderboard
  // suppression so a validator can self-remove from scoring surfaces
  // with one switch.
  const optedOut = await deps.profilesRepo.findOptedOutVotes();
  if (optedOut.has(validator.votePubkey)) return false;

  return true;
}

/**
 * Resolve the OAI components for an ALREADY-RESOLVED validator —
 * the claim / opt-out / identity-drift gates plus the two-wave repo
 * fan-out plus the `computeOperatorActivityIndex` call, in one place.
 *
 * Returns `null` when the validator is gated OUT of the OAI surface
 * — unclaimed, opted out, or its on-chain identity has drifted from
 * the claimed identity. `null` is "OAI not available for this
 * validator", NOT an error: the OAI route turns it into a 404 (so
 * unknown / unclaimed / opted-out / drift all collapse to one
 * status and the gate that fired stays unobservable), while
 * `/scoring` surfaces it as `oai: null` alongside the still-valid
 * tier + tenure + client blocks.
 *
 * The existence check (`findByVote` / `findByIdentity` → 404) stays
 * with each route's request handler — it's not a "gated out" case,
 * it's "this pubkey isn't a validator at all", and `/scoring` 404s
 * on it the same way `/tier` does.
 *
 * Extracted from the OAI route so `/scoring` reuses the exact same
 * gating + orchestration rather than copy-pasting it; the OAI
 * route's external behaviour is unchanged (it just `throw`s on
 * `null`).
 */
export async function resolveOaiForValidator(
  deps: Omit<OaiRoutesDeps, 'validatorsRepo'>,
  validator: Validator,
): Promise<OaiComponents | null> {
  // Gate phase — claim presence, identity-drift, opt-out. Extracted
  // into `passesOaiGates` so the OAI route's HEAD path can run JUST
  // these two cheap lookups without the two-wave fan-out below; a
  // `false` here is this resolver's `null` return (gated out —
  // unclaimed / opted-out / identity-drift, all indistinguishable to
  // the caller).
  if (!(await passesOaiGates(deps, validator))) {
    return null;
  }

  // DB-M6: the scoring work is a set of independent repo reads.
  // Wave 1 — the three reads with NO data dependency on each
  // other run concurrently:
  //   - `hasAnyData`: governance ingest liveness — true once
  //     `simd_discussion_comments` holds any row. The GitHub
  //     Discussions ingest job is unshipped, so this is `false`
  //     in every real deployment today; it drives BOTH the
  //     `governance.score`/`composite` null-out below AND the
  //     `ingestStatus.governanceIngestActive` flag (one query,
  //     one signal). Keyed on the table the score reads — not an
  //     `ingestion_cursors` job-name string — so it needs no
  //     coordination with the still-unwritten ingest job.
  //   - `findActiveByVote`: the validator's ACTIVE-linked GitHub
  //     username (expired attestations excluded).
  //   - `listActiveByVote`: the validator's ACTIVE registered
  //     wallets.
  const [governanceIngestActive, walletFeesIngestActive, githubLink, wallets] = await Promise.all([
    deps.simdDiscussionsRepo.hasAnyData(),
    // Wallet-fee backfill liveness — true once
    // `WalletFeeBackfillService` has produced any non-zero
    // `tx_fees_lamports` row. Same shape as `hasAnyData`: a
    // single-row EXISTS query, keyed on the table the read
    // consumers depend on (not an `ingestion_cursors` job-name
    // string), so it needs no coordination with the still-
    // possibly-disabled backfill job. Drives the
    // `ingestStatus.walletFeesIngestActive` flag the UI uses to
    // pick between tx-count and fee-anchored heatmap intensity.
    deps.walletActivityRepo.hasAnyFeeData(),
    deps.validatorGithubRepo.findActiveByVote(validator.votePubkey),
    deps.operatorWalletsRepo.listActiveByVote(validator.votePubkey),
  ]);

  // Wave 2 — the two reads that DEPEND on wave 1's results
  // (governance stats need the GitHub username; wallet activity
  // needs the wallet list). They're independent of EACH OTHER,
  // so they also run concurrently.
  const walletPubkeys = wallets.map((w) => w.walletPubkey);
  const [governanceStats, activityRows] = await Promise.all([
    // Governance — only counts comments from the validator's
    // ACTIVE-linked GitHub username.
    githubLink === null
      ? Promise.resolve([])
      : deps.simdDiscussionsRepo.statsByUsername([githubLink.githubUsername]),
    // Wallet — sum active days across all ACTIVE registered
    // wallets in a single batched query.
    walletPubkeys.length === 0
      ? Promise.resolve([])
      : deps.walletActivityRepo.listRecentForWallets(walletPubkeys, 90),
  ]);

  let governanceInput = { commentCount: 0, reactionsReceived: 0, activeWindowCount: 0 };
  const governanceRow = governanceStats[0];
  if (governanceRow !== undefined) {
    governanceInput = {
      commentCount: governanceRow.commentCount,
      reactionsReceived: governanceRow.reactionsReceived,
      activeWindowCount: governanceRow.activeWindowCount,
    };
  }

  const activeDaysSet = new Set<string>();
  for (const r of activityRows) {
    if (r.txCount > 0) {
      activeDaysSet.add(r.activityDate.toISOString().slice(0, 10));
    }
  }
  const activeDaysLast90 = activeDaysSet.size;

  // The service stays a pure input→output function: it always
  // computes a numeric `governance.score` + `composite` from the
  // pre-summed inputs. The route owns the partial-release honesty
  // — when the governance ingest is inactive its `score` is not a
  // real `0` but "unknown", so we null it out HERE (and with it
  // the 50/50 `composite`, which can't honestly blend a missing
  // half). `walletScore` and the governance sub-component counts
  // stay as the service computed them.
  const oai = computeOperatorActivityIndex({
    governance: governanceInput,
    wallet: { activeDaysLast90 },
  });
  const governanceScore = governanceIngestActive ? oai.governance.score : null;
  const composite = governanceScore === null ? null : oai.composite;

  return {
    composite,
    components: {
      walletScore: oai.walletScore,
      governance: {
        score: governanceScore,
        commentCount: oai.governance.components.commentCount,
        reactionsReceived: oai.governance.components.reactionsReceived,
        activeWindowCount: oai.governance.components.activeWindowCount,
      },
    },
    ingestStatus: {
      governanceIngestActive,
      // True once the Phase 4-extension `WalletFeeBackfillService`
      // has produced at least one non-zero `tx_fees_lamports` row
      // (see `wallet-activity.repo.ts#hasAnyFeeData`). When false
      // the column is structurally 0 everywhere and the UI heatmap
      // intensity stays bound to `tx_count`; when true the UI
      // switches to lamports/day intensity.
      walletFeesIngestActive,
    },
  };
}

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
 *
 * Partial-release honesty (CROSS-H1 / CROSS-H3): the GitHub
 * Discussions ingest that feeds the governance half is unshipped, so
 * `simd_discussion_comments` is empty in every real deployment. When
 * that ingest is inactive the route returns `governance.score: null`
 * (and therefore `composite: null`) rather than `0` — a real `0` is
 * indistinguishable from "linked but has no comments", which would
 * silently exclude every linked validator from a `score >= N` filter.
 * The sub-component counts (`commentCount` etc.) and `walletScore`
 * stay populated so a wallet-only consumer still gets a number. A
 * top-level `ingestStatus` block makes the partial state explicit.
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
  //
  // REST-M4 — per-route rate-limit override. A GET here runs 5-7
  // independent DB reads (the two-wave fan-out in
  // `resolveOaiForValidator`), ~5× the per-request DB cost of a
  // typical `/v1/*` read (a HEAD pays only the two cheap gate
  // lookups). The global limiter (`@fastify/rate-limit`, registered
  // in server.ts) honours a route-level `config.rateLimit` out of
  // the box, so we cap this endpoint at 30/min/IP — half the global
  // 60/min — to bound the worst-case DB load a single IP can drive
  // here. A normal UI consumer (one OAI panel per profile view)
  // stays well under it.
  app.get<{ Params: { idOrVote: string } }>(
    '/v1/validators/:idOrVote/operator-activity-index',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply): Promise<OaiResponse | void> => {
      const params = VoteOrIdentityParamSchema.safeParse(request.params);
      if (!params.success) {
        throw new ValidationError('idOrVote path parameter failed validation', {
          issues: params.error.issues,
        });
      }
      const validator = await findValidatorByVoteOrIdentity(
        opts.validatorsRepo,
        params.data.idOrVote,
      );
      if (validator === null) {
        throw new NotFoundError('validator', params.data.idOrVote);
      }

      // HEAD short-circuit — runs BEFORE the full resolver so a HEAD
      // probe pays only the two cheap gate lookups (`passesOaiGates`:
      // `claimsRepo.findByVote` + `profilesRepo.findOptedOutVotes`)
      // instead of the resolver's two-wave repo fan-out. This
      // preserves REST-M3's "a HEAD doesn't pay the full DB cost"
      // intent — `resolveOaiForValidator` runs that same gate phase
      // first anyway, so calling it directly here is behaviour-
      // identical, just cheaper. A HEAD on a gated validator
      // (unclaimed / opted-out / identity-drift) still 404s exactly
      // like the GET path; a HEAD on a valid one 200s with an empty
      // body. The handler resolves `void` here (the reply is already
      // sent) — the `Promise<OaiResponse | void>` return type makes
      // that honest without an `as unknown as OaiResponse` cast.
      if (request.method === 'HEAD') {
        if (!(await passesOaiGates(opts, validator))) {
          throw new NotFoundError('validator claim', params.data.idOrVote);
        }
        void reply.code(200).header('cache-control', OAI_CACHE_CONTROL).send('');
        return;
      }

      // GET — resolve the OAI components: claim / identity-drift /
      // opt-out gates + the two-wave repo fan-out + the
      // `computeOperatorActivityIndex` call all live in
      // `resolveOaiForValidator` (shared verbatim with `/scoring`).
      // A `null` result means the validator is gated OUT
      // (unclaimed / opted-out / identity-drift) — collapse it into
      // the SAME 404 as an unknown pubkey so the gate that fired
      // stays unobservable. `/scoring` instead surfaces `null` as
      // `oai: null`.
      const oai = await resolveOaiForValidator(opts, validator);
      if (oai === null) {
        throw new NotFoundError('validator claim', params.data.idOrVote);
      }

      void reply.header('cache-control', OAI_CACHE_CONTROL);
      return {
        vote: validator.votePubkey,
        identity: validator.identityPubkey,
        ...oai,
      };
    },
  );
};

export default oaiRoutes;
