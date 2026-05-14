import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/core/config.js';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import claimRoutes, { type ClaimRoutesDeps } from '../../../src/api/routes/claim.route.js';
import type { ClaimService, ClaimVerifyResult } from '../../../src/services/claim.service.js';
import type { OperatorWalletsRepository } from '../../../src/storage/repositories/operator-wallets.repo.js';
import type { ValidatorClaimEventsRepository } from '../../../src/storage/repositories/validator-claim-events.repo.js';
import type { ValidatorGithubRepository } from '../../../src/storage/repositories/validator-github.repo.js';
import type {
  OperatorWallet,
  ValidatorClaim,
  ValidatorClaimEvent,
  ValidatorGithubLink,
  ValidatorProfile,
} from '../../../src/types/domain.js';
import { IDENTITY_1, makeTestApp, VOTE_1 } from './_fakes.js';

const silent = pino({ level: 'silent' });

// 88-char base58 string — inside the route's signature length bounds.
const SIG_B58 = 'z'.repeat(88);

function makeConfig(): AppConfig {
  // The claim route reads nothing structural off config in the paths
  // under test (the service owns freshness/eligibility). Cast a stub.
  return { SITE_URL: 'https://whoearns.live' } as unknown as AppConfig;
}

function makeClaim(): ValidatorClaim {
  return {
    votePubkey: VOTE_1,
    identityPubkey: IDENTITY_1,
    claimedAt: new Date('2026-01-01T00:00:00Z'),
    lastNonceUsed: 'nonce',
  };
}

function makeProfile(over: Partial<ValidatorProfile> = {}): ValidatorProfile {
  return {
    votePubkey: VOTE_1,
    twitterHandle: 'operator',
    hideFooterCta: false,
    optedOut: false,
    narrativeOverride: null,
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

function makeGithubLink(over: Partial<ValidatorGithubLink> = {}): ValidatorGithubLink {
  return {
    votePubkey: VOTE_1,
    githubUsername: 'operator-gh',
    gistUrl: 'https://gist.github.com/operator-gh/abc',
    gistId: 'abc',
    signedNonce: 'gh-nonce',
    verifiedAt: new Date('2026-02-01T00:00:00Z'),
    expiresAt: new Date('2026-05-01T00:00:00Z'),
    ...over,
  };
}

function makeWallet(over: Partial<OperatorWallet> = {}): OperatorWallet {
  return {
    votePubkey: VOTE_1,
    walletPubkey: 'WALL111111111111111111111111111111111111111',
    label: 'hot',
    signedNonce: 'wallet-nonce',
    anchorTxSignature: 'z'.repeat(88),
    registeredAt: new Date('2026-02-01T00:00:00Z'),
    expiresAt: new Date('2026-05-01T00:00:00Z'),
    ...over,
  };
}

/**
 * The claim route's deps are the full `ClaimService` class plus a
 * narrow `Pick<>` events repo and (CROSS-M1) the github-link +
 * operator-wallet read repos. Each is cast from a minimal fake (same
 * trick as `epochs.route.test.ts`); `overrides` swap one behaviour
 * per test.
 */
function buildDeps(
  overrides: {
    claim?: ValidatorClaim | null;
    profile?: ValidatorProfile | null;
    verifyResult?: ClaimVerifyResult;
    updateResult?: Awaited<ReturnType<ClaimService['updateProfile']>>;
    auditEvents?: ValidatorClaimEvent[];
    githubLink?: ValidatorGithubLink | null;
    activeWallets?: OperatorWallet[];
  } = {},
): { deps: ClaimRoutesDeps; appended: unknown[] } {
  const appended: unknown[] = [];
  const claim = overrides.claim === undefined ? makeClaim() : overrides.claim;
  const profile = overrides.profile === undefined ? null : overrides.profile;
  const service = {
    getClaim: async () => claim,
    getProfile: async () => profile,
    verifySigned: async (): Promise<ClaimVerifyResult> =>
      overrides.verifyResult ?? { ok: true, claim: makeClaim() },
    updateProfile: async () => overrides.updateResult ?? { ok: true, profile: makeProfile() },
  };
  const deps: ClaimRoutesDeps = {
    config: makeConfig(),
    claimService: service as unknown as ClaimService,
    claimEventsRepo: {
      append: async (e: unknown) => {
        appended.push(e);
      },
      listByVote: async () => overrides.auditEvents ?? [],
    } as unknown as Pick<ValidatorClaimEventsRepository, 'append' | 'listByVote'>,
    validatorGithubRepo: {
      findActiveByVote: async () =>
        overrides.githubLink === undefined ? null : overrides.githubLink,
    } as unknown as Pick<ValidatorGithubRepository, 'findActiveByVote'>,
    operatorWalletsRepo: {
      listActiveByVote: async () => overrides.activeWallets ?? [],
    } as unknown as Pick<OperatorWalletsRepository, 'listActiveByVote'>,
  };
  return { deps, appended };
}

async function makeApp(deps: ClaimRoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(claimRoutes, deps);
  return app;
}

const signedEnvelope = (over: Record<string, unknown> = {}) => ({
  votePubkey: VOTE_1,
  identityPubkey: IDENTITY_1,
  nonce: 'nonce-12345678',
  timestampSec: Math.floor(Date.now() / 1000),
  signatureBase58: SIG_B58,
  ...over,
});

describe('GET /v1/claim/challenge', () => {
  it('returns a fresh nonce and timestamp', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: '/v1/claim/challenge' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.nonce).toBe('string');
    expect(typeof body.timestampSec).toBe('number');
    expect(body.expiresInSec).toBe(300);
    await app.close();
  });
});

describe('GET /v1/claim/:vote/status', () => {
  it('reports claimed:false with a null profile when never claimed', async () => {
    const { deps } = buildDeps({ claim: null, profile: null });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claim/${VOTE_1}/status` });
    expect(res.statusCode).toBe(200);
    // CROSS-M1 — the envelope now also carries `githubLink` (null when
    // no ACTIVE link) and a `wallets` summary (zeroed when none).
    expect(res.json()).toEqual({
      claimed: false,
      profile: null,
      githubLink: null,
      wallets: { count: 0, capReached: false, oldestExpiresAt: null },
    });
    await app.close();
  });

  it('reports claimed:true plus the profile when claimed and edited', async () => {
    const { deps } = buildDeps({ claim: makeClaim(), profile: makeProfile() });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claim/${VOTE_1}/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claimed).toBe(true);
    expect(body.profile.twitterHandle).toBe('operator');
    await app.close();
  });

  it('folds in the ACTIVE GitHub link and operator-wallet summary (CROSS-M1)', async () => {
    const { deps } = buildDeps({
      claim: makeClaim(),
      githubLink: makeGithubLink({ githubUsername: 'alice' }),
      activeWallets: [
        makeWallet({ expiresAt: new Date('2026-06-01T00:00:00Z') }),
        // Soonest-expiring active registration → drives oldestExpiresAt.
        makeWallet({
          walletPubkey: 'WALL222222222222222222222222222222222222222',
          expiresAt: new Date('2026-05-15T00:00:00Z'),
        }),
      ],
    });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claim/${VOTE_1}/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.githubLink).toEqual({
      githubUsername: 'alice',
      verifiedAt: '2026-02-01T00:00:00.000Z',
      expiresAt: '2026-05-01T00:00:00.000Z',
    });
    expect(body.wallets.count).toBe(2);
    // Two of three → cap (3) not reached.
    expect(body.wallets.capReached).toBe(false);
    // MIN expiry across the active rows.
    expect(body.wallets.oldestExpiresAt).toBe('2026-05-15T00:00:00.000Z');
    await app.close();
  });

  it('reports capReached once the operator-wallet cap is hit (CROSS-M1)', async () => {
    const { deps } = buildDeps({
      claim: makeClaim(),
      githubLink: null,
      activeWallets: [
        makeWallet({ walletPubkey: 'WALL111111111111111111111111111111111111111' }),
        makeWallet({ walletPubkey: 'WALL222222222222222222222222222222222222222' }),
        makeWallet({ walletPubkey: 'WALL333333333333333333333333333333333333333' }),
      ],
    });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claim/${VOTE_1}/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.githubLink).toBeNull();
    expect(body.wallets.count).toBe(3);
    expect(body.wallets.capReached).toBe(true);
    await app.close();
  });

  it('returns 400 on a malformed vote path parameter', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: '/v1/claim/not-a-pubkey/status' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });
});

describe('GET /v1/claim/:vote/audit', () => {
  it('returns the audit events newest-first without the forensic submittedIp', async () => {
    const event: ValidatorClaimEvent = {
      id: 1,
      votePubkey: VOTE_1,
      eventType: 'claim',
      identityPubkey: IDENTITY_1,
      priorIdentityPubkey: null,
      detail: null,
      submittedIp: '203.0.113.7',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const { deps } = buildDeps({ auditEvents: [event] });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claim/${VOTE_1}/audit` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('claim');
    expect(body.events[0]).not.toHaveProperty('submittedIp');
    await app.close();
  });
});

describe('POST /v1/claim/verify', () => {
  it('verifies a claim on the happy path and writes an audit event', async () => {
    const { deps, appended } = buildDeps({
      claim: null, // no prior claim → first-ever `claim` event
      verifyResult: { ok: true, claim: makeClaim() },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/verify',
      payload: signedEnvelope(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().claimed).toBe(true);
    expect(appended).toHaveLength(1);
    expect((appended[0] as { eventType: string }).eventType).toBe('claim');
    await app.close();
  });

  it('returns 400 on a malformed body', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/verify',
      payload: signedEnvelope({ signatureBase58: 'short' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('returns 404 when the service reports validator_not_found', async () => {
    const { deps } = buildDeps({
      verifyResult: { ok: false, reason: 'validator_not_found' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/verify',
      payload: signedEnvelope(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('validator_not_found');
    await app.close();
  });

  it('returns 403 when the service reports a nonce replay', async () => {
    const { deps } = buildDeps({
      verifyResult: { ok: false, reason: 'nonce_replay' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/verify',
      payload: signedEnvelope(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('nonce_replay');
    await app.close();
  });
});

describe('POST /v1/claim/profile', () => {
  it('updates the profile on the happy path and writes a profile_update audit event', async () => {
    const { deps, appended } = buildDeps({
      updateResult: { ok: true, profile: makeProfile({ optedOut: true }) },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/profile',
      payload: signedEnvelope({
        profile: { twitterHandle: 'operator', hideFooterCta: false, optedOut: true },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.optedOut).toBe(true);
    expect(appended).toHaveLength(1);
    expect((appended[0] as { eventType: string }).eventType).toBe('profile_update');
    await app.close();
  });

  it('returns 403 when the profile-update signature fails verification', async () => {
    const { deps } = buildDeps({
      updateResult: { ok: false, reason: 'bad_signature' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/claim/profile',
      payload: signedEnvelope({
        profile: { twitterHandle: 'operator', hideFooterCta: false, optedOut: false },
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_signature');
    await app.close();
  });
});
