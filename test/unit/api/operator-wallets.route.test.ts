import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import operatorWalletsRoutes, {
  type OperatorWalletsRoutesDeps,
} from '../../../src/api/routes/operator-wallets.route.js';
import type { WalletDailyActivity } from '../../../src/types/domain.js';
import { makeTestApp } from './_fakes.js';

const silent = pino({ level: 'silent' });

const WALLET_1 = 'WALL111111111111111111111111111111111111111';

function makeRow(over: Partial<WalletDailyActivity> = {}): WalletDailyActivity {
  return {
    walletPubkey: WALLET_1,
    activityDate: new Date('2026-05-01T00:00:00Z'),
    txCount: 4,
    txFeesLamports: 0n,
    indexedAt: new Date(),
    ...over,
  };
}

/**
 * The route's deps are narrow `Pick<...>` interfaces, so each is
 * satisfied directly with an inline literal — no full-repo fake
 * harness needed. `overrides` swap one behaviour per test.
 */
function buildDeps(
  overrides: {
    registered?: boolean;
    rows?: WalletDailyActivity[];
  } = {},
): OperatorWalletsRoutesDeps {
  return {
    operatorWalletsRepo: {
      existsActive: async () => overrides.registered ?? true,
    },
    walletActivityRepo: {
      listRecent: async () => overrides.rows ?? [makeRow()],
    },
  };
}

async function makeApp(deps: OperatorWalletsRoutesDeps): Promise<FastifyInstance> {
  const app = makeTestApp(silent);
  setErrorHandler(app, silent);
  await app.register(operatorWalletsRoutes, deps);
  return app;
}

describe('GET /v1/operator-wallets/:wallet/activity', () => {
  it('returns the per-day activity entries for a registered wallet', async () => {
    const app = await makeApp(
      buildDeps({
        registered: true,
        rows: [
          makeRow({ activityDate: new Date('2026-05-02T00:00:00Z'), txCount: 7 }),
          makeRow({ activityDate: new Date('2026-05-01T00:00:00Z'), txCount: 3 }),
        ],
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/v1/operator-wallets/${WALLET_1}/activity`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wallet).toBe(WALLET_1);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].date).toBe('2026-05-02');
    expect(body.entries[0].txCount).toBe(7);
    // P4 ships counts only — txFeesLamports is deliberately null.
    expect(body.entries[0].txFeesLamports).toBeNull();
    await app.close();
  });

  it('returns 404 for an unregistered wallet (existence-oracle gate)', async () => {
    // The gate collapses registered-vs-unregistered into one 404 so an
    // attacker iterating pubkeys can't tell which are registered.
    const app = await makeApp(buildDeps({ registered: false }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/operator-wallets/${WALLET_1}/activity`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });

  it('returns 400 on a malformed wallet path parameter', async () => {
    const app = await makeApp(buildDeps());
    const res = await app.inject({
      method: 'GET',
      url: '/v1/operator-wallets/not-a-pubkey/activity',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('returns 400 on a non-numeric days query parameter', async () => {
    const app = await makeApp(buildDeps());
    const res = await app.inject({
      method: 'GET',
      url: `/v1/operator-wallets/${WALLET_1}/activity?days=lots`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('clamps the days query parameter into the [1, 365] range', async () => {
    const app = await makeApp(buildDeps({ registered: true, rows: [] }));
    const res = await app.inject({
      method: 'GET',
      url: `/v1/operator-wallets/${WALLET_1}/activity?days=99999`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toBe(365);
    await app.close();
  });
});
