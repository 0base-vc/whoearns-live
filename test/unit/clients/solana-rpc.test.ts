import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { HttpResponse, http, delay } from 'msw';
import { setupServer } from 'msw/node';
import { pino } from 'pino';
import { SolanaRpcClient, parseRetryAfterMs } from '../../../src/clients/solana-rpc.js';
import { RateLimitedError, UpstreamError } from '../../../src/core/errors.js';
import {
  blockProductionFixture,
  blockWithFeesFixture,
  blockWithoutFeesFixture,
  epochInfoFixture,
  epochScheduleFixture,
  getBlocksFixture,
  leaderScheduleFixture,
  rpcError,
  rpcResponse,
  voteAccountsFixture,
} from '../../fixtures/rpc-fixtures.js';

const RPC_URL = 'https://rpc.example.test/v1';

const silentLogger = pino({ level: 'silent' });

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function makeClient(
  overrides: Partial<{
    timeoutMs: number;
    concurrency: number;
    maxRetries: number;
  }> = {},
): SolanaRpcClient {
  return new SolanaRpcClient({
    url: RPC_URL,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    concurrency: overrides.concurrency ?? 4,
    maxRetries: overrides.maxRetries ?? 3,
    logger: silentLogger,
  });
}

/**
 * Parse the JSON-RPC request body MSW received so tests can assert on the
 * `method` and `params` fields without reaching into private client state.
 */
async function readBody(request: Request): Promise<{
  method: string;
  params?: unknown[];
  id: number;
}> {
  const body = (await request.json()) as {
    method: string;
    params?: unknown[];
    id: number;
  };
  return body;
}

describe('parseRetryAfterMs', () => {
  it('handles delta-seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5_000);
    expect(parseRetryAfterMs('0.25')).toBe(250);
  });
  it('handles HTTP-date', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(5_000);
    expect(ms).toBeLessThanOrEqual(10_500);
  });
  it('returns 0 for HTTP-date in the past', () => {
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT')).toBe(0);
  });
  it('returns undefined for null / empty / garbage', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('not a date')).toBeUndefined();
  });
});

describe('SolanaRpcClient — success paths', () => {
  it('getSlot returns the result field', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getSlot');
        expect(body.params).toEqual([{ commitment: 'finalized' }]);
        return HttpResponse.json(rpcResponse(216_120_000, body.id));
      }),
    );
    const client = makeClient();
    expect(await client.getSlot('finalized')).toBe(216_120_000);
  });

  it('getSlot sends no params when commitment omitted', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getSlot');
        expect(body.params).toBeUndefined();
        return HttpResponse.json(rpcResponse(42, body.id));
      }),
    );
    expect(await makeClient().getSlot()).toBe(42);
  });

  it('getEpochInfo returns the epoch info shape', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getEpochInfo');
        return HttpResponse.json(rpcResponse(epochInfoFixture, body.id));
      }),
    );
    expect(await makeClient().getEpochInfo('confirmed')).toEqual(epochInfoFixture);
  });

  it('getEpochSchedule sends no params', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getEpochSchedule');
        expect(body.params).toBeUndefined();
        return HttpResponse.json(rpcResponse(epochScheduleFixture, body.id));
      }),
    );
    expect(await makeClient().getEpochSchedule()).toEqual(epochScheduleFixture);
  });

  it('getLeaderSchedule passes [slot, {identity}]', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getLeaderSchedule');
        expect(body.params).toEqual([216_120_000, { identity: 'IdA' }]);
        return HttpResponse.json(rpcResponse(leaderScheduleFixture, body.id));
      }),
    );
    expect(await makeClient().getLeaderSchedule(216_120_000, 'IdA')).toEqual(leaderScheduleFixture);
  });

  it('getLeaderSchedule without args passes [null]', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.params).toEqual([null]);
        return HttpResponse.json(rpcResponse(null, body.id));
      }),
    );
    expect(await makeClient().getLeaderSchedule()).toBeNull();
  });

  it('getBlockProduction unwraps result.value', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getBlockProduction');
        expect(body.params).toEqual([
          { range: { firstSlot: 100, lastSlot: 200 }, identity: 'IdA' },
        ]);
        return HttpResponse.json(
          rpcResponse({ value: blockProductionFixture, context: { slot: 1 } }, body.id),
        );
      }),
    );
    const result = await makeClient().getBlockProduction({
      firstSlot: 100,
      lastSlot: 200,
      identity: 'IdA',
    });
    expect(result).toEqual(blockProductionFixture);
  });

  it('getBlockProductionAggregated chunks ranges larger than 5,000 slots', async () => {
    // Solana RPC rejects ranges > 5k with -32614 / HTTP 413. The
    // aggregated helper must split a 12,000-slot request into three
    // chunks (5k + 5k + 2k) and sum the per-identity pair counts
    // across them. We stub each chunk with its own response and
    // verify the sum.
    const calls: Array<{ firstSlot: number; lastSlot: number }> = [];
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getBlockProduction');
        const range = (body.params as Array<{ range?: { firstSlot: number; lastSlot: number } }>)[0]
          ?.range;
        expect(range).toBeDefined();
        calls.push({ firstSlot: range!.firstSlot, lastSlot: range!.lastSlot });
        // Return (3, 2) per chunk so final aggregation = (9, 6).
        return HttpResponse.json(
          rpcResponse(
            { value: { byIdentity: { IdA: [3, 2] }, range: range! }, context: { slot: 1 } },
            body.id,
          ),
        );
      }),
    );
    const result = await makeClient().getBlockProductionAggregated(0, 11_999, 'IdA');
    // 0..4999, 5000..9999, 10000..11999 → 3 calls
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ firstSlot: 0, lastSlot: 4999 });
    expect(calls[1]).toEqual({ firstSlot: 5000, lastSlot: 9999 });
    expect(calls[2]).toEqual({ firstSlot: 10_000, lastSlot: 11_999 });
    // Sum: 3+3+3 leader slots, 2+2+2 produced
    expect(result).toEqual({ leaderSlotsInRange: 9, slotsProduced: 6 });
  });

  it('getBlockProductionAggregated handles sub-5000 range with a single call', async () => {
    let callCount = 0;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        callCount += 1;
        return HttpResponse.json(
          rpcResponse(
            {
              value: { byIdentity: { IdA: [7, 5] }, range: { firstSlot: 100, lastSlot: 2599 } },
              context: { slot: 1 },
            },
            body.id,
          ),
        );
      }),
    );
    const result = await makeClient().getBlockProductionAggregated(100, 2599, 'IdA');
    expect(callCount).toBe(1);
    expect(result).toEqual({ leaderSlotsInRange: 7, slotsProduced: 5 });
  });

  it('getBlockProductionAggregated returns zeros when identity missing from every chunk', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        return HttpResponse.json(
          rpcResponse(
            {
              value: { byIdentity: {}, range: { firstSlot: 0, lastSlot: 4999 } },
              context: { slot: 1 },
            },
            body.id,
          ),
        );
      }),
    );
    const result = await makeClient().getBlockProductionAggregated(0, 9999, 'IdA');
    expect(result).toEqual({ leaderSlotsInRange: 0, slotsProduced: 0 });
  });

  it('getBlocks passes [start, end, {commitment}]', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getBlocks');
        expect(body.params).toEqual([100, 200, { commitment: 'finalized' }]);
        return HttpResponse.json(rpcResponse(getBlocksFixture, body.id));
      }),
    );
    expect(await makeClient().getBlocks(100, 200, 'finalized')).toEqual(getBlocksFixture);
  });

  it('getBlocks with commitment but no endSlot still emits [start, null, {commitment}]', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.params).toEqual([100, null, { commitment: 'finalized' }]);
        return HttpResponse.json(rpcResponse(getBlocksFixture, body.id));
      }),
    );
    expect(await makeClient().getBlocks(100, undefined, 'finalized')).toEqual(getBlocksFixture);
  });

  it('getBlock returns the block', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getBlock');
        expect(body.params).toEqual([
          216_120_100,
          {
            transactionDetails: 'none',
            rewards: true,
            maxSupportedTransactionVersion: 0,
            commitment: 'finalized',
          },
        ]);
        return HttpResponse.json(rpcResponse(blockWithFeesFixture, body.id));
      }),
    );
    const block = await makeClient().getBlock(216_120_100, {
      transactionDetails: 'none',
      rewards: true,
      maxSupportedTransactionVersion: 0,
      commitment: 'finalized',
    });
    expect(block).toEqual(blockWithFeesFixture);
  });

  it('getBlock with no opts passes just [slot]', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.params).toEqual([216_120_100]);
        return HttpResponse.json(rpcResponse(blockWithoutFeesFixture, body.id));
      }),
    );
    expect(await makeClient().getBlock(216_120_100)).toEqual(blockWithoutFeesFixture);
  });

  it('getBlock returns null for a skipped slot', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        return HttpResponse.json(rpcResponse(null, body.id));
      }),
    );
    expect(await makeClient().getBlock(216_120_200)).toBeNull();
  });

  it('getBlock returns null when the provider reports a skipped slot as RPC -32007', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        return HttpResponse.json(
          rpcError(
            -32007,
            'Slot 415631972 was skipped, or missing due to ledger jump to recent snapshot',
            body.id,
          ),
        );
      }),
    );
    expect(await makeClient().getBlock(415_631_972)).toBeNull();
  });

  it('getVoteAccounts returns current+delinquent shape', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        expect(body.method).toBe('getVoteAccounts');
        return HttpResponse.json(rpcResponse(voteAccountsFixture, body.id));
      }),
    );
    expect(await makeClient().getVoteAccounts('finalized')).toEqual(voteAccountsFixture);
  });

  it('sums Fee rewards for the leader identity (semantics smoke test)', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        return HttpResponse.json(rpcResponse(blockWithFeesFixture, body.id));
      }),
    );
    const block = await makeClient().getBlock(216_120_100);
    expect(block).not.toBeNull();
    // Sum Fee-typed rewards paid to leader A from the fixture.
    const leader = 'IdentityAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const total = (block?.rewards ?? [])
      .filter((r) => r.rewardType === 'Fee' && r.pubkey === leader)
      .reduce((acc, r) => acc + BigInt(r.lamports), 0n);
    expect(total).toBe(12_345_678n);
  });
});

describe('SolanaRpcClient — error paths & retries', () => {
  it('retries on transient 5xx then succeeds', async () => {
    let callCount = 0;
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        callCount += 1;
        if (callCount === 1) {
          return new HttpResponse('boom', { status: 500 });
        }
        const body = await readBody(request);
        return HttpResponse.json(rpcResponse(1, body.id));
      }),
    );
    expect(await makeClient({ maxRetries: 2 }).getSlot()).toBe(1);
    expect(callCount).toBe(2);
  });

  it('throws UpstreamError after maxRetries on persistent 500', async () => {
    let callCount = 0;
    server.use(
      http.post(RPC_URL, () => {
        callCount += 1;
        return new HttpResponse('still broken', { status: 500 });
      }),
    );
    const client = makeClient({ maxRetries: 2 });
    await expect(client.getSlot()).rejects.toBeInstanceOf(UpstreamError);
    expect(callCount).toBe(3); // initial + 2 retries
  });

  it('honours Retry-After on 429 and eventually succeeds', async () => {
    let callCount = 0;
    const start = Date.now();
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        callCount += 1;
        if (callCount === 1) {
          return new HttpResponse('slow down', {
            status: 429,
            headers: { 'retry-after': '0.05' },
          });
        }
        const body = await readBody(request);
        return HttpResponse.json(rpcResponse(7, body.id));
      }),
    );
    const client = makeClient({ maxRetries: 2 });
    expect(await client.getSlot()).toBe(7);
    expect(callCount).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it('throws RateLimitedError with retryAfterMs after persistent 429', async () => {
    let callCount = 0;
    server.use(
      http.post(RPC_URL, () => {
        callCount += 1;
        return new HttpResponse('slow', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      }),
    );
    const client = makeClient({ maxRetries: 1 });
    try {
      await client.getSlot();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      const e = err as RateLimitedError;
      expect(e.statusCode).toBe(429);
      expect(e.details).toMatchObject({
        upstream: 'solana-rpc',
        retryAfterMs: 1000,
      });
    }
    expect(callCount).toBe(2); // initial + 1 retry
  });

  it('throws UpstreamError when the RPC body contains an error field', async () => {
    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await readBody(request);
        return HttpResponse.json(rpcError(-32600, 'Invalid request', body.id));
      }),
    );
    const client = makeClient({ maxRetries: 0 });
    try {
      await client.getSlot();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamError);
      const e = err as UpstreamError;
      expect(e.message).toContain('-32600');
      expect(e.message).toContain('Invalid request');
      expect(e.details).toMatchObject({
        rpcCode: -32600,
        rpcMessage: 'Invalid request',
      });
    }
  });

  it('throws UpstreamError on request timeout', async () => {
    server.use(
      http.post(RPC_URL, async () => {
        // MSW supports delay(); longer than the client timeout.
        await delay(1_000);
        return HttpResponse.json(rpcResponse(1));
      }),
    );
    const client = makeClient({ timeoutMs: 50, maxRetries: 0 });
    await expect(client.getSlot()).rejects.toBeInstanceOf(UpstreamError);
  });

  it('throws UpstreamError on non-5xx non-429 HTTP error without retrying', async () => {
    let callCount = 0;
    server.use(
      http.post(RPC_URL, () => {
        callCount += 1;
        return new HttpResponse('bad request', { status: 400 });
      }),
    );
    const client = makeClient({ maxRetries: 3 });
    await expect(client.getSlot()).rejects.toBeInstanceOf(UpstreamError);
    expect(callCount).toBe(1);
  });

  it('throws UpstreamError on invalid JSON body', async () => {
    server.use(
      http.post(RPC_URL, () => {
        return new HttpResponse('not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const client = makeClient({ maxRetries: 0 });
    await expect(client.getSlot()).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('SolanaRpcClient — concurrency cap', () => {
  it('never allows more than `concurrency` in-flight requests', async () => {
    const concurrency = 3;
    let inFlight = 0;
    let maxInFlight = 0;
    const totalRequests = 12;

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await delay(25);
        inFlight -= 1;
        const body = await readBody(request);
        return HttpResponse.json(rpcResponse(1, body.id));
      }),
    );

    const client = makeClient({ concurrency, maxRetries: 0 });
    await Promise.all(Array.from({ length: totalRequests }, () => client.getSlot()));
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(maxInFlight).toBeGreaterThan(0);
  });
});
