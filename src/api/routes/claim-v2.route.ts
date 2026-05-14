import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../core/config.js';
import {
  DEFAULT_NONCE_TTL_MS,
  GITHUB_LINK_NONCE_PURPOSE,
  isValidGithubUsername,
  type GithubLinkNonce,
  type GithubGistVerificationService,
  type VerifyGistFailure,
} from '../../services/github-gist-verification.service.js';
import {
  OPERATOR_WALLET_NONCE_PURPOSE,
  type OperatorWalletNonce,
  type OperatorWalletVerificationService,
  type VerifyOperatorWalletFailure,
} from '../../services/operator-wallet-verification.service.js';
import type { ClaimsRepository } from '../../storage/repositories/claims.repo.js';
import {
  OPERATOR_WALLET_CAP_PER_VALIDATOR,
  type OperatorWalletsRepository,
} from '../../storage/repositories/operator-wallets.repo.js';
import type {
  ClaimEventInput,
  ValidatorClaimEventsRepository,
} from '../../storage/repositories/validator-claim-events.repo.js';
import type { ValidatorGithubRepository } from '../../storage/repositories/validator-github.repo.js';
import type { ValidatorsRepository } from '../../storage/repositories/validators.repo.js';
import { sendError } from '../error-handler.js';
import { PubkeySchema } from '../schemas/pubkey.js';
import { unwrap } from '../zod-helpers.js';

/**
 * Best-effort audit-log write (SEC-M4). Mirrors `recordClaimEvent` in
 * `claim.route.ts` — each route file carries its own copy (same
 * convention as the inline `unwrap` helper) rather than coupling on a
 * shared export. Called AFTER a claim-surface mutation succeeds; a
 * throw is logged `warn` and swallowed so a failed audit write can
 * never fail the operator's request. A fully transactional audit log
 * would need the events repo + claim repo to share a transaction —
 * out of scope for this pass.
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
      'claim-v2.route: audit-log append failed (best-effort, mutation still succeeded)',
    );
  }
}

/** The `reason` discriminant of a Gist-verification failure. */
type GistFailureReason = Extract<VerifyGistFailure, { ok: false }>['reason'];
/** The `reason` discriminant of an operator-wallet-verification failure. */
type WalletFailureReason = Extract<VerifyOperatorWalletFailure, { ok: false }>['reason'];

/**
 * REST-M2 — map a `GithubGistVerificationService` failure `reason`
 * (a stable MACHINE id like `fetch_failed`) onto a readable sentence
 * for the error envelope's `message`. The `code` keeps the machine
 * id; `message` becomes human prose. Mirrors `humanMessageFor` in
 * `claim.route.ts` — without this the route sent
 * `{ code: 'fetch_failed', message: 'fetch_failed' }`, i.e. an
 * identifier where a human-facing string belongs. Exhaustive over
 * the union so a new failure reason fails the build, not silently
 * ships a machine id as prose.
 */
function humanMessageForGistFailure(reason: GistFailureReason): string {
  switch (reason) {
    case 'malformed_url':
      return 'The gist URL is not a valid GitHub Gist URL.';
    case 'username_mismatch':
      return "The gist's owner does not match the GitHub username you submitted.";
    case 'fetch_failed':
      return 'Could not fetch the gist from GitHub. Check the URL is public and retry shortly.';
    case 'gist_too_large':
      return 'The gist is larger than the allowed proof size. Publish a gist containing only the proof.';
    case 'malformed_proof':
      return 'The gist body is not a well-formed WhoEarns proof.';
    case 'nonce_mismatch':
      return 'The proof in the gist does not match this request. Re-generate the proof and re-publish.';
    case 'expired':
      return 'The proof in the gist has expired. Generate a fresh proof and re-publish.';
    case 'bad_signature':
      return 'The signature in the gist did not verify against the validator identity key.';
  }
}

/**
 * REST-M2 — same as `humanMessageForGistFailure` but for the
 * `OperatorWalletVerificationService` failure reasons. `code` keeps
 * the stable machine id; `message` carries this readable sentence.
 */
function humanMessageForWalletFailure(reason: WalletFailureReason): string {
  switch (reason) {
    case 'expired':
      return 'The signed nonce has expired. Generate a fresh one and re-sign.';
    case 'bad_identity_signature':
      return 'The validator identity signature did not verify against the nonce.';
    case 'bad_wallet_signature':
      return 'The wallet signature did not verify against the nonce.';
    case 'invalid_anchor_signature':
      return 'The anchor transaction signature is not a valid Solana transaction signature.';
    case 'malformed_pubkey':
      return 'One of the supplied pubkeys is not a valid base58 Solana pubkey.';
  }
}

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
  /**
   * SEC-L4 — used by `wallet/verify` to reject a `walletPubkey` that
   * is some OTHER validator's identity pubkey. The route already
   * rejects collision with THIS validator's vote/identity; this
   * `findByIdentity` lookup widens that to a soft cross-validator
   * check so a multi-validator operator can't accidentally register
   * a sibling node's identity key as an "operator wallet".
   */
  validatorsRepo: Pick<ValidatorsRepository, 'findByIdentity'>;
  validatorGithubRepo: ValidatorGithubRepository;
  operatorWalletsRepo: OperatorWalletsRepository;
  githubGistService: GithubGistVerificationService;
  operatorWalletService: OperatorWalletVerificationService;
  /**
   * SEC-M4 — append-only audit log. `github/verify` and
   * `wallet/verify` record an event here after a successful mutation
   * (best-effort; see `recordClaimEvent`).
   */
  claimEventsRepo: Pick<ValidatorClaimEventsRepository, 'append'>;
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
    const body = unwrap(GithubVerifyBodySchema.safeParse(request.body), 'body');
    if (!freshnessOk(body.timestampMs)) {
      return sendError(reply, {
        code: 'stale_timestamp',
        statusCode: 403,
        message: 'timestampMs is outside the freshness window',
        requestId: request.id,
      });
    }
    const existingClaim = await opts.claimsRepo.findByVote(body.votePubkey);
    if (existingClaim === null) {
      return sendError(reply, {
        code: 'not_claimed',
        statusCode: 403,
        message: 'validator must be claimed before linking GitHub',
        requestId: request.id,
      });
    }
    if (existingClaim.identityPubkey !== body.identityPubkey) {
      return sendError(reply, {
        code: 'identity_mismatch',
        statusCode: 403,
        message: 'identity pubkey does not match claim',
        requestId: request.id,
      });
    }
    const issuedNonce: GithubLinkNonce = {
      purpose: GITHUB_LINK_NONCE_PURPOSE,
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
      // `code` stays the stable machine id; `message` is human prose
      // (REST-M2) — previously both were the bare `result.reason`.
      return sendError(reply, {
        code: result.reason,
        statusCode: status,
        message: humanMessageForGistFailure(result.reason),
        requestId: request.id,
      });
    }
    /**
     * Serialise a `ValidatorGithubLink` into the route's response
     * envelope. Shared by the happy path and the idempotent-replay
     * path below so both shapes stay identical.
     */
    const linkResponse = (link: typeof result.link) => ({
      link: {
        githubUsername: link.githubUsername,
        gistUrl: link.gistUrl,
        verifiedAt: link.verifiedAt.toISOString(),
        expiresAt: link.expiresAt.toISOString(),
      },
    });

    /**
     * Race-to-link self-DoS neutraliser (SEC-M2). A nonce-replay is
     * normally a 403 — but a freshly-published public Gist proof can
     * be scraped and re-submitted by anyone, and because the proof
     * itself is valid, the linkage it creates is CORRECT (vote → the
     * real operator's GitHub username). If the EXISTING
     * `validator_github` row already links the SAME
     * `(vote_pubkey, github_username)` this request would create,
     * the operator's intent is already satisfied regardless of who
     * submitted first — so we return 200 with the existing link
     * (idempotent success) instead of a 403 that would otherwise
     * make the legitimate operator's own submit fail. A row that
     * links a DIFFERENT username is a genuine replay → keep the 403.
     *
     * `null` return = not an idempotent match; the caller should
     * fall through to the 403.
     */
    const idempotentReplay = (existing: typeof result.link | null) => {
      if (
        existing !== null &&
        existing.votePubkey === result.link.votePubkey &&
        existing.githubUsername.toLowerCase() === result.link.githubUsername.toLowerCase()
      ) {
        return linkResponse(existing);
      }
      return null;
    };

    // Route-level replay defense for same-vote replays: the DB
    // UNIQUE constraint on signed_nonce catches cross-vote replays
    // (different vote_pubkey, same canonical nonce — impossible
    // unless someone forged the identity sig anyway, so 23505 here
    // is the defense). Same-vote replays would otherwise UPDATE
    // through the ON CONFLICT clause and silently refresh
    // verified_at + expires_at — so we explicitly reject them,
    // UNLESS the existing row already encodes the same linkage
    // (see `idempotentReplay`).
    const priorLink = await opts.validatorGithubRepo.findByVote(body.votePubkey);
    if (priorLink !== null && priorLink.signedNonce === result.link.signedNonce) {
      const idempotent = idempotentReplay(priorLink);
      if (idempotent !== null) return idempotent;
      return sendError(reply, {
        code: 'nonce_replay',
        statusCode: 403,
        message: 'this nonce has already been used',
        requestId: request.id,
      });
    }
    // TS-M6: the repo catches the pg `23505` unique_violation and
    // returns a typed `{ ok: false, reason: 'nonce_replay' }` — the
    // route no longer inspects SQLSTATE strings. `nonce_replay` here
    // means the `signed_nonce` UNIQUE fired: another submission
    // (possibly a scraper, possibly the operator's other tab) landed
    // this exact nonce first.
    const upsertResult = await opts.validatorGithubRepo.upsert(result.link);
    if (!upsertResult.ok) {
      // Re-read by vote: if the stored row already links the same
      // username this request wanted, the intent is satisfied —
      // return it as 200 (SEC-M2 idempotent-replay path). Otherwise
      // it's a genuine replay → 403.
      const stored = await opts.validatorGithubRepo.findByVote(body.votePubkey);
      const idempotent = idempotentReplay(stored);
      if (idempotent !== null) return idempotent;
      return sendError(reply, {
        code: 'nonce_replay',
        statusCode: 403,
        message: 'this nonce has already been used',
        requestId: request.id,
      });
    }
    // SEC-M4 — best-effort audit write. We're past every replay /
    // idempotent-200 branch above, so reaching here means the upsert
    // genuinely changed the linkage (a fresh link OR a re-point to a
    // different username). The SEC-M2 idempotent-replay 200 paths
    // return earlier and deliberately do NOT emit — nothing changed,
    // so a duplicate `github_link` event would be noise. `priorLink`
    // (read above for the replay check) carries the pre-existing
    // username, if any.
    await recordClaimEvent(opts.claimEventsRepo, request, {
      votePubkey: result.link.votePubkey,
      eventType: 'github_link',
      identityPubkey: existingClaim.identityPubkey,
      detail: {
        githubUsername: result.link.githubUsername,
        priorGithubUsername: priorLink?.githubUsername ?? null,
      },
      submittedIp: request.ip,
    });
    return linkResponse(result.link);
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
    // SEC-L1 — base58 of a 64-byte Solana tx signature is 86-88 chars.
    // The service (`operator-wallet-verification.service.ts`) already
    // base58-decodes and asserts the 64-byte length inside [86,88];
    // the schema bound is tightened to match so a future
    // refactor-by-schema can't silently re-widen this surface.
    anchorTxSignature: z.string().min(86).max(88),
  });

  app.post('/v1/claim/wallet/verify', async (request, reply) => {
    const body = unwrap(WalletVerifyBodySchema.safeParse(request.body), 'body');
    if (!freshnessOk(body.timestampMs)) {
      return sendError(reply, {
        code: 'stale_timestamp',
        statusCode: 403,
        message: 'timestampMs is outside the freshness window',
        requestId: request.id,
      });
    }
    const existingClaim = await opts.claimsRepo.findByVote(body.votePubkey);
    if (existingClaim === null) {
      return sendError(reply, {
        code: 'not_claimed',
        statusCode: 403,
        message: 'validator must be claimed before registering a wallet',
        requestId: request.id,
      });
    }
    if (existingClaim.identityPubkey !== body.identityPubkey) {
      return sendError(reply, {
        code: 'identity_mismatch',
        statusCode: 403,
        message: 'identity pubkey does not match claim',
        requestId: request.id,
      });
    }
    // Reject self-registration: registering the validator's own
    // vote or identity pubkey as an "operator wallet" pollutes
    // downstream analytics (e.g. Phase 4 wallet-activity grid) and
    // defeats the cold/warm separation the feature exists for.
    if (body.walletPubkey === body.identityPubkey || body.walletPubkey === body.votePubkey) {
      return sendError(reply, {
        code: 'pubkey_role_collision',
        statusCode: 400,
        message: 'walletPubkey must differ from identity and vote pubkeys',
        requestId: request.id,
      });
    }
    // SEC-L4 — soft cross-validator collision check. The self-check
    // above only catches THIS validator's own vote/identity. A
    // multi-validator operator could still register a SIBLING node's
    // identity key as an "operator wallet" — the co-signature
    // requirement blocks the real attack, but the mis-registration
    // would pollute the wallet-activity analytics with a key that is
    // actually a validator identity. If `walletPubkey` resolves to a
    // known validator's identity, reject with the same
    // `pubkey_role_collision` shape.
    const collidingValidator = await opts.validatorsRepo.findByIdentity(body.walletPubkey);
    if (collidingValidator !== null) {
      return sendError(reply, {
        code: 'pubkey_role_collision',
        statusCode: 400,
        message: "walletPubkey is another validator's identity pubkey",
        requestId: request.id,
      });
    }
    const count = await opts.operatorWalletsRepo.countByVote(body.votePubkey);
    if (count >= OPERATOR_WALLET_CAP_PER_VALIDATOR) {
      return sendError(reply, {
        code: 'wallet_cap_reached',
        statusCode: 409,
        message: `validator has the maximum ${OPERATOR_WALLET_CAP_PER_VALIDATOR} wallets`,
        requestId: request.id,
      });
    }
    const issuedNonce: OperatorWalletNonce = {
      purpose: OPERATOR_WALLET_NONCE_PURPOSE,
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
      // `code` stays the stable machine id; `message` is human prose
      // (REST-M2) — previously both were the bare `result.reason`.
      return sendError(reply, {
        code: result.reason,
        statusCode: 403,
        message: humanMessageForWalletFailure(result.reason),
        requestId: request.id,
      });
    }
    // TS-M6: the repo catches the pg constraint violations
    // (`23514` check_violation = the 3-wallet cap trigger lost a
    // race; `23505` unique_violation = a `signed_nonce` replay) and
    // returns a typed `reason` — the route no longer inspects
    // SQLSTATE strings, it branches on the domain value.
    const insertResult = await opts.operatorWalletsRepo.insert(result.wallet);
    if (!insertResult.ok) {
      if (insertResult.reason === 'wallet_cap_reached') {
        return sendError(reply, {
          code: 'wallet_cap_reached',
          statusCode: 409,
          message: 'wallet cap exceeded (race)',
          requestId: request.id,
        });
      }
      // reason === 'nonce_replay'
      return sendError(reply, {
        code: 'nonce_replay',
        statusCode: 403,
        message: 'this nonce has already been used',
        requestId: request.id,
      });
    }
    // SEC-M4 — best-effort audit write. Reaching here means the
    // INSERT committed: a genuinely new operator wallet (the cap-race
    // and nonce-replay branches above return earlier). A throw is
    // logged + swallowed; see `recordClaimEvent`.
    await recordClaimEvent(opts.claimEventsRepo, request, {
      votePubkey: result.wallet.votePubkey,
      eventType: 'wallet_register',
      identityPubkey: existingClaim.identityPubkey,
      detail: {
        walletPubkey: result.wallet.walletPubkey,
        label: result.wallet.label,
      },
      submittedIp: request.ip,
    });
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
