import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../core/config.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { ClaimService, ClaimVerifyFailure } from '../../services/claim.service.js';
import {
  OPERATOR_WALLET_CAP_PER_VALIDATOR,
  type OperatorWalletsRepository,
} from '../../storage/repositories/operator-wallets.repo.js';
import type {
  ClaimEventInput,
  ValidatorClaimEventsRepository,
} from '../../storage/repositories/validator-claim-events.repo.js';
import type { ValidatorGithubRepository } from '../../storage/repositories/validator-github.repo.js';
import { cacheControl } from '../cache-control.js';
import { sendError } from '../error-handler.js';
import { PubkeySchema } from '../schemas/pubkey.js';

/**
 * Local Zod-safeParse unwrap, matching the pattern used in
 * `leaderboard.route.ts`. Kept inline (not extracted to a shared
 * helper) because the error-handler middleware reads the thrown
 * `ValidationError` shape and we don't want cross-module coupling
 * on that shape until we have >2 call sites — just duplicating a
 * 10-line function.
 */
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
 * Claim + profile API routes.
 *
 * Four endpoints, split purposefully:
 *
 *   POST /v1/claim/verify        — first-time claim, no profile changes
 *   POST /v1/claim/profile       — update profile (must already be claimed OR claim in same step)
 *   GET  /v1/claim/:vote/status  — "is this validator claimed? / what's the profile?"
 *   GET  /v1/claim/challenge     — returns a server-issued nonce + current timestamp
 *                                  so the UI doesn't need to crypto-random on the
 *                                  client (cross-browser UUID availability varies).
 *
 * All mutating endpoints bind signature + timestamp to the specific
 * operation being requested (`purpose: 'claim' | 'profile'`), so a
 * profile-update signature cannot be replayed as a bare claim, or
 * vice versa.
 *
 * No session state is stored on the server — every mutation re-signs.
 * This is a LOW frequency flow (operator edits ~once per month), so
 * the extra hop is imperceptible; the alternative (JWTs, cookies) is
 * more surface area than this deserves.
 */

export interface ClaimRoutesDeps {
  config: AppConfig;
  claimService: ClaimService;
  /**
   * SEC-M4 — append-only audit log. The `verify` and `profile` write
   * paths record an event here after a successful mutation. Only
   * `append` (write) + `listByVote` (the `/audit` read) are used.
   */
  claimEventsRepo: Pick<ValidatorClaimEventsRepository, 'append' | 'listByVote'>;
  /**
   * CROSS-M1 — the `/v1/claim/:vote/status` response now folds in
   * GitHub-link + operator-wallet state so a dashboard gets the whole
   * claim picture in ONE fetch instead of three. These are the same
   * ACTIVE-only reads the OAI route uses (`findActiveByVote` /
   * `listActiveByVote`). Status is a read-only surface — no mutating
   * methods are threaded in.
   */
  validatorGithubRepo: Pick<ValidatorGithubRepository, 'findActiveByVote'>;
  operatorWalletsRepo: Pick<OperatorWalletsRepository, 'listActiveByVote'>;
}

/**
 * Best-effort audit-log write (SEC-M4).
 *
 * Called AFTER a claim-surface mutation has already succeeded. If the
 * append throws we log a `warn` and swallow it — a failed audit write
 * must NEVER turn an operator's successful claim into an error
 * response. (A fully transactional audit log would need the claim
 * repo + events repo to share a transaction; that's out of scope for
 * this pass — this is the deliberate best-effort tradeoff.)
 */
async function recordClaimEvent(
  repo: Pick<ValidatorClaimEventsRepository, 'append'>,
  request: FastifyRequest,
  event: ClaimEventInput,
): Promise<void> {
  try {
    await repo.append(event);
  } catch (err) {
    request.log.warn(
      { err, vote: event.votePubkey, eventType: event.eventType },
      'claim.route: audit-log append failed (best-effort, claim still succeeded)',
    );
  }
}

/**
 * Twitter handle validation. Follows X/Twitter's public rules:
 *   - 1-15 ASCII chars
 *   - alphanumeric + underscore only
 *   - no leading `@` in storage (UI strips it on submit)
 *
 * Accepts empty string as "unset" and coerces to null downstream.
 */
const TwitterHandleSchema = z
  .string()
  .max(15, 'Twitter handle must be 15 characters or fewer')
  .regex(/^[A-Za-z0-9_]*$/, 'Twitter handle: letters, numbers, and underscore only')
  .nullable()
  .optional();

/**
 * Core signed-message envelope. Embedded in both claim and profile
 * mutation bodies — the Zod shape is the exact JSON we accept on the
 * wire. Field names here MUST match `SignedPayloadBody` in the
 * service so `.parse()` produces a valid argument object.
 */
const SignedEnvelopeSchema = z.object({
  votePubkey: PubkeySchema,
  identityPubkey: PubkeySchema,
  /** Client-generated UUIDv4 (or any unique string); single-use. */
  nonce: z.string().min(8).max(128),
  /** Unix timestamp in seconds. Service enforces ±5 min freshness. */
  timestampSec: z.number().int().positive(),
  /** Base58-encoded 64-byte Ed25519 signature. */
  signatureBase58: z.string().min(64).max(128),
});

const ClaimVerifyBodySchema = SignedEnvelopeSchema;

/**
 * Narrative-override character ceiling matches the DB CHECK
 * constraint and the front-end textarea limit. Empty string from the
 * UI is normalised to `null` at the route layer (see body-handling
 * code below) so the column distinguishes "operator chose to remove
 * the override" from "operator never set one" — both render the auto
 * fallback, but DB queries can use `IS NULL` cleanly.
 */
const NARRATIVE_OVERRIDE_MAX = 280;
const NarrativeOverrideSchema = z
  .string()
  .max(NARRATIVE_OVERRIDE_MAX, { message: `narrativeOverride > ${NARRATIVE_OVERRIDE_MAX} chars` })
  .nullable()
  .optional()
  .refine((value) => value === undefined || value === null || !/[<>]/.test(value), {
    message: 'narrativeOverride must not contain angle brackets',
  });

const ProfileUpdateBodySchema = SignedEnvelopeSchema.extend({
  profile: z.object({
    twitterHandle: TwitterHandleSchema,
    hideFooterCta: z.boolean(),
    optedOut: z.boolean(),
    narrativeOverride: NarrativeOverrideSchema,
  }),
});

const VoteParamSchema = z.object({ vote: PubkeySchema });

/**
 * Map verify failures onto HTTP status codes the client can branch
 * on. 400 for caller-side mistakes (malformed payload, bad sig),
 * 403 for policy/replay refusals, 404 for unknown validator.
 */
function statusForFailure(reason: ClaimVerifyFailure): number {
  switch (reason) {
    case 'validator_not_found':
      return 404;
    case 'identity_mismatch':
    case 'stale_timestamp':
    case 'nonce_replay':
    case 'bad_signature':
    case 'stake_below_floor':
      return 403;
    case 'malformed_signature':
    case 'malformed_payload':
      return 400;
  }
}

const claimRoutes: FastifyPluginAsync<ClaimRoutesDeps> = async (
  app: FastifyInstance,
  opts: ClaimRoutesDeps,
) => {
  /**
   * Server-issued challenge — returns a fresh nonce and the current
   * server timestamp. The UI renders these into a signable message
   * template. Pure convenience; a client that generates its own
   * UUID + `Date.now()` can skip this and call verify directly.
   */
  app.get('/v1/claim/challenge', async () => {
    // Crypto-random nonce. Node 18+ has crypto.randomUUID globally.
    const nonce = crypto.randomUUID();
    return {
      nonce,
      timestampSec: Math.floor(Date.now() / 1000),
      // Clients should sign + submit within this window; beyond
      // this the verify endpoint rejects with `stale_timestamp`.
      expiresInSec: 5 * 60,
    };
  });

  /**
   * Check claim / profile state for a validator. Public endpoint —
   * no auth. Returns one of three `claimed`/`profile` combinations:
   *   - `claimed: false, profile: null`               → never claimed
   *   - `claimed: true, profile: null`                → claimed but
   *                                                     no profile
   *                                                     edits yet
   *   - `claimed: true, profile: {twitter, ...}`      → claimed +
   *                                                     edited
   *
   * The two-key shape matters because the UI branches on `claimed`:
   * a claim-only state should jump straight into the profile editor
   * (no "Prove ownership" screen) since the operator already proved
   * it once. Conflating "claimed" with "has profile row" — which an
   * earlier version did — meant the operator who claimed but didn't
   * fill any field would re-see the first-claim flow on every visit.
   *
   * CROSS-M1 — the response also folds in `githubLink` and `wallets`
   * so an operator dashboard renders the whole claim picture from a
   * SINGLE fetch. Before this it had to chase the claim-status read
   * with three more un-batched calls (`/operator-activity-index`
   * read paths, etc.) just to know whether GitHub was linked and how
   * many wallets were registered. Both are the ACTIVE-only reads —
   * `githubLink` is `null` when there's no link OR the attestation
   * lapsed; `wallets.count` counts only not-expired registrations —
   * matching the OAI route's semantics so the dashboard sees the
   * same "lapsed = inactive" view everywhere.
   *
   * All four reads run in parallel — they're independent, and the
   * extra two-row trip is negligible against the UX win of a
   * one-fetch dashboard.
   */
  app.get('/v1/claim/:vote/status', async (request) => {
    const params = unwrap(VoteParamSchema.safeParse(request.params), 'path parameter');
    const [claim, profile, githubLink, activeWallets] = await Promise.all([
      opts.claimService.getClaim(params.vote),
      opts.claimService.getProfile(params.vote),
      opts.validatorGithubRepo.findActiveByVote(params.vote),
      opts.operatorWalletsRepo.listActiveByVote(params.vote),
    ]);
    // Wallet summary derived from the ACTIVE-only list: count,
    // whether the per-validator cap is hit, and the soonest-expiring
    // attestation (so a dashboard can nudge "re-attest" before a
    // wallet silently drops out of scoring). `oldestExpiresAt` is the
    // MIN expiry across active rows — `null` when none are registered.
    const oldestExpiresAt = activeWallets.reduce<Date | null>(
      (oldest, w) => (oldest === null || w.expiresAt < oldest ? w.expiresAt : oldest),
      null,
    );
    return {
      claimed: claim !== null,
      profile:
        profile === null
          ? null
          : {
              twitterHandle: profile.twitterHandle,
              hideFooterCta: profile.hideFooterCta,
              optedOut: profile.optedOut,
              narrativeOverride: profile.narrativeOverride,
              updatedAt: profile.updatedAt.toISOString(),
            },
      // `null` when no ACTIVE GitHub link exists (never linked OR the
      // attestation expired) — same "lapsed = gone" rule as OAI.
      githubLink:
        githubLink === null
          ? null
          : {
              githubUsername: githubLink.githubUsername,
              verifiedAt: githubLink.verifiedAt.toISOString(),
              expiresAt: githubLink.expiresAt.toISOString(),
            },
      wallets: {
        count: activeWallets.length,
        capReached: activeWallets.length >= OPERATOR_WALLET_CAP_PER_VALIDATOR,
        oldestExpiresAt: oldestExpiresAt?.toISOString() ?? null,
      },
    };
  });

  /**
   * Public claim-change audit log (SEC-M4). Returns the recent
   * claim-surface mutations for a vote pubkey, newest first —
   * claims, re-claims, profile edits, GitHub links, wallet
   * registrations. Lets an operator notice an identity-key
   * compromise after the fact (a `reclaim` row with a non-null
   * `priorIdentityPubkey` is the smoking gun for a silent identity
   * rotation).
   *
   * No auth — like `/v1/claim/:vote/status`, this is a read of
   * already-public facts. PRIVACY: the forensic `submitted_ip`
   * column is NOT in the response — IP stays in the DB. Everything
   * surfaced here (pubkeys, GitHub usernames, wallet pubkeys,
   * operator-chosen labels) is already public on-chain or
   * operator-published.
   *
   * Cache: SCORING tier (5 min client / 30 min CDN). Audit history
   * only changes when the operator makes a claim-surface mutation —
   * a rare, deliberate action — so a short public/CDN cache is
   * fine and shields the table from scraping. CATALOGUE would also
   * fit; SCORING is the slightly tighter choice so a freshly-recorded
   * event surfaces sooner during an active claim flow.
   */
  app.get('/v1/claim/:vote/audit', async (request, reply) => {
    const params = unwrap(VoteParamSchema.safeParse(request.params), 'path parameter');
    const events = await opts.claimEventsRepo.listByVote(params.vote);
    void reply.header('cache-control', cacheControl('SCORING'));
    return {
      votePubkey: params.vote,
      // `submittedIp` is intentionally omitted — forensic field, see
      // the PRIVACY note above.
      events: events.map((e) => ({
        eventType: e.eventType,
        identityPubkey: e.identityPubkey,
        priorIdentityPubkey: e.priorIdentityPubkey,
        detail: e.detail,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  });

  /**
   * First-time (or re-) claim. Verifies the signature without
   * touching profile state — useful for operators who want to
   * "lock in" ownership before editing anything. Idempotent: calling
   * verify repeatedly with fresh nonces keeps bumping the row.
   */
  app.post('/v1/claim/verify', async (request, reply) => {
    const body = unwrap(ClaimVerifyBodySchema.safeParse(request.body), 'body');
    // Read the prior claim BEFORE verifying: `verifySigned` upserts
    // the row, so afterwards we can no longer tell a first-ever claim
    // from a re-claim, nor recover the previous identity pubkey. This
    // snapshot is what lets the audit log distinguish `claim` vs
    // `reclaim` and capture an identity rotation (SEC-M4).
    const priorClaim = await opts.claimService.getClaim(body.votePubkey);
    const result = await opts.claimService.verifySigned({
      body: {
        purpose: 'claim',
        votePubkey: body.votePubkey,
        identityPubkey: body.identityPubkey,
        nonce: body.nonce,
        timestampSec: body.timestampSec,
      },
      signatureBase58: body.signatureBase58,
    });

    if (!result.ok) {
      const status = statusForFailure(result.reason);
      return sendError(reply, {
        code: result.reason,
        statusCode: status,
        message: result.detail ?? humanMessageFor(result.reason),
        requestId: request.id,
      });
    }

    // SEC-M4 — best-effort audit write AFTER the claim mutation
    // succeeded. First-ever claim → `claim`; any subsequent claim →
    // `reclaim`, with `priorIdentityPubkey` populated only when the
    // identity actually rotated (a same-identity nonce-bump leaves it
    // null). A throw here is logged + swallowed: see `recordClaimEvent`.
    const identityRotated =
      priorClaim !== null && priorClaim.identityPubkey !== result.claim.identityPubkey;
    await recordClaimEvent(opts.claimEventsRepo, request, {
      votePubkey: result.claim.votePubkey,
      eventType: priorClaim === null ? 'claim' : 'reclaim',
      identityPubkey: result.claim.identityPubkey,
      priorIdentityPubkey: identityRotated ? priorClaim.identityPubkey : null,
      submittedIp: request.ip,
    });

    return {
      claimed: true,
      votePubkey: result.claim.votePubkey,
      claimedAt: result.claim.claimedAt.toISOString(),
    };
  });

  /**
   * Update profile. Same signed envelope, plus the desired profile
   * state. Verifies + persists atomically; an attacker who swaps the
   * profile fields between signing and submission breaks the
   * signature and the request fails.
   */
  app.post('/v1/claim/profile', async (request, reply) => {
    const body = unwrap(ProfileUpdateBodySchema.safeParse(request.body), 'body');

    // Normalise twitter handle: "" and null both mean "unset". We
    // DB-store null so queries can use IS NULL checks.
    const normalisedTwitter =
      body.profile.twitterHandle === undefined ||
      body.profile.twitterHandle === null ||
      body.profile.twitterHandle === ''
        ? null
        : body.profile.twitterHandle;

    // Same normalisation for narrative — `undefined` (field absent
    // from request, e.g. older client), `null` (operator cleared
    // it), and the empty-string-after-trim case all collapse to
    // `null` so the canonical-payload representation is stable.
    const rawNarrative = body.profile.narrativeOverride;
    const trimmedNarrative =
      rawNarrative === undefined || rawNarrative === null ? null : rawNarrative.trim();
    const normalisedNarrative =
      trimmedNarrative === null || trimmedNarrative.length === 0 ? null : trimmedNarrative;

    const result = await opts.claimService.updateProfile({
      body: {
        purpose: 'profile',
        votePubkey: body.votePubkey,
        identityPubkey: body.identityPubkey,
        nonce: body.nonce,
        timestampSec: body.timestampSec,
        profile: {
          twitterHandle: normalisedTwitter,
          hideFooterCta: body.profile.hideFooterCta,
          optedOut: body.profile.optedOut,
          narrativeOverride: normalisedNarrative,
        },
      },
      signatureBase58: body.signatureBase58,
    });

    if (!result.ok) {
      const status = statusForFailure(result.reason);
      return sendError(reply, {
        code: result.reason,
        statusCode: status,
        message: result.detail ?? humanMessageFor(result.reason),
        requestId: request.id,
      });
    }

    // SEC-M4 — best-effort audit write after the profile mutation
    // succeeded. `identityPubkey` is the signer's identity (the same
    // one the signature verified against). A throw is logged +
    // swallowed; see `recordClaimEvent`.
    await recordClaimEvent(opts.claimEventsRepo, request, {
      votePubkey: body.votePubkey,
      eventType: 'profile_update',
      identityPubkey: body.identityPubkey,
      submittedIp: request.ip,
    });

    return {
      profile: {
        twitterHandle: result.profile.twitterHandle,
        hideFooterCta: result.profile.hideFooterCta,
        optedOut: result.profile.optedOut,
        narrativeOverride: result.profile.narrativeOverride,
        updatedAt: result.profile.updatedAt.toISOString(),
      },
    };
  });
};

/**
 * Default human-readable messages for each failure. The service's
 * `detail` field overrides this when present (e.g. "skew=412s") —
 * the defaults are the fallback for reasons without a specific
 * detail.
 */
function humanMessageFor(reason: ClaimVerifyFailure): string {
  switch (reason) {
    case 'validator_not_found':
      return 'Vote pubkey is not in our indexer. Add the validator first, then retry.';
    case 'identity_mismatch':
      return "The identity pubkey you signed with doesn't match this validator's on-chain identity.";
    case 'stake_below_floor':
      return 'Activated stake is below the claim threshold.';
    case 'stale_timestamp':
      return 'Signature timestamp is outside the 5-minute freshness window. Re-sign with a fresh timestamp.';
    case 'nonce_replay':
      return 'This nonce was already used. Generate a new one and re-sign.';
    case 'bad_signature':
      return 'Signature verification failed. Double-check the keypair and message text.';
    case 'malformed_signature':
      return 'Signature is not a valid 64-byte Ed25519 signature.';
    case 'malformed_payload':
      return 'Request payload is malformed.';
  }
}

// Re-export ValidationError so the API's existing error handler
// surfaces Zod-rejection messages in the standard envelope.
// (Referenced via `unwrap` above.)
export { ValidationError, NotFoundError };

export default claimRoutes;
