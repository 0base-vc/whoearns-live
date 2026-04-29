import { describe, it, expect } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/core/config.js';

const baseEnv = {
  SOLANA_RPC_URL: 'https://solana-rpc.publicnode.com',
  POSTGRES_URL: 'postgres://user:pass@localhost:5432/indexer',
};

describe('loadConfig', () => {
  it('parses defaults with minimal env', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.HTTP_PORT).toBe(8080);
    expect(cfg.HTTP_HOST).toBe('0.0.0.0');
    expect(cfg.SOLANA_RPC_CONCURRENCY).toBe(4);
    expect(cfg.SLOT_FINALITY_BUFFER).toBe(32);
    expect(cfg.VALIDATORS_WATCH_LIST).toEqual({ mode: 'explicit', votes: [] });
  });

  it('coerces numeric env strings', () => {
    const cfg = loadConfig({
      ...baseEnv,
      HTTP_PORT: '9090',
      SOLANA_RPC_CONCURRENCY: '8',
      FEE_INGEST_BATCH_SIZE: '100',
    });
    expect(cfg.HTTP_PORT).toBe(9090);
    expect(cfg.SOLANA_RPC_CONCURRENCY).toBe(8);
    expect(cfg.FEE_INGEST_BATCH_SIZE).toBe(100);
  });

  it('parses explicit validator list', () => {
    const cfg = loadConfig({
      ...baseEnv,
      VALIDATORS_WATCH_LIST: 'Vote111, Vote222 ,Vote333',
    });
    expect(cfg.VALIDATORS_WATCH_LIST).toEqual({
      mode: 'explicit',
      votes: ['Vote111', 'Vote222', 'Vote333'],
    });
  });

  it('parses "*" as all-validators mode', () => {
    const cfg = loadConfig({
      ...baseEnv,
      VALIDATORS_WATCH_LIST: '*',
    });
    expect(cfg.VALIDATORS_WATCH_LIST).toEqual({ mode: 'all', votes: [] });
  });

  it('rejects invalid RPC URL', () => {
    expect(() => loadConfig({ ...baseEnv, SOLANA_RPC_URL: 'not-a-url' })).toThrow(ConfigError);
  });

  it('parses optional fallback RPC URL', () => {
    const cfg = loadConfig({
      ...baseEnv,
      SOLANA_FALLBACK_RPC_URL: 'https://fallback.example.com',
    });
    expect(cfg.SOLANA_FALLBACK_RPC_URL).toBe('https://fallback.example.com');
  });

  it('rejects invalid fallback RPC URL', () => {
    expect(() => loadConfig({ ...baseEnv, SOLANA_FALLBACK_RPC_URL: 'not-a-url' })).toThrow(
      ConfigError,
    );
  });

  it('rejects missing POSTGRES_URL', () => {
    expect(() =>
      loadConfig({
        SOLANA_RPC_URL: baseEnv.SOLANA_RPC_URL,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects non-positive HTTP_PORT', () => {
    expect(() => loadConfig({ ...baseEnv, HTTP_PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, HTTP_PORT: '-1' })).toThrow(ConfigError);
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'nope' })).toThrow(ConfigError);
  });

  it('includes issues in ConfigError', () => {
    try {
      loadConfig({ SOLANA_RPC_URL: 'not-url' });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThan(0);
    }
  });
});
