import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import scoringRoutes, { type ScoringRoutesDeps } from '../../../src/api/routes/scoring.route.js';
import { resetTierPercentileCache } from '../../../src/api/tier-cache.js';
import type {
  EpochValidatorStats,
  Validator,
  ValidatorClaim,
  ValidatorGithubLink,
} from '../../../src/types/domain.js';
import { IDENTITY_1, VOTE_1, makeStats, makeTestApp } from './_fakes.js';

const silent = pino({ level: 'silent' });

function makeValidator(): Validator {
  return {
    votePubkey: VOTE_1,
    identityPubkey: IDENTITY_1,
    // first_seen_epoch = 100 → predates CYCLE_1_OG (200) → "Cycle 1 OG"
    // landmark, mirroring the /badges route test so the tenure block
    // is asserted against a known value. `genesisEpoch: null` so the
    // tenure computation falls back to first_seen_epoch.
    firstSeenEpoch: 100,
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
 * Six closed-epoch history rows with healthy block-production
 * counters (zero skips). The economic-percentile component is
 * supplied separately via the `findEconomicPercentile` stub below;
 * the seed here only needs to populate the reliability half of the
 * composite plus the window numerics. `resolveTierForValidator`
 * windows these to the 10 most recent CLOSED epochs; the fake epochs
 * repo below reports a current epoch of 600, so all 11 rows count as
 * closed.
 */
function makeTierHistory(): EpochValidatorStats[] {
  const rows: EpochValidatorStats[] = [];
  for (let e = 505; e >= 495; e--) {
    rows.push(
      makeStats(e, VOTE_1, IDENTITY_1, {
        slotsAssigned: 100,
        slotsProduced: 100,
        slotsSkipped: 0,
        feesUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
        tipsUpdatedAt: new Date(`2026-04-${e - 480}T00:00:00Z`),
      }),
    );
  }
  return rows;
}

/**
 * `/scoring`'s deps are the UNION of the validators-route + OAI-route
 * `Pick<...>` interfaces — every one is satisfied with an inline
 * literal, no full-repo fake harness (same pattern as the OAI route
 * test). `overrides` swaps the two behaviours the cases below need.
 */
function buildDeps(
  overrides: {
    /** When false, `claimsRepo.findByVote` returns null → OAI gated out. */
    claimed?: boolean;
    /** When true, no validator row exists at all → 404. */
    unknownValidator?: boolean;
  } = {},
): ScoringRoutesDeps {
  const claimed = overrides.claimed ?? true;
  const validator = makeValidator();
  const claim: ValidatorClaim = {
    votePubkey: VOTE_1,
    identityPubkey: IDENTITY_1,
    claimedAt: new Date(),
    lastNonceUsed: 'nonce',
  };
  return {
    validatorsRepo: {
      findByVote: async (v) => (overrides.unknownValidator || v !== VOTE_1 ? null : validator),
      findByIdentity: async () => null,
    },
    statsRepo: {
      findHistoryByVote: async () => makeTierHistory(),
      // Top economic + large cohort + full window coverage → forge
      // on the happy path. `unknownValidator` cases never reach this
      // stub (the route 404s on the validators lookup).
      findEconomicPercentile: async () => ({
        percentile: 1.0,
        cohortSize: 200,
        measuredEpochs: 10,
        medianIncomePerSlotLamports: '50000000',
        cuPercentile: 1.0,
      }),
    },
    epochsRepo: {
      // Current epoch 600 → all six seeded history rows (500-505)
      // count as CLOSED, so the tier window resolves to 5 of them.
      findCurrent: async () => ({
        epoch: 600,
        firstSlot: 0,
        lastSlot: 100,
        slotCount: 100,
        currentSlot: null,
        isClosed: false,
        observedAt: new Date(),
        closedAt: null,
      }),
    },
    claimsRepo: {
      findByVote: async (v) => (claimed && v === VOTE_1 ? claim : null),
    },
    profilesRepo: {
      findOptedOutVotes: async () => new Set<string>(),
    },
    validatorGithubRepo: {
      findActiveByVote: async () => makeGithubLink(),
    },
    operatorWalletsRepo: {
      listActiveByVote: async () => [],
    },
    walletActivityRepo: {
      listRecentForWallets: async () => [],
    },
    simdDiscussionsRepo: {
      // Governance ingest active + the linked username has comments →
      // the OAI composite is a genuine number, exercising the
      // happy-path `oai` block end to end.
      hasAnyData: async () => true,
      statsByUsername: async () => [
        {
          githubUsername: 'operator-gh',
          commentCount: 8,
          reactionsReceived: 21,
          activeWindowCount: 2,
        },
      ],
    },
  };
}

async function makeApp(deps: ScoringRoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(scoringRoutes, deps);
  return app;
}

describe('GET /v1/validators/:idOrVote/scoring', () => {
  beforeEach(() => {
    // Process-local percentile cache survives across tests; reset to
    // keep stub overrides deterministic.
    resetTierPercentileCache();
  });

  it('returns tier + tenure + client + oai all populated for a claimed validator', async () => {
    const app = await makeApp(buildDeps({ claimed: true }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/scoring`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      vote: string;
      identity: string;
      tier: {
        tier: string;
        composite: number | null;
        window: {
          epochs: number;
          slotsAssigned: number;
          economicCohortSize: number;
          economicMeasuredEpochs: number;
          cohortAsOfEpoch: { fromEpoch: number; toEpoch: number } | null;
        };
        components: { reliability: number; economicPercentile: number | null };
      };
      tenure: { firstSeenEpoch: number; landmark: string; badge: string };
      client: { kind: string; version: string | null };
      oai: {
        composite: number | null;
        components: { walletScore: number; governance: { score: number | null } };
        ingestStatus: { governanceIngestActive: boolean };
      } | null;
    };

    expect(body.vote).toBe(VOTE_1);
    expect(body.identity).toBe(IDENTITY_1);

    // Full /tier body, carried once at top level (NOT the /badges
    // tier summary). Window resolves to 10 closed epochs → forge.
    expect(body.tier.tier).toBe('forge');
    expect(body.tier.window.epochs).toBe(10);
    expect(body.tier.window.slotsAssigned).toBe(1000);
    expect(body.tier.window.economicCohortSize).toBe(200);
    expect(body.tier.window.economicMeasuredEpochs).toBe(10);
    // Fixture seeds epochs 495..505 + current epoch 600 → all eleven
    // count as closed, window picks the 10 newest (496..505).
    expect(body.tier.window.cohortAsOfEpoch).toEqual({ fromEpoch: 496, toEpoch: 505 });
    expect(body.tier.composite).toBeGreaterThanOrEqual(95);
    expect(body.tier.components.economicPercentile).toBe(1.0);
    expect(typeof body.tier.components.reliability).toBe('number');

    // tenure + client blocks from /badges (NOT the badges tier).
    expect(body.tenure.firstSeenEpoch).toBe(100);
    expect(body.tenure.landmark).toBe('CYCLE_1_OG');
    expect(body.tenure.badge).toBe('Cycle 1 OG');
    expect(body.client.kind).toBe('unknown');
    expect(body.client.version).toBeNull();

    // OAI is populated — claimed validator, governance ingest active.
    expect(body.oai).not.toBeNull();
    expect(body.oai?.ingestStatus.governanceIngestActive).toBe(true);
    expect(body.oai?.components.governance.score).toBeGreaterThan(0);
    expect(body.oai?.composite).not.toBeNull();
    await app.close();
  });

  it('returns 200 with oai: null for a known-but-unclaimed validator (tier/tenure/client still populated)', async () => {
    // The validator is known to the indexer, so tier + tenure +
    // client all resolve — but it has no claim, so the OAI surface
    // is gated out. The OAI route would 404 this; `/scoring` instead
    // collapses it to `oai: null` and still returns 200 with the
    // rest of the body intact.
    const app = await makeApp(buildDeps({ claimed: false }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/scoring`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      tier: { tier: string };
      tenure: { landmark: string };
      client: { kind: string };
      oai: unknown | null;
    };
    expect(body.oai).toBeNull();
    // The non-OAI blocks are unaffected by the OAI gate.
    expect(body.tier.tier).toBe('forge');
    expect(body.tenure.landmark).toBe('CYCLE_1_OG');
    expect(body.client.kind).toBe('unknown');
    await app.close();
  });

  it('returns 404 for a validator pubkey unknown to the indexer', async () => {
    // `/scoring` 404s ONLY on an unknown pubkey — the SAME 404 `/tier`
    // returns today. The OAI gates never produce a 404 here.
    const app = await makeApp(buildDeps({ unknownValidator: true }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/validators/${VOTE_1}/scoring`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    await app.close();
  });

  it('HEAD short-circuits with 200 and an empty body after the existence check', async () => {
    const app = await makeApp(buildDeps({ claimed: true }));
    const res = await app.inject({
      method: 'HEAD',
      url: `/v1/validators/${VOTE_1}/scoring`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    // The existence check still runs before the short-circuit, so a
    // HEAD on an unknown pubkey 404s rather than 200ing.
    const unknown = await makeApp(buildDeps({ unknownValidator: true }));
    const missing = await unknown.inject({
      method: 'HEAD',
      url: `/v1/validators/${VOTE_1}/scoring`,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
    await unknown.close();
  });
});
