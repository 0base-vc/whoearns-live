import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../core/config.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import type { ClaimService, ClaimVerifyFailure } from '../../services/claim.service.js';
import {
  DEFAULT_NONCE_TTL_MS,
  isValidGithubUsername,
  type GithubLinkNonce,
  type GithubGistVerificationService,
} from '../../services/github-gist-verification.service.js';
import type {
  OperatorWalletNonce,
  OperatorWalletVerificationService,
} from '../../services/operator-wallet-verification.service.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import {
  OPERATOR_WALLET_CAP_PER_VALIDATOR,
  type OperatorWalletsRepository,
} from '../../storage/repositories/operator-wallets.repo.js';
import type { ValidatorGithubRepository } from '../../storage/repositories/validator-github.repo.js';
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
   * Phase 3 — Claim v2 deps. Optional so the API entrypoint can omit
   * them when the gamification feature flag is off; the route layer
   * returns 503 when a request hits a P3 endpoint without the deps
   * wired in.
   */
  claimsRepo?: Pick<ClaimsRepository, 'findByVote'>;
  validatorGithubRepo?: ValidatorGithubRepository;
  operatorWalletsRepo?: OperatorWalletsRepository;
  githubGistService?: GithubGistVerificationService;
  operatorWalletService?: OperatorWalletVerificationService;
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
   * no auth. Returns one of three combinations:
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
   * `claim` and `profile` are queried in parallel because they're
   * independent reads. The two-row trip cost is negligible vs. the
   * UX win of an accurate `claimed` flag.
   */
  app.get('/v1/claim/:vote/status', async (request) => {
    const params = unwrap(VoteParamSchema.safeParse(request.params), 'path parameter');
    const [claim, profile] = await Promise.all([
      opts.claimService.getClaim(params.vote),
      opts.claimService.getProfile(params.vote),
    ]);
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
      return reply.code(status).send({
        error: {
          code: result.reason,
          message: result.detail ?? humanMessageFor(result.reason),
          requestId: request.id,
        },
      });
    }

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
      return reply.code(status).send({
        error: {
          code: result.reason,
          message: result.detail ?? humanMessageFor(result.reason),
          requestId: request.id,
        },
      });
    }

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

  // ---------------------------------------------------------------------
  // Phase 3 — Claim v2: GitHub identity + operator wallet
  // ---------------------------------------------------------------------

  /**
   * Asymmetric freshness window. Past-skew is generous (5 min) because
   * clients legitimately need a few minutes to publish a Gist and
   * submit. Future-skew is tight (60 s) because a future timestamp
   * means the server is being asked to extend the verifiable lifetime
   * of a signature — combined with `expiresAtMs = timestampMs +
   * NONCE_TTL`, accepting 5 min of future skew would push the
   * effective replay window to ~35 min.
   */
  const NONCE_PAST_SKEW_MS = 5 * 60 * 1000;
  const NONCE_FUTURE_SKEW_MS = 60 * 1000;
  const LABEL_MAX_LEN = 32;

  /**
   * Guard the P3 endpoints when their optional deps are not wired in
   * — happens at boot if the gamification feature flag is disabled.
   * Returning 503 here is cleaner than a generic 500 because the
   * client knows to retry / show a "feature disabled" banner.
   */
  function requireP3Deps(): {
    claimsRepo: NonNullable<ClaimRoutesDeps['claimsRepo']>;
    validatorGithubRepo: NonNullable<ClaimRoutesDeps['validatorGithubRepo']>;
    operatorWalletsRepo: NonNullable<ClaimRoutesDeps['operatorWalletsRepo']>;
    githubGistService: NonNullable<ClaimRoutesDeps['githubGistService']>;
    operatorWalletService: NonNullable<ClaimRoutesDeps['operatorWalletService']>;
  } | null {
    if (
      opts.claimsRepo === undefined ||
      opts.validatorGithubRepo === undefined ||
      opts.operatorWalletsRepo === undefined ||
      opts.githubGistService === undefined ||
      opts.operatorWalletService === undefined
    ) {
      return null;
    }
    return {
      claimsRepo: opts.claimsRepo,
      validatorGithubRepo: opts.validatorGithubRepo,
      operatorWalletsRepo: opts.operatorWalletsRepo,
      githubGistService: opts.githubGistService,
      operatorWalletService: opts.operatorWalletService,
    };
  }

  function freshnessOk(timestampMs: number): boolean {
    const now = Date.now();
    const delta = now - timestampMs; // positive = past, negative = future
    if (delta < -NONCE_FUTURE_SKEW_MS) return false;
    if (delta > NONCE_PAST_SKEW_MS) return false;
    return true;
  }

  /**
   * GitHub Gist verification.
   *
   * Trust model:
   *   1. Operator must already have a CLAIM (validator_claims row).
   *   2. timestampMs must be within ±5 min of server time.
   *   3. The Gist published at `gistUrl` must contain the exact
   *      canonical nonce (server-reconstructed from request fields)
   *      and a base58 Ed25519 signature over it. The signature is
   *      verified against the identity pubkey.
   *   4. The Gist URL's username must match the requested
   *      `githubUsername` (prevents publishing under someone else's
   *      account).
   */
  const GithubVerifyBodySchema = z.object({
    votePubkey: PubkeySchema,
    identityPubkey: PubkeySchema,
    githubUsername: z
      .string()
      .min(1)
      .max(39)
      .refine(isValidGithubUsername, 'invalid GitHub username'),
    gistUrl: z.string().url().max(500),
    timestampMs: z.number().int().positive(),
  });

  app.post('/v1/claim/github/verify', async (request, reply) => {
    const deps = requireP3Deps();
    if (deps === null) {
      return reply.code(503).send({
        error: {
          code: 'feature_disabled',
          message: 'github claim feature is not configured',
          requestId: request.id,
        },
      });
    }
    const body = GithubVerifyBodySchema.parse(request.body);
    if (!freshnessOk(body.timestampMs)) {
      return reply.code(403).send({
        error: {
          code: 'stale_timestamp',
          message: 'timestampMs is outside the freshness window',
          requestId: request.id,
        },
      });
    }
    const existingClaim = await deps.claimsRepo.findByVote(body.votePubkey);
    if (existingClaim === null) {
      return reply.code(403).send({
        error: {
          code: 'not_claimed',
          message: 'validator must be claimed before linking GitHub',
          requestId: request.id,
        },
      });
    }
    if (existingClaim.identityPubkey !== body.identityPubkey) {
      return reply.code(403).send({
        error: {
          code: 'identity_mismatch',
          message: 'identity pubkey does not match claim',
          requestId: request.id,
        },
      });
    }
    const issuedNonce: GithubLinkNonce = {
      votePubkey: body.votePubkey,
      identityPubkey: body.identityPubkey,
      githubUsername: body.githubUsername,
      issuedAtMs: body.timestampMs,
      expiresAtMs: body.timestampMs + DEFAULT_NONCE_TTL_MS,
      domain: opts.config.SITE_URL,
    };
    const result = await deps.githubGistService.verify({
      issuedNonce,
      gistUrl: body.gistUrl,
    });
    if (!result.ok) {
      const status =
        result.reason === 'fetch_failed' || result.reason === 'gist_too_large' ? 502 : 403;
      return reply.code(status).send({
        error: { code: result.reason, message: result.reason, requestId: request.id },
      });
    }
    // Route-level replay defense for same-vote replays: the DB
    // UNIQUE constraint on signed_nonce catches cross-vote replays
    // (different vote_pubkey, same canonical nonce — impossible
    // unless someone forged the identity sig anyway, so 23505 here
    // is the defense). Same-vote replays would otherwise UPDATE
    // through the ON CONFLICT clause and silently refresh
    // verified_at + expires_at — so we explicitly reject them.
    const priorLink = await deps.validatorGithubRepo.findByVote(body.votePubkey);
    if (priorLink !== null && priorLink.signedNonce === result.link.signedNonce) {
      return reply.code(403).send({
        error: {
          code: 'nonce_replay',
          message: 'this nonce has already been used',
          requestId: request.id,
        },
      });
    }
    try {
      await deps.validatorGithubRepo.upsert(result.link);
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return reply.code(403).send({
          error: {
            code: 'nonce_replay',
            message: 'this nonce has already been used',
            requestId: request.id,
          },
        });
      }
      throw err;
    }
    return {
      link: {
        githubUsername: result.link.githubUsername,
        gistUrl: result.link.gistUrl,
        verifiedAt: result.link.verifiedAt.toISOString(),
        expiresAt: result.link.expiresAt.toISOString(),
      },
    };
  });

  /**
   * Operator wallet registration.
   *
   * Trust model:
   *   1. Operator must already have a CLAIM.
   *   2. timestampMs within freshness.
   *   3. Wallet count under the cap (3 per validator).
   *   4. BOTH signatures verify against the canonical nonce.
   *   5. `anchorTxSignature` is a well-formed Solana tx signature
   *      (full on-chain verification deferred — see service docstring).
   */
  const WalletVerifyBodySchema = z.object({
    votePubkey: PubkeySchema,
    identityPubkey: PubkeySchema,
    walletPubkey: PubkeySchema,
    label: z.string().max(LABEL_MAX_LEN).default(''),
    timestampMs: z.number().int().positive(),
    identitySignatureB58: z.string().min(64).max(128),
    walletSignatureB58: z.string().min(64).max(128),
    anchorTxSignature: z.string().min(64).max(96),
  });

  app.post('/v1/claim/wallet/verify', async (request, reply) => {
    const deps = requireP3Deps();
    if (deps === null) {
      return reply.code(503).send({
        error: {
          code: 'feature_disabled',
          message: 'wallet claim feature is not configured',
          requestId: request.id,
        },
      });
    }
    const body = WalletVerifyBodySchema.parse(request.body);
    if (!freshnessOk(body.timestampMs)) {
      return reply.code(403).send({
        error: {
          code: 'stale_timestamp',
          message: 'timestampMs is outside the freshness window',
          requestId: request.id,
        },
      });
    }
    const existingClaim = await deps.claimsRepo.findByVote(body.votePubkey);
    if (existingClaim === null) {
      return reply.code(403).send({
        error: {
          code: 'not_claimed',
          message: 'validator must be claimed before registering a wallet',
          requestId: request.id,
        },
      });
    }
    if (existingClaim.identityPubkey !== body.identityPubkey) {
      return reply.code(403).send({
        error: {
          code: 'identity_mismatch',
          message: 'identity pubkey does not match claim',
          requestId: request.id,
        },
      });
    }
    // Reject self-registration: registering the validator's own
    // vote or identity pubkey as an "operator wallet" pollutes
    // downstream analytics (e.g. Phase 4 wallet-activity grid) and
    // defeats the cold/warm separation the feature exists for.
    if (body.walletPubkey === body.identityPubkey || body.walletPubkey === body.votePubkey) {
      return reply.code(400).send({
        error: {
          code: 'pubkey_role_collision',
          message: 'walletPubkey must differ from identity and vote pubkeys',
          requestId: request.id,
        },
      });
    }
    const count = await deps.operatorWalletsRepo.countByVote(body.votePubkey);
    if (count >= OPERATOR_WALLET_CAP_PER_VALIDATOR) {
      return reply.code(409).send({
        error: {
          code: 'wallet_cap_reached',
          message: `validator has the maximum ${OPERATOR_WALLET_CAP_PER_VALIDATOR} wallets`,
          requestId: request.id,
        },
      });
    }
    const issuedNonce: OperatorWalletNonce = {
      votePubkey: body.votePubkey,
      identityPubkey: body.identityPubkey,
      walletPubkey: body.walletPubkey,
      label: body.label,
      issuedAtMs: body.timestampMs,
      expiresAtMs: body.timestampMs + DEFAULT_NONCE_TTL_MS,
      domain: opts.config.SITE_URL,
    };
    const result = await deps.operatorWalletService.verify({
      issuedNonce,
      identitySignatureB58: body.identitySignatureB58,
      walletSignatureB58: body.walletSignatureB58,
      anchorTxSignature: body.anchorTxSignature,
    });
    if (!result.ok) {
      return reply.code(403).send({
        error: { code: result.reason, message: result.reason, requestId: request.id },
      });
    }
    try {
      await deps.operatorWalletsRepo.insert(result.wallet);
    } catch (err) {
      const pgErr = err as { code?: string };
      // SQLSTATE 23514 = check_violation; the 3-wallet trigger uses
      // ERRCODE = 'check_violation' for the cap. Matching by code
      // (not message text) is robust to migration reword.
      if (pgErr.code === '23514') {
        return reply.code(409).send({
          error: {
            code: 'wallet_cap_reached',
            message: 'wallet cap exceeded (race)',
            requestId: request.id,
          },
        });
      }
      // SQLSTATE 23505 = unique_violation; the only UNIQUE on this
      // table is `signed_nonce` (added by migration 0025), so this
      // means a replay of an already-accepted nonce.
      if (pgErr.code === '23505') {
        return reply.code(403).send({
          error: {
            code: 'nonce_replay',
            message: 'this nonce has already been used',
            requestId: request.id,
          },
        });
      }
      throw err;
    }
    return {
      wallet: {
        walletPubkey: result.wallet.walletPubkey,
        label: result.wallet.label,
        registeredAt: result.wallet.registeredAt.toISOString(),
        expiresAt: result.wallet.expiresAt.toISOString(),
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
