import { describe, it, expect, afterEach } from 'vitest';
import pg from 'pg';
import { closePool, createPool } from '../../../src/storage/db.js';

const baseConfig = {
  POSTGRES_URL: 'postgres://user:pass@localhost:5432/indexer',
  POSTGRES_POOL_SIZE: 7,
  POSTGRES_STATEMENT_TIMEOUT_MS: 4321,
};

describe('createPool', () => {
  const pools: pg.Pool[] = [];

  afterEach(async () => {
    // End every pool we created so vitest doesn't complain about open handles.
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) await closePool(pool);
    }
  });

  it('constructs a pg.Pool', () => {
    const pool = createPool(baseConfig);
    pools.push(pool);
    expect(pool).toBeInstanceOf(pg.Pool);
  });

  it('applies max from POSTGRES_POOL_SIZE', () => {
    const pool = createPool(baseConfig);
    pools.push(pool);
    expect(pool.options.max).toBe(7);
  });

  it('uses connectionString from POSTGRES_URL', () => {
    const pool = createPool(baseConfig);
    pools.push(pool);
    // pg stores the URL as connectionString on the options bag.
    expect(pool.options.connectionString).toBe(baseConfig.POSTGRES_URL);
  });

  it('passes statement_timeout through the client config for handshake-time setup', () => {
    const pool = createPool(baseConfig);
    pools.push(pool);
    // `pg.Pool` mirrors client config onto `pool.options`.
    const opts = pool.options as unknown as { statement_timeout?: number };
    expect(opts.statement_timeout).toBe(baseConfig.POSTGRES_STATEMENT_TIMEOUT_MS);
  });

  it('registers an error listener so idle client errors do not crash the process', () => {
    const pool = createPool(baseConfig);
    pools.push(pool);
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
  });

  it('configures BIGINT and NUMERIC type parsers to return strings', () => {
    // Force the module to run its one-time type parser setup.
    const pool = createPool(baseConfig);
    pools.push(pool);
    // pg-types getTypeParser is reachable via pg.types.
    const numericParser = pg.types.getTypeParser(1700);
    const bigintParser = pg.types.getTypeParser(20);
    expect(numericParser('12345')).toBe('12345');
    expect(bigintParser('6789')).toBe('6789');
  });
});

describe('closePool', () => {
  it('is safe to call twice', async () => {
    const pool = createPool(baseConfig);
    await closePool(pool);
    // Second call is a no-op, must not throw.
    await closePool(pool);
  });
});
