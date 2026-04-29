import pg from 'pg';
import type { AppConfig } from '../core/config.js';

/**
 * Subset of {@link AppConfig} needed to construct the database pool.
 */
export type DbPoolConfig = Pick<
  AppConfig,
  'POSTGRES_URL' | 'POSTGRES_POOL_SIZE' | 'POSTGRES_STATEMENT_TIMEOUT_MS'
>;

/**
 * Force NUMERIC (OID 1700) and BIGINT (OID 20) to be returned as strings.
 *
 * The default behaviour of `pg` already returns these as strings because they
 * can overflow JavaScript's `Number.MAX_SAFE_INTEGER`. We override explicitly
 * here so this behaviour is part of the documented contract of the storage
 * layer and resilient to any future upstream change. Repositories convert to
 * `bigint` at their boundary via `toLamports`.
 */
function configureTypeParsers(): void {
  // 1700 = NUMERIC / DECIMAL
  pg.types.setTypeParser(1700, (value: string) => value);
  // 20 = BIGINT (INT8)
  pg.types.setTypeParser(20, (value: string) => value);
}

let typeParsersConfigured = false;

/**
 * Create a `pg.Pool` configured from the application config.
 *
 * `statement_timeout` is applied via the PoolConfig option, which `pg`
 * forwards to the server during the connection handshake. Earlier versions
 * of this file also issued a `SET statement_timeout = ...` inside an
 * `on('connect')` handler as belt-and-suspenders, but that path fires while
 * pg's own handshake queries are still on the wire and triggers the
 * deprecation warning "Calling client.query() when the client is already
 * executing a query" — slated for removal in pg 9.x. The PoolConfig option
 * alone is load-bearing and documented, so the extra SET is gone.
 */
export function createPool(config: DbPoolConfig): pg.Pool {
  if (!typeParsersConfigured) {
    configureTypeParsers();
    typeParsersConfigured = true;
  }

  const pool = new pg.Pool({
    connectionString: config.POSTGRES_URL,
    max: config.POSTGRES_POOL_SIZE,
    statement_timeout: config.POSTGRES_STATEMENT_TIMEOUT_MS,
  });

  // Prevent unhandled 'error' events on idle clients from crashing the
  // process. Idle errors almost always mean the server dropped the
  // connection — the pool will reap and replace the client.
  pool.on('error', () => {
    // Swallow intentionally — errors surface again on next query.
  });

  return pool;
}

/**
 * Close the pool, draining in-flight queries. Safe to call multiple times.
 */
export async function closePool(pool: pg.Pool): Promise<void> {
  if (pool.ended || pool.ending) {
    return;
  }
  await pool.end();
}
