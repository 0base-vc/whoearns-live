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
import type {
  ValidatorClaim,
  ValidatorGithubLink,
  OperatorWallet,
} from '../../../src/types/domain.js';
import { IDENTITY_1, makeTestApp, VOTE_1 } from './_fakes.js';

const silent = pino({ level: 'silent' });

// 88-char base58 string — satisfies the wallet route's signature
// length bounds (min 64 / max 128 for sigs, 64–96 for the anchor tx).
const SIG_B58 = 'z'.repeat(88);
const ANCHOR_B58 = 'z'.repeat(88);
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
    anchorTxSignature: ANCHOR_B58,
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
    validatorGithubRepo: githubRepo as unknown as ValidatorGithubRepository,
    operatorWalletsRepo: {
      countByVote: async () => overrides.walletCount ?? 0,
      insert: async () => overrides.walletInsert ?? { ok: true },
    } as unknown as OperatorWalletsRepository,
    githubGistService: {
      verify: async () => overrides.gistVerify ?? { ok: true, link: makeLink() },
    } as unknown as GithubGistVerificationService,
    operatorWalletService: {
      verify: async () => overrides.walletVerify ?? { ok: true, wallet: makeWallet() },
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
  walletSignatureB58: SIG_B58,
  anchorTxSignature: ANCHOR_B58,
  ...over,
});

describe('POST /v1/claim/github/verify', () => {
  it('links a GitHub username on the happy path and writes an audit event', async () => {
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/github/verify',
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
      method: 'POST',
      url: '/v1/claim/github/verify',
      payload: githubBody({ githubUsername: 'not a valid username!' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('returns 403 stale_timestamp when the timestamp is outside the freshness window', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/github/verify',
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
      method: 'POST',
      url: '/v1/claim/github/verify',
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
      method: 'POST',
      url: '/v1/claim/github/verify',
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
      method: 'POST',
      url: '/v1/claim/github/verify',
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
      method: 'POST',
      url: '/v1/claim/github/verify',
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

describe('POST /v1/claim/wallet/verify', () => {
  it('registers an operator wallet on the happy path and writes an audit event', async () => {
    const { deps, appended } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/wallet/verify',
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().wallet.walletPubkey).toBe(WALLET_1);
    expect(appended).toHaveLength(1);
    await app.close();
  });

  it('returns 400 on a malformed body (signature too short)', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/wallet/verify',
      payload: walletBody({ identitySignatureB58: 'short' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('returns 400 pubkey_role_collision when the wallet equals the vote pubkey', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/wallet/verify',
      payload: walletBody({ walletPubkey: VOTE_1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pubkey_role_collision');
    await app.close();
  });

  it('returns 409 wallet_cap_reached when the count gate is already at the cap', async () => {
    const { deps } = buildDeps({ walletCount: 3 });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/wallet/verify',
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
      url: '/v1/claim/wallet/verify',
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
      url: '/v1/claim/wallet/verify',
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('nonce_replay');
    await app.close();
  });

  it('returns 403 when the dual-signature verification fails', async () => {
    const { deps } = buildDeps({
      walletVerify: { ok: false, reason: 'bad_wallet_signature' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/wallet/verify',
      payload: walletBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_wallet_signature');
    await app.close();
  });
});
