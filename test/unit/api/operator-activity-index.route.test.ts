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
    genesisEpoch: null,
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
    commission: null,
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
  /**
   * When `true`, `walletActivityRepo.hasAnyFeeData` resolves `true` —
   * simulates the Phase 4-extension fee backfill having populated at
   * least one row. Drives the `ingestStatus.walletFeesIngestActive`
   * flag. Default `undefined` keeps the count-only release behaviour
   * (`false`).
   */
  walletFeesIngestActive?: boolean;
  githubLink?: ValidatorGithubLink | null;
  statsRow?: { commentCount: number; reactionsReceived: number; activeWindowCount: number };
  /**
   * When set, the `validators` row carries this identity pubkey while
   * the claim still binds `IDENTITY_1` — simulates an on-chain
   * identity rotation that left the claim stale (identity-drift gate).
   */
  validatorIdentityPubkey?: string;
  /**
   * When `null`, `claimsRepo.findByVote` resolves `null` — the
   * validator row exists but was never claimed (claim gate). Default
   * (`undefined`) keeps the standard `IDENTITY_1`-bound claim.
   */
  claim?: ValidatorClaim | null;
}): OaiRoutesDeps {
  const validator = makeValidator(overrides.validatorIdentityPubkey ?? IDENTITY_1);
  const claim: ValidatorClaim | null =
    overrides.claim === undefined
      ? {
          votePubkey: VOTE_1,
          identityPubkey: IDENTITY_1,
          claimedAt: new Date(),
          lastNonceUsed: 'nonce',
        }
      : overrides.claim;
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
      hasAnyFeeData: async () => overrides.walletFeesIngestActive ?? false,
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

  it('flips walletFeesIngestActive on when the fee backfill has populated any row', async () => {
    // The OAI route reads `walletActivityRepo.hasAnyFeeData()` as a
    // single-query liveness signal — when it resolves `true` the
    // ingest-status flag flips on regardless of whether this
    // particular validator has wallet activity. The UI uses the
    // flag to switch heatmap intensity from tx-count to lamports/day.
    const app = await makeApp(buildDeps({ walletFeesIngestActive: true }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/operator-activity-index`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ingestStatus.walletFeesIngestActive).toBe(true);
    // Governance stays gated out (no override) so the composite is
    // null — independent of the wallet-fees flip.
    expect(body.ingestStatus.governanceIngestActive).toBe(false);
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

  it('HEAD short-circuits with 200 and an empty body without running the resolver fan-out', async () => {
    // REST-M8 HEAD-cost guard. A HEAD probe must pay only the two
    // cheap gate lookups (`passesOaiGates`) and never the two-wave
    // repo fan-out — that's REST-M3's "a HEAD doesn't pay the full DB
    // cost" intent, which a naive `resolveOaiForValidator`-then-HEAD
    // ordering would regress. Every fan-out repo is wired to throw;
    // reaching one on a HEAD is exactly the regression this pins.
    const deps = buildDeps({ governanceIngestActive: false });
    const fanOutReached = (): never => {
      throw new Error('HEAD must not reach the resolver fan-out');
    };
    deps.simdDiscussionsRepo.hasAnyData = fanOutReached;
    deps.simdDiscussionsRepo.statsByUsername = fanOutReached;
    deps.validatorGithubRepo.findActiveByVote = fanOutReached;
    deps.operatorWalletsRepo.listActiveByVote = fanOutReached;
    deps.walletActivityRepo.listRecentForWallets = fanOutReached;
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'HEAD',
      url: `/v1/validators/${VOTE_1}/operator-activity-index`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    await app.close();
  });

  it('HEAD on an unclaimed validator 404s — the claim gate fires before the fan-out', async () => {
    // The validator row exists but was never claimed. A HEAD must
    // still 404 (the claim gate inside `passesOaiGates` fires
    // identically to the GET path), and it must do so without
    // reaching the fan-out — so unknown / unclaimed / opted-out /
    // drift all collapse to one status on HEAD too. Fan-out repos
    // throw to pin that the claim gate short-circuits first.
    const deps = buildDeps({ claim: null });
    const fanOutReached = (): never => {
      throw new Error('HEAD must not reach the resolver fan-out');
    };
    deps.simdDiscussionsRepo.hasAnyData = fanOutReached;
    deps.validatorGithubRepo.findActiveByVote = fanOutReached;
    deps.operatorWalletsRepo.listActiveByVote = fanOutReached;
    const app = await makeApp(deps);
    const res = await app.inject({
      method: 'HEAD',
      url: `/v1/validators/${VOTE_1}/operator-activity-index`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
