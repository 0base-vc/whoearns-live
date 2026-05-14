import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../core/config.js';
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
 * Claim v2 API routes — Phase 3 GitHub identity + operator wallet
 * registration.
 *
 *   POST /v1/claim/github/verify  — link a GitHub username via a
 *                                   signed Gist proof
 *   POST /v1/claim/wallet/verify  — register an operator wallet via
 *                                   a dual-signature + anchor-tx proof
 *
 * Split out of `claim.route.ts` (the v1 claim/profile surface): the
 * two plugins share only the `/v1/claim/*` URL prefix, not behaviour
 * — v2 verifies external attestations (Gists, on-chain anchor txs)
 * rather than the bare offchain-message signatures v1 deals in.
 *
 * Both endpoints require the validator to already have a CLAIM
 * (a `validator_claims` row); the v1 claim flow is the prerequisite.
 */

export interface ClaimV2RoutesDeps {
  config: AppConfig;
  claimsRepo: Pick<ClaimsRepository, 'findByVote'>;
  validatorGithubRepo: ValidatorGithubRepository;
  operatorWalletsRepo: OperatorWalletsRepository;
  githubGistService: GithubGistVerificationService;
  operatorWalletService: OperatorWalletVerificationService;
}

const claimV2Routes: FastifyPluginAsync<ClaimV2RoutesDeps> = async (
  app: FastifyInstance,
  opts: ClaimV2RoutesDeps,
) => {
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
    const existingClaim = await opts.claimsRepo.findByVote(body.votePubkey);
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
    const result = await opts.githubGistService.verify({
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
    const priorLink = await opts.validatorGithubRepo.findByVote(body.votePubkey);
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
      await opts.validatorGithubRepo.upsert(result.link);
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
    const existingClaim = await opts.claimsRepo.findByVote(body.votePubkey);
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
    const count = await opts.operatorWalletsRepo.countByVote(body.votePubkey);
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
    const result = await opts.operatorWalletService.verify({
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
      await opts.operatorWalletsRepo.insert(result.wallet);
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

export default claimV2Routes;
