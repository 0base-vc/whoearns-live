/**
 * In-memory fakes for the API layer. These re-export (and in some places thinly
 * wrap) the service-layer fakes so the API tests don't need to duplicate the
 * upsert/read logic that's already covered there.
 */

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

export {
  FakeAggregatesRepo,
  FakeEpochsRepo,
  FakeProcessedBlocksRepo,
  FakeStatsRepo,
  FakeValidatorsRepo,
  FakeValidatorService,
  FakeWatchedDynamicRepo,
  makeEpochInfo,
  makeProcessedBlock,
  makeStats,
} from '../services/_fakes.js';

/**
 * Minimal `pg.Pool`-shaped stub used by the `/healthz` handler. We only need
 * `.query` and the ability to simulate success / failure / timeout.
 */
export type DbBehavior = 'ok' | 'fail' | 'stall';

export class FakePool {
  constructor(public behavior: DbBehavior = 'ok') {}

  /** Signature is widened to `unknown` to satisfy `Pick<pg.Pool, 'query'>`. */
  query(..._args: unknown[]): Promise<{ rows: unknown[] }> {
    if (this.behavior === 'fail') {
      return Promise.reject(new Error('db unavailable'));
    }
    if (this.behavior === 'stall') {
      // Never resolve; the health probe has its own 2s timeout.
      return new Promise(() => {
        /* intentionally dangling */
      });
    }
    return Promise.resolve({ rows: [{ '?column?': 1 }] });
  }
}

/**
 * Build a Fastify instance whose logger generic is widened back to
 * `FastifyBaseLogger`. Without this cast each `app.register(...)` call in tests
 * fails because pino's Logger is structurally stricter than FastifyBaseLogger.
 * Same trick as `src/api/server.ts`.
 */
export function makeTestApp(logger: Logger): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger satisfies FastifyBaseLogger,
  });
  return app as unknown as FastifyInstance;
}

/**
 * Canonical base58 pubkeys sized to satisfy the pubkey regex. We avoid the
 * `_fakes` constants from `rpc-fixtures.ts` for readability in API tests.
 */
export const VOTE_1 = 'Vote111111111111111111111111111111111111111';
export const VOTE_2 = 'Vote222222222222222222222222222222222222222';
export const VOTE_3 = 'Vote333333333333333333333333333333333333333';
export const IDENTITY_1 = 'Node111111111111111111111111111111111111111';
export const IDENTITY_2 = 'Node222222222222222222222222222222222222222';
export const IDENTITY_3 = 'Node333333333333333333333333333333333333333';
