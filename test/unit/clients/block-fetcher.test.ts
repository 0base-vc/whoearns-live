import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockFetcher } from '../../../src/clients/block-fetcher.js';
import { UpstreamError } from '../../../src/core/errors.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { RpcBlock } from '../../../src/clients/types.js';

type FakeClient = Pick<SolanaRpcClient, 'getBlock'>;

function makeClient(impl: (slot: number) => Promise<RpcBlock | null>): FakeClient {
  return { getBlock: vi.fn(impl) };
}

/**
 * A real pino logger at `silent` level keeps the Logger typing
 * satisfied (matches `createLogger`'s return type) without leaking
 * output into the test runner. Following the same pattern as the
 * adjacent `jito.test.ts` / `solana-rpc.test.ts` suites.
 *
 * Spies are attached AFTER construction so assertions about log
 * invocation still work against the silent logger.
 */
function makeSilentLogger() {
  const logger = pino({ level: 'silent' });
  return {
    logger,
    debugSpy: vi.spyOn(logger, 'debug'),
    warnSpy: vi.spyOn(logger, 'warn'),
  };
}

const SAMPLE_BLOCK: RpcBlock = {
  blockhash: 'h',
  parentSlot: 100,
  blockHeight: 42,
  blockTime: 0,
};

describe('BlockFetcher', () => {
  let harness: ReturnType<typeof makeSilentLogger>;

  beforeEach(() => {
    harness = makeSilentLogger();
  });

  it('passes through to primary when no hot endpoint is set', async () => {
    const primary = makeClient(async () => SAMPLE_BLOCK);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      logger: harness.logger,
    });
    const out = await fetcher.getBlock(999);
    expect(out).toBe(SAMPLE_BLOCK);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
    expect(fetcher.hasHotPath()).toBe(false);
    expect(fetcher.hasFallback()).toBe(false);
  });

  it('serves from hot endpoint on success and never hits primary', async () => {
    const hot = makeClient(async () => SAMPLE_BLOCK);
    const primary = makeClient(async () => {
      throw new Error('primary should not be called on hot success');
    });
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      hot: hot as SolanaRpcClient,
      logger: harness.logger,
    });
    const out = await fetcher.getBlock(999);
    expect(out).toBe(SAMPLE_BLOCK);
    expect(hot.getBlock).toHaveBeenCalledTimes(1);
    expect(primary.getBlock).not.toHaveBeenCalled();
    expect(fetcher.hasHotPath()).toBe(true);
  });

  it('uses fallback only after primary errors in primary-first mode', async () => {
    const primary = makeClient(async () => {
      throw new Error('primary down');
    });
    const fallback = makeClient(async () => SAMPLE_BLOCK);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      fallback: fallback as SolanaRpcClient,
      logger: harness.logger,
    });

    const out = await fetcher.getBlock(999);

    expect(out).toBe(SAMPLE_BLOCK);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
    expect(fallback.getBlock).toHaveBeenCalledTimes(1);
    expect(fetcher.hasFallback()).toBe(true);
    expect(harness.warnSpy).toHaveBeenCalled();
  });

  it('does not consult fallback when primary returns null', async () => {
    const primary = makeClient(async () => null);
    const fallback = makeClient(async () => SAMPLE_BLOCK);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      fallback: fallback as SolanaRpcClient,
      logger: harness.logger,
    });

    const out = await fetcher.getBlock(999);

    expect(out).toBeNull();
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
    expect(fallback.getBlock).not.toHaveBeenCalled();
  });

  it('leaves slot pending when fallback returns null after primary error', async () => {
    const primary = makeClient(async () => {
      throw new Error('primary down');
    });
    const fallback = makeClient(async () => null);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      fallback: fallback as SolanaRpcClient,
      logger: harness.logger,
    });

    await expect(fetcher.getBlock(999)).rejects.toThrow(/primary down/);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
    expect(fallback.getBlock).toHaveBeenCalledTimes(1);
  });

  it('falls back to primary on "-32001 cleaned up" from hot endpoint', async () => {
    const hot = makeClient(async () => {
      // Match the real shape produced by `SolanaRpcClient.request` when
      // the upstream returns a `-32001` JSON-RPC error.
      throw new UpstreamError(
        'solana-rpc',
        'RPC error -32001: Block 100 cleaned up, does not exist on node. First available block: 500',
      );
    });
    const primary = makeClient(async () => SAMPLE_BLOCK);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      hot: hot as SolanaRpcClient,
      logger: harness.logger,
    });

    const out = await fetcher.getBlock(100);

    expect(out).toBe(SAMPLE_BLOCK);
    expect(hot.getBlock).toHaveBeenCalledTimes(1);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
    // Debug level for the expected "cleaned up" case — this is
    // normal operation, not worth a warn-level log entry.
    expect(harness.debugSpy).toHaveBeenCalled();
    expect(harness.warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to primary on generic network error + logs at warn', async () => {
    const hot = makeClient(async () => {
      throw new Error('ECONNRESET');
    });
    const primary = makeClient(async () => SAMPLE_BLOCK);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      hot: hot as SolanaRpcClient,
      logger: harness.logger,
    });

    const out = await fetcher.getBlock(999);

    expect(out).toBe(SAMPLE_BLOCK);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
    // Unexpected errors escalate to warn so operators can notice
    // chronic hot-endpoint issues.
    expect(harness.warnSpy).toHaveBeenCalled();
  });

  it('propagates a primary error if BOTH endpoints fail', async () => {
    const hot = makeClient(async () => {
      throw new Error('boom hot');
    });
    const primary = makeClient(async () => {
      throw new Error('boom primary');
    });
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      hot: hot as SolanaRpcClient,
      logger: harness.logger,
    });

    await expect(fetcher.getBlock(999)).rejects.toThrow(/boom primary/);
    expect(hot.getBlock).toHaveBeenCalledTimes(1);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
  });

  it('confirms hot endpoint null with primary before returning a produced block', async () => {
    const hot = makeClient(async () => null);
    const primary = makeClient(async () => SAMPLE_BLOCK);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      hot: hot as SolanaRpcClient,
      logger: harness.logger,
    });

    const out = await fetcher.getBlock(999);

    expect(out).toBe(SAMPLE_BLOCK);
    expect(hot.getBlock).toHaveBeenCalledTimes(1);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
    expect(harness.debugSpy).toHaveBeenCalled();
  });

  it('returns null only after primary also reports a skipped slot', async () => {
    const hot = makeClient(async () => null);
    const primary = makeClient(async () => null);
    const fetcher = new BlockFetcher({
      primary: primary as SolanaRpcClient,
      hot: hot as SolanaRpcClient,
      logger: harness.logger,
    });

    const out = await fetcher.getBlock(999);

    expect(out).toBeNull();
    expect(hot.getBlock).toHaveBeenCalledTimes(1);
    expect(primary.getBlock).toHaveBeenCalledTimes(1);
  });
});
