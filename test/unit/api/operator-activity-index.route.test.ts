import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import oaiRoutes, {
  type OaiRoutesDeps,
} from '../../../src/api/routes/operator-activity-index.route.js';
import type { Validator, ValidatorClaim, ValidatorGithubLink } from '../../../src/types/domain.js';
import { IDENTITY_1, IDENTITY_2, makeTestApp, VOTE_1 } from './_fakes.js';

const silent = pino({ level: 'silent' });

function makeValidator(identityPubkey: string = IDENTITY_1): Validator {
  return {
    votePubkey: VOTE_1,
    identityPubkey,
    firstSeenEpoch: 500,
    lastSeenEpoch: 500,
    updatedAt: new Date(),
    name: null,
    details: null,
    website: null,
    keybaseUsername: null,
    iconUrl: null,
    infoUpdatedAt: null,
    clientKind: 'unknown',
    clientVersion: null,
    clientUpdatedAt: null,
  };
}

function makeGithubLink(): ValidatorGithubLink {
  return {
    votePubkey: VOTE_1,
    githubUsername: 'operator-gh',
    gistUrl: 'https://gist.github.com/operator-gh/abc',
    gistId: 'abc',
    signedNonce: 'nonce',
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  };
}

/**
 * The OAI route's deps are all narrow `Pick<...>` interfaces, so each
 * is satisfied directly with an inline literal — no full-repo fake
 * harness needed. `overrides` lets a test swap one behaviour.
 */
function buildDeps(overrides: {
  governanceIngestActive?: boolean;
  githubLink?: ValidatorGithubLink | null;
  statsRow?: { commentCount: number; reactionsReceived: number; activeWindowCount: number };
  /**
   * When set, the `validators` row carries this identity pubkey while
   * the claim still binds `IDENTITY_1` — simulates an on-chain
   * identity rotation that left the claim stale (identity-drift gate).
   */
  validatorIdentityPubkey?: string;
}): OaiRoutesDeps {
  const validator = makeValidator(overrides.validatorIdentityPubkey ?? IDENTITY_1);
  const claim: ValidatorClaim = {
    votePubkey: VOTE_1,
    identityPubkey: IDENTITY_1,
    claimedAt: new Date(),
    lastNonceUsed: 'nonce',
  };
  return {
    validatorsRepo: {
      findByVote: async (v) => (v === VOTE_1 ? validator : null),
      findByIdentity: async () => null,
    },
    claimsRepo: {
      findByVote: async (v) => (v === VOTE_1 ? claim : null),
    },
    profilesRepo: {
      findOptedOutVotes: async () => new Set<string>(),
    },
    validatorGithubRepo: {
      findActiveByVote: async () =>
        overrides.githubLink === undefined ? makeGithubLink() : overrides.githubLink,
    },
    operatorWalletsRepo: {
      listActiveByVote: async () => [],
    },
    walletActivityRepo: {
      listRecentForWallets: async () => [],
    },
    simdDiscussionsRepo: {
      hasAnyData: async () => overrides.governanceIngestActive ?? false,
      statsByUsername: async () => {
        const row = overrides.statsRow;
        return row === undefined ? [] : [{ githubUsername: 'operator-gh', ...row }];
      },
    },
  };
}

async function makeApp(deps: OaiRoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(oaiRoutes, deps);
  return app;
}

describe('GET /v1/validators/:idOrVote/operator-activity-index', () => {
  it('reports governance.score and composite as null while the ingest is inactive', async () => {
    // The shape every linked validator sees today: the GitHub
    // Discussions ingest is unshipped, so `simd_discussion_comments`
    // is empty — `governance.score` must be `null` ("unknown"), not a
    // real `0`, and `composite` follows because a 50/50 blend can't be
    // honestly reported with one half unknowable.
    const app = await makeApp(buildDeps({ governanceIngestActive: false }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/operator-activity-index`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.composite).toBeNull();
    expect(body.components.governance.score).toBeNull();
    // Sub-component counts stay real values, not nulled.
    expect(body.components.governance.commentCount).toBe(0);
    expect(body.components.governance.reactionsReceived).toBe(0);
    expect(body.components.governance.activeWindowCount).toBe(0);
    // walletScore stays populated so a wallet-only consumer can read it.
    expect(typeof body.components.walletScore).toBe('number');
    expect(body.ingestStatus).toEqual({
      governanceIngestActive: false,
      walletFeesIngestActive: false,
    });
    await app.close();
  });

  it('returns a real governance score once the ingest has data', async () => {
    // Ingest active + the linked username has comments → governance is
    // a genuine number and `composite` blends both halves.
    const app = await makeApp(
      buildDeps({
        governanceIngestActive: true,
        statsRow: { commentCount: 8, reactionsReceived: 21, activeWindowCount: 2 },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/operator-activity-index`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.components.governance.score).toBeGreaterThan(0);
    expect(body.components.governance.commentCount).toBe(8);
    // Wallet half has no signal here, but governance does → composite
    // is the governance-only blend, not null.
    expect(body.composite).not.toBeNull();
    expect(body.ingestStatus.governanceIngestActive).toBe(true);
    await app.close();
  });

  it('404s when the on-chain identity has drifted from the claimed identity', async () => {
    // The operator rotated their on-chain identity after claiming (or
    // the claim row is stale): `validators.identityPubkey` no longer
    // matches the identity that proved ownership. The OAI must not
    // serve scoring signal against an identity that no longer controls
    // the validator — and the drift case collapses into the same 404
    // as unknown / unclaimed / opted-out so the gate that fired stays
    // unobservable.
    const app = await makeApp(buildDeps({ validatorIdentityPubkey: IDENTITY_2 }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/operator-activity-index`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('HEAD short-circuits with 200 and an empty body, unaffected by ingestStatus', async () => {
    const app = await makeApp(buildDeps({ governanceIngestActive: false }));
    const res = await app.inject({
      method: 'HEAD',
      url: `/v1/validators/${VOTE_1}/operator-activity-index`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    await app.close();
  });
});
