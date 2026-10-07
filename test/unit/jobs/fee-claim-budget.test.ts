import { afterEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { EpochService } from '../../../src/services/epoch.service.js';
import { FeeService } from '../../../src/services/fee.service.js';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import {
  FakeEpochsRepo,
  FakeStatsRepo,
  FakeProcessedBlocksRepo,
  makeEpochInfo,
} from '../services/_fakes.js';

const logger = pino({ level: 'silent' });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function fixture(
  mode: 'hang' | 'backoff' | 'ignore cancellation' | 'partial failure',
  concurrency = 2,
  intervalMs = 30_000,
) {
  const epochs = new FakeEpochsRepo();
  await epochs.upsert(makeEpochInfo(500, 50000, 50099));
  let recovering = false;
  let tip = 50001;
  let pinned: number | null = null;
  const methods: string[] = [];
  const blocks: number[] = [];
  const signals: AbortSignal[] = [];
  const late: Array<{ resolve: (response: Response) => void; reject: (err: Error) => void }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      const { method, params } = JSON.parse(options.body as string) as {
        method: string;
        params: unknown[];
      };
      methods.push(method);
      if ((method === 'getEpochInfo' || method === 'getEpochSchedule') && !recovering) {
        const signal = options.signal!;
        signals.push(signal);
        if (mode === 'partial failure' && method === 'getEpochInfo')
          return new Response('', { status: 400 });
        if (mode === 'backoff')
          return new Response('', { status: 429, headers: { 'retry-after': '300' } });
        return new Promise<Response>((resolve, reject) => {
          if (mode === 'ignore cancellation') late.push({ resolve, reject });
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      let result: unknown;
      if (method === 'getEpochInfo') result = { epoch: 501, absoluteSlot: 50103 };
      else if (method === 'getEpochSchedule')
        result = { firstNormalEpoch: 0, firstNormalSlot: 0, slotsPerEpoch: 100 };
      else if (method === 'getLeaderSchedule') result = { IA: [1, 2, 3, 4] };
      else if (method === 'getSlot') result = tip;
      else if (method === 'getBlock') {
        blocks.push(params[0] as number);
        result = null;
      } else throw new Error(`unexpected method ${method}`);
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    }),
  );
  const rpc = new SolanaRpcClient({
    url: 'https://fixture.invalid',
    timeoutMs: 30_000,
    maxRetries: 3,
    concurrency,
    logger,
  });
  const stats = new FakeStatsRepo();
  const job = createFeeIngesterJob({
    rpc,
    logger,
    epochService: new EpochService({
      rpc,
      logger,
      epochsRepo: epochs as unknown as EpochsRepository,
    }),
    epochsRepo: epochs,
    feeService: new FeeService({
      rpc,
      logger,
      statsRepo: stats as unknown as StatsRepository,
      processedBlocksRepo: new FakeProcessedBlocksRepo() as unknown as ProcessedBlocksRepository,
    }),
    statsRepo: {
      backfillMissingMedianFees: async () => ({ epochsTouched: 0, rowsUpdated: 0 }),
      ensureSlotStatsRows: async () => 0,
      rebuildIncomeTotalsFromProcessedBlocks: async () => 0,
    },
    watchedDynamicRepo: {
      getUnclaimedBackfillCandidates: async () =>
        pinned === null ? [{ vote: 'A', version: 'fixture', tuple: '(0,1)' }] : [],
      getOrSetBackfillTargets: async (epoch) => {
        if (epoch !== null) pinned = epoch;
        return new Map();
      },
      markBackfilled: async () => false,
    },
    validatorService: {
      getActiveVotePubkeys: async () => ['A'],
      getIdentityMap: async () => new Map([['A', 'IA']]),
      getActivatedStakeLamports: () => null,
    } as unknown as ValidatorService,
    watchMode: 'explicit',
    explicitVotes: ['A'],
    intervalMs,
    batchSize: 1,
    finalityBuffer: 0,
  });
  return {
    job,
    epochs,
    methods,
    blocks,
    signals,
    late,
    pinned: () => pinned,
    next: () => {
      tip++;
    },
    recover: () => {
      recovering = true;
      tip = 50103;
    },
  };
}

async function timedTick(job: Awaited<ReturnType<typeof fixture>>['job']) {
  const tick = job.tick(new AbortController().signal);
  await Promise.all([tick, vi.advanceTimersByTimeAsync(1_000)]);
}

describe('fee claim RPC budget preserves live ingestion', () => {
  it.each([1, 2])(
    'cancels active/queued epoch RPC, keeps live progress through repeated timeouts and recovers (concurrency=%s)',
    async (concurrency) => {
      vi.useFakeTimers();
      const f = await fixture('hang', concurrency);
      await timedTick(f.job);
      expect(f.pinned()).toBeNull();
      expect(f.blocks).toEqual([50001]);
      expect(f.signals.every((s) => s.aborted)).toBe(true);
      f.next();
      await timedTick(f.job);
      expect(f.blocks).toEqual([50001, 50002]);
      expect(f.methods.filter((m) => m === 'getEpochInfo')).toHaveLength(2);
      expect(await f.epochs.findByEpoch(501)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      f.recover();
      await f.job.tick(new AbortController().signal);
      expect(f.pinned()).toBe(500);
      expect(f.blocks).toContain(50103);
      expect((await f.epochs.findCurrent())?.epoch).toBe(501);
      const calls = f.methods.filter((m) => m === 'getEpochInfo').length;
      f.next();
      await f.job.tick(new AbortController().signal);
      expect(f.blocks).toContain(50104);
      expect(f.methods.filter((m) => m === 'getEpochInfo')).toHaveLength(calls);
    },
  );

  it('cancels a long Retry-After wait rather than spending the live budget or leaving a retry timer', async () => {
    vi.useFakeTimers();
    const f = await fixture('backoff');
    await timedTick(f.job);
    expect(f.blocks).toEqual([50001]);
    expect(f.pinned()).toBeNull();
    expect(f.methods.filter((m) => m === 'getEpochInfo')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)(
    'consumes late RPC %s without late epoch writes or claims',
    async (settlement) => {
      vi.useFakeTimers();
      const f = await fixture('ignore cancellation');
      await timedTick(f.job);
      expect(f.blocks).toEqual([50001]);
      expect(f.pinned()).toBeNull();
      for (const late of f.late) {
        if (settlement === 'resolve')
          late.resolve(Response.json({ result: { epoch: 501, absoluteSlot: 50103 } }));
        else late.reject(new Error('late abandoned RPC failure'));
      }
      await vi.advanceTimersByTimeAsync(100_000);
      expect(f.pinned()).toBeNull();
      expect((await f.epochs.findCurrent())?.epoch).toBe(500);
      expect(await f.epochs.findByEpoch(501)).toBeNull();
      expect(f.methods.filter((m) => m === 'getEpochInfo')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      f.recover();
      await f.job.tick(new AbortController().signal);
      expect(f.pinned()).toBe(500);
      expect(f.blocks).toContain(50103);
    },
  );

  it('cancels the companion epoch request when the other one fails immediately', async () => {
    vi.useFakeTimers();
    const f = await fixture('partial failure', 1);
    await timedTick(f.job);
    expect(f.signals.every((s) => s.aborted)).toBe(true);
    expect(f.blocks).toEqual([50001]);
    expect(f.pinned()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops preflight on job shutdown without starting live work or leaving a timer', async () => {
    vi.useFakeTimers();
    const f = await fixture('hang');
    const controller = new AbortController();
    const tick = f.job.tick(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await tick;
    expect(f.signals.every((s) => s.aborted)).toBe(true);
    expect(f.blocks).toEqual([]);
    expect(f.pinned()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a real preflight timer with otherwise usable block RPC', async () => {
    const f = await fixture('hang', 2, 100);
    await f.job.tick(new AbortController().signal);
    expect(f.signals.every((s) => s.aborted)).toBe(true);
    expect(f.blocks).toEqual([50001]);
    expect(f.pinned()).toBeNull();
  });
});
