import { afterEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { FeeService } from '../../../src/services/fee.service.js';
import { makeEpochInfo } from '../services/_fakes.js';

const logger = pino({ level: 'silent' });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(mode: 'hang' | 'backoff' | 'fallback' | 'success' | 'late', intervalMs = 100) {
  const requests: { url: string; slot: number; signal: AbortSignal }[] = [];
  const late: { resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
  let tip = 50001;
  let lookupMs = 0;
  const backfill = vi.fn().mockResolvedValue({ processed: 0, skipped: 0, errors: 0, remaining: 1 });
  const mark = vi.fn().mockResolvedValue(false);
  const live = vi.fn().mockResolvedValue({ processed: 0, skipped: 0, errors: 0 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, opts: RequestInit) => {
      const { method, params } = JSON.parse(opts.body as string) as {
        method: string;
        params: number[];
      };
      if (method === 'getSlot') return Response.json({ result: tip });
      if (method !== 'getLeaderSchedule') throw new Error(method);
      const slot = params[0]!;
      if (slot === 50000) return Response.json({ result: { IA: [1, 2] } });
      requests.push({ url, slot, signal: opts.signal! });
      if (mode === 'success') return Response.json({ result: { IA: [1, 2] } });
      if (mode === 'fallback' && url.includes('primary')) return new Response('', { status: 400 });
      if (mode === 'backoff')
        return new Response('', { status: 429, headers: { 'retry-after': '300' } });
      return new Promise<Response>((resolve, reject) => {
        if (mode === 'late') late.push({ resolve, reject });
        else
          opts.signal!.addEventListener('abort', () => reject(opts.signal!.reason), { once: true });
      });
    }),
  );
  const client = (url: string) =>
    new SolanaRpcClient({ url, timeoutMs: 30000, maxRetries: 3, concurrency: 1, logger });
  const job = createFeeIngesterJob({
    rpc: client('https://primary.invalid'),
    rpcFallback: client('https://fallback.invalid'),
    logger,
    epochService: { getCurrent: async () => makeEpochInfo(500, 50000, 50099) } as EpochService,
    epochsRepo: {
      findByEpoch: async () => {
        if (lookupMs) await new Promise((r) => setTimeout(r, lookupMs));
        return { ...makeEpochInfo(499, 49900, 49999), isClosed: true };
      },
    },
    watchedDynamicRepo: {
      getUnclaimedBackfillCandidates: async () => [],
      getOrSetBackfillTargets: async () => new Map([['A', { epoch: 499, identity: 'IA' }]]),
      markBackfilled: mark,
    },
    validatorService: {
      getActiveVotePubkeys: async () => ['A'],
      getIdentityMap: async () => new Map([['A', 'IA']]),
      getActivatedStakeLamports: () => null,
    } as unknown as ValidatorService,
    feeService: {
      ingestPendingBlocks: live,
      backfillPreviousEpoch: backfill,
    } as unknown as FeeService,
    statsRepo: {
      ensureSlotStatsRows: async () => 0,
      rebuildIncomeTotalsFromProcessedBlocks: async () => 0,
      backfillMissingMedianFees: async () => ({ epochsTouched: 0, rowsUpdated: 0 }),
    },
    watchMode: 'explicit',
    explicitVotes: ['A'],
    intervalMs,
    batchSize: 1,
    finalityBuffer: 0,
  });
  return {
    job,
    requests,
    late,
    backfill,
    mark,
    live,
    next: () => tip++,
    lookup: (ms: number) => {
      lookupMs = ms;
    },
  };
}

describe('historical leader schedule shares the remaining tick budget', () => {
  it.each(['hang', 'backoff', 'fallback'] as const)(
    'cancels %s and lets the next live tick proceed without historical completion',
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture(mode);
      for (let i = 0; i < 2; i++) {
        let finished = false;
        const tick = f.job.tick(new AbortController().signal).then(() => {
          finished = true;
        });
        await vi.advanceTimersByTimeAsync(101);
        expect(finished).toBe(true);
        await tick;
        expect(f.requests.every((r) => r.signal.aborted)).toBe(true);
        expect(f.live).toHaveBeenCalledTimes(i + 1);
        f.next();
      }
      expect(f.requests.filter((r) => r.url.includes('fallback'))).toHaveLength(
        mode === 'fallback' ? 2 : 0,
      );
      expect(f.backfill).not.toHaveBeenCalled();
      expect(f.mark).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('honours shutdown before the deadline without attempting fallback', async () => {
    vi.useFakeTimers();
    const f = fixture('hang', 30000),
      controller = new AbortController();
    let finished = false;
    const tick = f.job.tick(controller.signal).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    await tick;
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.signal.aborted).toBe(true);
    expect(f.mark).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['resolve', 'reject'] as const)(
    'consumes late schedule %s without backfill or completion',
    async (settlement) => {
      vi.useFakeTimers();
      const f = fixture('late');
      let finished = false;
      const tick = f.job.tick(new AbortController().signal).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(101);
      expect(finished).toBe(true);
      await tick;
      for (const l of f.late) {
        if (settlement === 'resolve') l.resolve(Response.json({ result: { IA: [1] } }));
        else l.reject(new Error('late schedule failure'));
      }
      await vi.advanceTimersByTimeAsync(100000);
      expect(f.requests).toHaveLength(1);
      expect(f.backfill).not.toHaveBeenCalled();
      expect(f.mark).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('does not start a schedule RPC when the epoch lookup exhausts the budget', async () => {
    vi.useFakeTimers();
    const f = fixture('success');
    f.lookup(101);
    const tick = f.job.tick(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(101);
    await tick;
    expect(f.requests).toHaveLength(0);
    expect(f.backfill).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
  });
  it('keeps successful bounded backfill and clears the schedule timer', async () => {
    vi.useFakeTimers();
    const f = fixture('success');
    await f.job.tick(new AbortController().signal);
    expect(f.backfill).toHaveBeenCalledOnce();
    expect(f.backfill.mock.calls[0]![0]).toMatchObject({
      epoch: 499,
      identity: 'IA',
      maxBlocks: 1,
      requireStatsIdentityMatch: true,
    });
    expect(f.mark).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses a real deadline timer', async () => {
    const f = fixture('hang', 20);
    await f.job.tick(new AbortController().signal);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.signal.aborted).toBe(true);
    expect(f.backfill).not.toHaveBeenCalled();
  });
});
