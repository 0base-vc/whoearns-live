import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/core/config.js';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import claimV2Routes, { type ClaimV2RoutesDeps } from '../../../src/api/routes/claim-v2.route.js';
import type { GithubGistVerificationService } from '../../../src/services/github-gist-verification.service.js';
import type { OperatorWalletVerificationService } from '../../../src/services/operator-wallet-verification.service.js';
import type { ClaimsRepository } from '../../../src/storage/repositories/claims.repo.js';
import type {
  OperatorWalletInsertResult,
  OperatorWalletsRepository,
} from '../../../src/storage/repositories/operator-wallets.repo.js';
import type { ValidatorClaimEventsRepository } from '../../../src/storage/repositories/validator-claim-events.repo.js';
import type {
  ValidatorGithubRepository,
  ValidatorGithubUpsertResult,
} from '../../../src/storage/repositories/validator-github.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type {
  Validator,
  ValidatorClaim,
  ValidatorGithubLink,
  OperatorWallet,
} from '../../../src/types/domain.js';
import { IDENTITY_1, makeTestApp, VOTE_1 } from './_fakes.js';

const silent = pino({ level: 'silent' });

// 88-char base58 string — satisfies the wallet route's signature
// length bounds (min 64 / max 128 for sigs, min 86 / max 88 for the
// memo tx — SEC-L1 tightened the memo-tx bound to match the service).
const SIG_B58 = 'z'.repeat(88);
const MEMO_TX_B58 = 'y'.repeat(88);
const WALLET_1 = 'WALL111111111111111111111111111111111111111';

function makeConfig(): AppConfig {
  // The route only reads `config.SITE_URL` (folded into the canonical
  // nonce). Cast the rest — a full AppConfig is large and irrelevant
  // to the gating logic under test here.
  return { SITE_URL: 'https://whoearns.live' } as unknown as AppConfig;
}

function makeClaim(): ValidatorClaim {
  return {
    votePubkey: VOTE_1,
    identityPubkey: IDENTITY_1,
    claimedAt: new Date(),
    lastNonceUsed: 'nonce',
  };
}

function makeLink(overrides: Partial<ValidatorGithubLink> = {}): ValidatorGithubLink {
  return {
    votePubkey: VOTE_1,
    githubUsername: 'operator-gh',
    gistUrl: 'https://gist.github.com/operator-gh/abc',
    gistId: 'abc',
    signedNonce: 'signed-nonce-1',
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

function makeWallet(overrides: Partial<OperatorWallet> = {}): OperatorWallet {
  return {
    votePubkey: VOTE_1,
    walletPubkey: WALLET_1,
    label: 'hot',
    signedNonce: 'wallet-nonce-1',
    memoTxSignature: MEMO_TX_B58,
    registeredAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

/**
 * The claim-v2 route's deps include full repo/service classes (not
 * `Pick<>`), so each fake is built minimally and cast — same trick as
 * `epochs.route.test.ts`. `overrides` swap one behaviour per test.
 */
function buildDeps(
  overrides: {
    claim?: ValidatorClaim | null;
    gistVerify?: Awaited<ReturnType<GithubGistVerificationService['verify']>>;
    priorLink?: ValidatorGithubLink | null;
    githubUpsert?: ValidatorGithubUpsertResult;
    storedLinkAfterUpsert?: ValidatorGithubLink | null;
    walletVerify?: Awaited<ReturnType<OperatorWalletVerificationService['verify']>>;
    walletCount?: number;
    walletInsert?: OperatorWalletInsertResult;
    /** DELETE `/wallets/:wallet` — the unregister-ceremony sig check. */
    walletUnregisterVerify?: Awaited<
      ReturnType<OperatorWalletVerificationService['verifyUnregister']>
    >;
    /** DELETE `/wallets/:wallet` — repo `delete` result (false = miss). */
    walletDelete?: boolean;
    /**
     * SEC-L4 — when set, `validatorsRepo.findByIdentity` resolves to a
     * validator (i.e. the submitted `walletPubkey` collides with some
     * OTHER validator's identity pubkey). Default `null` = no collision.
     */
    walletPubkeyIsValidatorIdentity?: boolean;
  } = {},
): { deps: ClaimV2RoutesDeps; appended: unknown[] } {
  const claim = overrides.claim === undefined ? makeClaim() : overrides.claim;
  const appended: unknown[] = [];
  const githubRepo = {
    findByVote: async () => (overrides.priorLink === undefined ? null : overrides.priorLink),
    upsert: async () => overrides.githubUpsert ?? { ok: true },
  };
  // After the upsert path returns `nonce_replay`, the route re-reads
  // by vote — `storedLinkAfterUpsert` feeds that second read.
  if (overrides.storedLinkAfterUpsert !== undefined) {
    let call = 0;
    githubRepo.findByVote = async () => {
      call += 1;
      // 1st read = the route's pre-upsert replay probe (no prior row);
      // 2nd read = the post-23505 re-read.
      return call === 1 ? null : (overrides.storedLinkAfterUpsert ?? null);
    };
  }
  const deps: ClaimV2RoutesDeps = {
    config: makeConfig(),
    claimsRepo: {
      findByVote: async (v: string) => (v === VOTE_1 ? claim : null),
    } as unknown as ClaimsRepository,
    // SEC-L4 — `findByIdentity` resolves only when the test opts into
    // the cross-validator collision case; otherwise `null` (no match).
    validatorsRepo: {
      findByIdentity: async () =>
        overrides.walletPubkeyIsValidatorIdentity === true
          ? ({ votePubkey: 'OtherVote', identityPubkey: WALLET_1 } as unknown as Validator)
          : null,
    } as unknown as ValidatorsRepository,
    validatorGithubRepo: githubRepo as unknown as ValidatorGithubRepository,
    operatorWalletsRepo: {
      countByVote: async () => overrides.walletCount ?? 0,
      insert: async () => overrides.walletInsert ?? { ok: true },
      // DELETE `/wallets/:wallet` — `true` = a row was hard-deleted.
      delete: async () => overrides.walletDelete ?? true,
    } as unknown as OperatorWalletsRepository,
    githubGistService: {
      verify: async () => overrides.gistVerify ?? { ok: true, link: makeLink() },
    } as unknown as GithubGistVerificationService,
    operatorWalletService: {
      verify: async () => overrides.walletVerify ?? { ok: true, wallet: makeWallet() },
      // The unregister ceremony's identity-signature check.
      verifyUnregister: async () => overrides.walletUnregisterVerify ?? { ok: true },
    } as unknown as OperatorWalletVerificationService,
    claimEventsRepo: {
      append: async (e: unknown) => {
        appended.push(e);
      },
    } as unknown as ValidatorClaimEventsRepository,
  };
  return { deps, appended };
}

async function makeApp(deps: ClaimV2RoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(claimV2Routes, deps);
  return app;
}

const githubBody = (over: Record<string, unknown> = {}) => ({
  votePubkey: VOTE_1,
  identityPubkey: IDENTITY_1,
  githubUsername: 'operator-gh',
  gistUrl: 'https://gist.github.com/operator-gh/abc',
  timestampMs: Date.now(),
  ...over,
});

const walletBody = (over: Record<string, unknown> = {}) => ({
  votePubkey: VOTE_1,
  identityPubkey: IDENTITY_1,
  walletPubkey: WALLET_1,
  label: 'hot',
  timestampMs: Date.now(),
  identitySignatureB58: SIG_B58,
  memoTxSignature: MEMO_TX_B58,
  ...over,
});

describe('PUT /v1/claims/:vote/github', () => {
  it('links a GitHub username on the happy path and writes an audit event', async () => {
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/github`,
      payload: githubBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().link.githubUsername).toBe('operator-gh');
    expect(appended).toHaveLength(1);
    await app.close();
  });

  it('returns 400 on a malformed body (invalid GitHub username)', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/github`,
      payload: githubBody({ githubUsername: 'not a valid username!' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('returns 400 vote_pubkey_mismatch when the path vote disagrees with the body', async () => {
    // REST-M7 — the vote pubkey rides in the path AND the request
    // body; the body stays authoritative for the Gist proof, and a
    // path pointing at a different validator is rejected up front.
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${IDENTITY_1}/github`, // valid pubkey, but != body.votePubkey (VOTE_1)
      payload: githubBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('vote_pubkey_mismatch');
    // Rejected before any verification work — no audit event.
    expect(appended).toHaveLength(0);
    await app.close();
  });

  it('returns 403 stale_timestamp when the timestamp is outside the freshness window', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/github`,
      payload: githubBody({ timestampMs: Date.now() - 60 * 60 * 1000 }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('stale_timestamp');
    await app.close();
  });

  it('returns 403 not_claimed when the validator has no claim', async () => {
    const { deps } = buildDeps({ claim: null });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/github`,
      payload: githubBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_claimed');
    await app.close();
  });

  it('returns 502 when the Gist fetch fails', async () => {
    const { deps } = buildDeps({
      gistVerify: { ok: false, reason: 'fetch_failed', detail: 'timeout' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/github`,
      payload: githubBody(),
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('returns 403 nonce_replay when the repo upsert reports a genuine replay (TS-M6)', async () => {
    // The repo catches pg 23505 and returns `{ ok: false, reason:
    // 'nonce_replay' }`; the route re-reads by vote, finds a row that
    // links a DIFFERENT username → genuine replay → 403.
    const { deps } = buildDeps({
      githubUpsert: { ok: false, reason: 'nonce_replay' },
      storedLinkAfterUpsert: makeLink({ githubUsername: 'someone-else' }),
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/github`,
      payload: githubBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('nonce_replay');
    await app.close();
  });

  it('returns idempotent 200 when the repo upsert replays but the stored row links the same username (SEC-M2)', async () => {
    // Same `nonce_replay` repo result, but the re-read finds a row
    // that already encodes the SAME linkage this request wanted — the
    // operator's intent is satisfied, so 200 with the existing link.
    const { deps, appended } = buildDeps({
      githubUpsert: { ok: false, reason: 'nonce_replay' },
      storedLinkAfterUpsert: makeLink({ githubUsername: 'operator-gh' }),
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/github`,
      payload: githubBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().link.githubUsername).toBe('operator-gh');
    // The idempotent-replay path must NOT emit an audit event —
    // nothing changed.
    expect(appended).toHaveLength(0);
    await app.close();
  });
});

describe('POST /v1/claims/:vote/wallets', () => {
  it('registers an operator wallet on the happy path and writes an audit event', async () => {
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(appended).toHaveLength(1);
    // SEC — the response carries only the truncated `walletAddressShort`
    // (`WALL…1111` for `WALLET_1`). The full operator-wallet pubkey
    // must NOT appear on the `wallet` object, nor anywhere in the body.
    const body = res.json();
    expect(body.wallet).not.toHaveProperty('walletPubkey');
    expect(body.wallet.walletAddressShort).toBe('WALL…1111');
    expect(JSON.stringify(body)).not.toContain(WALLET_1);
    await app.close();
  });

  it('ignores legacy walletSignatureB58 on the memo transaction path', async () => {
    const verifyCalls: unknown[] = [];
    const { deps } = buildDeps();
    deps.operatorWalletService = {
      verify: async (args: unknown) => {
        verifyCalls.push(args);
        return { ok: true, wallet: makeWallet() };
      },
    } as unknown as OperatorWalletVerificationService;
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody({ walletSignatureB58: 'legacy-wallet-signature-must-be-ignored' }),
    });
    expect(res.statusCode).toBe(200);
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]).toMatchObject({
      identitySignatureB58: SIG_B58,
      memoTxSignature: MEMO_TX_B58,
    });
    expect(verifyCalls[0]).not.toHaveProperty('walletSignatureB58');
    expect(verifyCalls[0]).not.toHaveProperty('anchorTxSignature');
    await app.close();
  });

  it('returns 400 on a malformed body (signature too short)', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody({ identitySignatureB58: 'short' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects wallet label containing a BiDi-override codepoint (SEC-M1)', async () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) lets an operator flip the
    // visual order of surrounding hub copy — a phishing-friendly
    // attack on the public ActivityHeatmap header. The narrativeOverride
    // schema rejects the same codepoints; this mirrors that posture
    // for wallet labels.
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody({ label: 'hot‮BADGE' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    // Rejected at the schema layer, before any verify/insert work.
    expect(appended).toHaveLength(0);
    await app.close();
  });

  it('rejects wallet label with angle brackets (HTML injection guard)', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody({ label: '<script>' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('returns 400 vote_pubkey_mismatch when the path vote disagrees with the body', async () => {
    // REST-M7 — the vote pubkey rides in the path AND the request
    // body; the body stays authoritative for the dual-signature
    // proof, and a path pointing at a different validator is rejected
    // before any verification work.
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${IDENTITY_1}/wallets`, // valid pubkey, but != body.votePubkey (VOTE_1)
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('vote_pubkey_mismatch');
    expect(appended).toHaveLength(0);
    await app.close();
  });

  it('returns 400 pubkey_role_collision when the wallet equals the vote pubkey', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody({ walletPubkey: VOTE_1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pubkey_role_collision');
    await app.close();
  });

  it("returns 400 pubkey_role_collision when the wallet is another validator's identity (SEC-L4)", async () => {
    // `walletPubkey` differs from THIS validator's vote/identity (so it
    // clears the self-collision gate) but resolves via `findByIdentity`
    // to some other validator's identity pubkey — a sibling-node
    // mis-registration that would pollute wallet-activity analytics.
    const { deps, appended } = buildDeps({ walletPubkeyIsValidatorIdentity: true });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pubkey_role_collision');
    // Rejected before the verify/insert path — no audit event emitted.
    expect(appended).toHaveLength(0);
    await app.close();
  });

  it('returns 409 wallet_cap_reached when the count gate is already at the cap', async () => {
    const { deps } = buildDeps({ walletCount: 3 });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('wallet_cap_reached');
    await app.close();
  });

  it('returns 409 wallet_cap_reached when the repo insert loses the cap race (TS-M6)', async () => {
    // Count gate passed, but the repo's INSERT hit the pg 23514 cap
    // trigger — the repo returns `{ ok: false, reason:
    // 'wallet_cap_reached' }` and the route maps it to 409 with no
    // SQLSTATE knowledge.
    const { deps } = buildDeps({
      walletInsert: { ok: false, reason: 'wallet_cap_reached' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('wallet_cap_reached');
    await app.close();
  });

  it('returns 403 nonce_replay when the repo insert reports a replay (TS-M6)', async () => {
    const { deps } = buildDeps({
      walletInsert: { ok: false, reason: 'nonce_replay' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('nonce_replay');
    await app.close();
  });

  it('returns 403 when the identity CLI signature verification fails', async () => {
    const { deps } = buildDeps({
      walletVerify: { ok: false, reason: 'bad_identity_signature' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_identity_signature');
    await app.close();
  });

  it('returns 403 when the memo transaction does not carry the canonical nonce', async () => {
    const { deps } = buildDeps({
      walletVerify: { ok: false, reason: 'memo_mismatch' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('memo_mismatch');
    await app.close();
  });

  it('returns 502 when the Solana RPC is unavailable during memo-tx verification', async () => {
    // `memo_tx_rpc_unavailable` is the lone transient failure — the
    // route maps it to 502 (retry) rather than the 403 proof-failed
    // family.
    const { deps } = buildDeps({
      walletVerify: { ok: false, reason: 'memo_tx_rpc_unavailable' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/claims/${VOTE_1}/wallets`,
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('memo_tx_rpc_unavailable');
    await app.close();
  });
});

const unregisterBody = (over: Record<string, unknown> = {}) => ({
  votePubkey: VOTE_1,
  identityPubkey: IDENTITY_1,
  walletPubkey: WALLET_1,
  timestampMs: Date.now(),
  identitySignatureB58: SIG_B58,
  ...over,
});

describe('DELETE /v1/claims/:vote/wallets/:wallet', () => {
  it('unregisters a wallet on the happy path and serves only the truncated address', async () => {
    // SEC — the success response is `{ unregistered: { walletAddressShort } }`
    // — only the truncated `WALL…1111` form. The full operator-wallet
    // pubkey must NOT appear on the `unregistered` object, nor anywhere
    // in the response body.
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/claims/${VOTE_1}/wallets/${WALLET_1}`,
      payload: unregisterBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(appended).toHaveLength(1);
    const body = res.json();
    expect(body.unregistered).not.toHaveProperty('walletPubkey');
    expect(body.unregistered.walletAddressShort).toBe('WALL…1111');
    expect(JSON.stringify(body)).not.toContain(WALLET_1);
    await app.close();
  });

  it('returns 404 wallet_not_registered when no (vote, wallet) row matches', async () => {
    const { deps } = buildDeps({ walletDelete: false });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/claims/${VOTE_1}/wallets/${WALLET_1}`,
      payload: unregisterBody(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('wallet_not_registered');
    await app.close();
  });
});
