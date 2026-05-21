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
import type { WalletActivityRepository } from '../../../src/storage/repositories/wallet-activity.repo.js';
import type {
  OperatorWallet,
  ValidatorClaim,
  ValidatorClaimEvent,
  ValidatorGithubLink,
  ValidatorProfile,
  WalletDailyActivity,
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
    publicRef: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    label: 'hot',
    signedNonce: 'wallet-nonce',
    memoTxSignature: 'z'.repeat(88),
    registeredAt: new Date('2026-02-01T00:00:00Z'),
    expiresAt: new Date('2026-05-01T00:00:00Z'),
    ...over,
  };
}

function makeActivityRow(over: Partial<WalletDailyActivity> = {}): WalletDailyActivity {
  return {
    walletPubkey: 'WALL111111111111111111111111111111111111111',
    activityDate: new Date('2026-05-01T00:00:00Z'),
    txCount: 4,
    txFeesLamports: 0n,
    indexedAt: new Date(),
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
    /**
     * Flat list of activity rows the batched `listRecentForWallets`
     * returns — the handler groups them per wallet. `walletsSeen`
     * captures the pubkey list the handler passed, so a test can
     * assert it was a SINGLE batched call over all the validator's
     * wallets.
     */
    activityRows?: WalletDailyActivity[];
  } = {},
): { deps: ClaimRoutesDeps; appended: unknown[]; walletsSeen: string[][] } {
  const appended: unknown[] = [];
  const walletsSeen: string[][] = [];
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
    walletActivityRepo: {
      listRecentForWallets: async (wallets: ReadonlyArray<string>) => {
        walletsSeen.push([...wallets]);
        return overrides.activityRows ?? [];
      },
    } as unknown as Pick<WalletActivityRepository, 'listRecentForWallets'>,
  };
  return { deps, appended, walletsSeen };
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

describe('GET /v1/claims/challenge', () => {
  it('returns a fresh nonce and timestamp', async () => {
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: '/v1/claims/challenge' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.nonce).toBe('string');
    expect(typeof body.timestampSec).toBe('number');
    expect(body.expiresInSec).toBe(300);
    await app.close();
  });
});

describe('GET /v1/claims/:vote', () => {
  it('reports claimed:false with a null profile when never claimed', async () => {
    const { deps } = buildDeps({ claim: null, profile: null });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}` });
    expect(res.statusCode).toBe(200);
    // CROSS-M1 — the envelope now also carries `githubLink` (null when
    // no ACTIVE link) and a `wallets` summary (zeroed when none).
    expect(res.json()).toEqual({
      claimed: false,
      profile: null,
      githubLink: null,
      wallets: { count: 0, capReached: false, oldestExpiresAt: null, entries: [] },
    });
    await app.close();
  });

  it('reports claimed:true plus the profile when claimed and edited', async () => {
    const { deps } = buildDeps({ claim: makeClaim(), profile: makeProfile() });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claimed).toBe(true);
    expect(body.profile.twitterHandle).toBe('operator');
    await app.close();
  });

  it('folds in the ACTIVE GitHub link and operator-wallet summary (CROSS-M1)', async () => {
    // Distinct `registeredAt` per fixture so a regression that
    // accidentally re-sorts entries[] is detectable. Pre-fix the
    // two fixtures shared the same registeredAt, so any swap was
    // undetectable.
    const { deps } = buildDeps({
      claim: makeClaim(),
      githubLink: makeGithubLink({ githubUsername: 'alice' }),
      activeWallets: [
        makeWallet({
          walletPubkey: 'WALL111111111111111111111111111111111111111',
          publicRef: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
          label: 'first-registered',
          registeredAt: new Date('2026-02-01T00:00:00Z'),
          expiresAt: new Date('2026-06-01T00:00:00Z'),
        }),
        // Soonest-expiring active registration → drives oldestExpiresAt.
        makeWallet({
          walletPubkey: 'WALL222222222222222222222222222222222222222',
          publicRef: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
          label: 'second-registered',
          registeredAt: new Date('2026-02-15T00:00:00Z'),
          expiresAt: new Date('2026-05-15T00:00:00Z'),
        }),
      ],
    });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}` });
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
    // Per-wallet entries surface the opaque `walletRef` + a
    // DISPLAY-ONLY truncated address (`walletAddressShort`) + label +
    // windows. We assert the EXACT shape AND ordering — the repo
    // serves rows in `registered_at ASC`, so a regression that
    // re-orders (or swaps fields) shows up as a diff. `activity` is
    // null because this request omits `?includeActivity`.
    expect(body.wallets.entries).toEqual([
      {
        walletRef: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        walletAddressShort: 'WALL…1111',
        label: 'first-registered',
        registeredAt: '2026-02-01T00:00:00.000Z',
        expiresAt: '2026-06-01T00:00:00.000Z',
        activity: null,
      },
      {
        walletRef: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        walletAddressShort: 'WALL…2222',
        label: 'second-registered',
        registeredAt: '2026-02-15T00:00:00.000Z',
        expiresAt: '2026-05-15T00:00:00.000Z',
        activity: null,
      },
    ]);
    // The full operator-wallet pubkey must NOT appear anywhere in the
    // response body — only the truncated `WALL…NNNN` form + the
    // opaque `walletRef`.
    expect(res.body).not.toContain('WALL111111111111111111111111111111111111111');
    expect(res.body).not.toContain('WALL222222222222222222222222222222222222222');
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
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}` });
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
    const res = await app.inject({ method: 'GET', url: '/v1/claims/not-a-pubkey' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('omits per-wallet activity when ?includeActivity is absent (no batched query)', async () => {
    const { deps, walletsSeen } = buildDeps({
      claim: makeClaim(),
      activeWallets: [makeWallet()],
      activityRows: [makeActivityRow()],
    });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // `activity` is null on every entry and the activity repo was
    // never queried — the extra batched read is paid for ONLY when
    // the caller opts in.
    expect(body.wallets.entries[0].activity).toBeNull();
    expect(walletsSeen).toHaveLength(0);
    await app.close();
  });

  it('inlines each wallet 365-day activity when ?includeActivity is truthy (one batched query)', async () => {
    const { deps, walletsSeen } = buildDeps({
      claim: makeClaim(),
      activeWallets: [
        makeWallet({
          walletPubkey: 'WALL111111111111111111111111111111111111111',
          publicRef: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
          label: 'hot',
        }),
        makeWallet({
          walletPubkey: 'WALL222222222222222222222222222222222222222',
          publicRef: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
          label: 'cold',
        }),
      ],
      // Flat rows across BOTH wallets — the handler groups per wallet.
      activityRows: [
        makeActivityRow({
          walletPubkey: 'WALL111111111111111111111111111111111111111',
          activityDate: new Date('2026-05-02T00:00:00Z'),
          txCount: 7,
        }),
        makeActivityRow({
          walletPubkey: 'WALL111111111111111111111111111111111111111',
          activityDate: new Date('2026-05-01T00:00:00Z'),
          txCount: 3,
        }),
        makeActivityRow({
          walletPubkey: 'WALL222222222222222222222222222222222222222',
          activityDate: new Date('2026-04-30T00:00:00Z'),
          txCount: 11,
        }),
      ],
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/claims/${VOTE_1}?includeActivity=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // ONE batched call carrying BOTH wallet pubkeys — no N+1 fan-out.
    expect(walletsSeen).toHaveLength(1);
    expect(walletsSeen[0]).toEqual([
      'WALL111111111111111111111111111111111111111',
      'WALL222222222222222222222222222222222222222',
    ]);
    // Rows are grouped per wallet; entry shape matches the activity
    // response — date (YYYY-MM-DD), txCount, and a null txFeesLamports.
    const first = body.wallets.entries[0];
    expect(first.walletRef).toBe('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(first.walletAddressShort).toBe('WALL…1111');
    expect(first.activity.days).toBe(365);
    expect(first.activity.entries).toEqual([
      { date: '2026-05-02', txCount: 7, txFeesLamports: null },
      { date: '2026-05-01', txCount: 3, txFeesLamports: null },
    ]);
    const second = body.wallets.entries[1];
    expect(second.walletRef).toBe('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb');
    expect(second.activity.entries).toEqual([
      { date: '2026-04-30', txCount: 11, txFeesLamports: null },
    ]);
    // Even with activity inlined, the full pubkey is never in the body.
    expect(res.body).not.toContain('WALL111111111111111111111111111111111111111');
    expect(res.body).not.toContain('WALL222222222222222222222222222222222222222');
    await app.close();
  });

  it('gives a wallet with no activity rows an empty entries list under ?includeActivity', async () => {
    const { deps } = buildDeps({
      claim: makeClaim(),
      activeWallets: [makeWallet()],
      activityRows: [],
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/claims/${VOTE_1}?includeActivity=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallets.entries[0].activity).toEqual({ days: 365, entries: [] });
    await app.close();
  });
});

describe('GET /v1/claims/:vote/audit', () => {
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
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}/audit` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('claim');
    expect(body.events[0]).not.toHaveProperty('submittedIp');
    await app.close();
  });

  it('redacts the full operator-wallet pubkey from a wallet_register detail', async () => {
    // SEC — the `wallet_register` event's stored `detail` is
    // `{ walletPubkey: <FULL>, label }`. The public + unauthenticated
    // `/audit` endpoint must serve only the truncated form: the
    // `walletPubkey` key is dropped, replaced by `walletAddressShort`,
    // and the full pubkey string must appear NOWHERE in the response.
    const fullWalletPubkey = 'FXfDcwH93dXf9PsJ5xH3qkq9wnq9PXMcd4bXz2k7PsJ5';
    const event: ValidatorClaimEvent = {
      id: 2,
      votePubkey: VOTE_1,
      eventType: 'wallet_register',
      identityPubkey: IDENTITY_1,
      priorIdentityPubkey: null,
      detail: { walletPubkey: fullWalletPubkey, label: 'hot' },
      submittedIp: '203.0.113.7',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    };
    const { deps } = buildDeps({ auditEvents: [event] });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}/audit` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    const served = body.events[0].detail;
    // `walletPubkey` is dropped; `walletAddressShort` is the truncated
    // `FXfD…PsJ5` form; the operator-chosen `label` passes through.
    expect(served).not.toHaveProperty('walletPubkey');
    expect(served.walletAddressShort).toBe('FXfD…PsJ5');
    expect(served.label).toBe('hot');
    // The full pubkey must not leak via ANY surface of the response.
    expect(JSON.stringify(body)).not.toContain(fullWalletPubkey);
    await app.close();
  });

  it('redacts the full operator-wallet pubkey from a wallet_unregister detail', async () => {
    // `wallet_unregister`'s stored `detail` is `{ walletPubkey: <FULL> }`
    // — same redaction as `wallet_register`, just no `label`.
    const fullWalletPubkey = 'WALL11111111111111111111111111111111111PsJ5';
    const event: ValidatorClaimEvent = {
      id: 3,
      votePubkey: VOTE_1,
      eventType: 'wallet_unregister',
      identityPubkey: IDENTITY_1,
      priorIdentityPubkey: null,
      detail: { walletPubkey: fullWalletPubkey },
      submittedIp: '203.0.113.7',
      createdAt: new Date('2026-01-03T00:00:00Z'),
    };
    const { deps } = buildDeps({ auditEvents: [event] });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}/audit` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const served = body.events[0].detail;
    expect(served).not.toHaveProperty('walletPubkey');
    expect(served.walletAddressShort).toBe('WALL…PsJ5');
    expect(JSON.stringify(body)).not.toContain(fullWalletPubkey);
    await app.close();
  });

  it('passes a non-wallet event detail through unchanged', async () => {
    // A `github_link` detail carries no `walletPubkey` — it must
    // survive the redaction pass byte-for-byte (GitHub usernames are
    // already-public, not operator-wallet pubkeys).
    const event: ValidatorClaimEvent = {
      id: 4,
      votePubkey: VOTE_1,
      eventType: 'github_link',
      identityPubkey: IDENTITY_1,
      priorIdentityPubkey: null,
      detail: { githubUsername: 'operator-gh', priorGithubUsername: null },
      submittedIp: '203.0.113.7',
      createdAt: new Date('2026-01-04T00:00:00Z'),
    };
    const { deps } = buildDeps({ auditEvents: [event] });
    const app = await makeApp(deps);
    const res = await app.inject({ method: 'GET', url: `/v1/claims/${VOTE_1}/audit` });
    expect(res.statusCode).toBe(200);
    expect(res.json().events[0].detail).toEqual({
      githubUsername: 'operator-gh',
      priorGithubUsername: null,
    });
    await app.close();
  });
});

describe('PUT /v1/claims/:vote', () => {
  it('verifies a claim on the happy path and writes an audit event', async () => {
    const { deps, appended } = buildDeps({
      claim: null, // no prior claim → first-ever `claim` event
      verifyResult: { ok: true, claim: makeClaim() },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}`,
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
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}`,
      payload: signedEnvelope({ signatureBase58: 'short' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('returns 400 vote_pubkey_mismatch when the path vote disagrees with the signed body', async () => {
    // REST-M7 — the vote pubkey now rides in the path AND the signed
    // body. A path that points at a different validator than the one
    // signed for is rejected before any verification work; the body
    // stays authoritative for the signature.
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${IDENTITY_1}`, // valid pubkey, but != body.votePubkey (VOTE_1)
      payload: signedEnvelope(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('vote_pubkey_mismatch');
    await app.close();
  });

  it('returns 404 when the service reports validator_not_found', async () => {
    const { deps } = buildDeps({
      verifyResult: { ok: false, reason: 'validator_not_found' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}`,
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
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}`,
      payload: signedEnvelope(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('nonce_replay');
    await app.close();
  });
});

describe('PUT /v1/claims/:vote/profile', () => {
  it('updates the profile on the happy path and writes a profile_update audit event', async () => {
    const { deps, appended } = buildDeps({
      updateResult: { ok: true, profile: makeProfile({ optedOut: true }) },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/profile`,
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

  it('returns 400 vote_pubkey_mismatch when the path vote disagrees with the signed body', async () => {
    // REST-M7 — same path/body consistency guard as PUT /v1/claims/:vote.
    const { deps } = buildDeps();
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${IDENTITY_1}/profile`, // valid pubkey, but != body.votePubkey
      payload: signedEnvelope({
        profile: { twitterHandle: 'operator', hideFooterCta: false, optedOut: false },
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('vote_pubkey_mismatch');
    await app.close();
  });

  it('returns 403 when the profile-update signature fails verification', async () => {
    const { deps } = buildDeps({
      updateResult: { ok: false, reason: 'bad_signature' },
    });
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/claims/${VOTE_1}/profile`,
      payload: signedEnvelope({
        profile: { twitterHandle: 'operator', hideFooterCta: false, optedOut: false },
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_signature');
    await app.close();
  });
});
