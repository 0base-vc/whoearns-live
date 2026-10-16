import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCacheWarmer } from '../../../src/api/cache-warmer.js';
import { resetCuCache } from '../../../src/api/cu-cache.js';
import type { EpochInfo } from '../../../src/types/domain.js';

const logger = pino({ level: 'silent' });

function makeDeps() {
  return {
    statsRepo: {
      refreshEconomicCohortSnapshot: vi.fn(async (_from: number, _to: number) => ({}) as never),
    },
    epochsRepo: {
      findCurrent: vi.fn<() => Promise<EpochInfo | null>>(
        async () => ({ epoch: 100 }) as EpochInfo,
      ),
      findLatestClosed: vi.fn<() => Promise<EpochInfo | null>>(
        async () => ({ epoch: 99 }) as EpochInfo,
      ),
    },
    processedBlocksRepo: {
      getEpochComputeUnitsServiceWide: vi.fn(
        async (_epochs: number[]) => new Map<number, bigint | null>(),
      ),
      getEpochComputeUnitsByClient: vi.fn(
        async (_epochs: number[], _kind: string | null) => new Map<number, bigint | null>(),
      ),
    },
    validatorsRepo: { findTopClientKinds: vi.fn(async () => ['agave_bam', 'jito_solana']) },
    logger,
    intervalMs: 60_000,
  };
}

describe('startCacheWarmer', () => {
  beforeEach(() => {
    resetCuCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('warms the latest closed 10-epoch window and the CU series at start-up', async () => {
    const deps = makeDeps();
    const warmer = startCacheWarmer(deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.statsRepo.refreshEconomicCohortSnapshot).toHaveBeenCalledWith(90, 99);
    const serviceArgs = deps.processedBlocksRepo.getEpochComputeUnitsServiceWide.mock.calls[0]?.[0];
    expect(serviceArgs).toHaveLength(52);
    expect(Math.max(...(serviceArgs ?? []))).toBe(100);
    expect(
      deps.processedBlocksRepo.getEpochComputeUnitsByClient.mock.calls.map((c) => c[1]),
    ).toEqual(['agave_bam', 'jito_solana']);
    warmer.stop();
  });

  it('keeps going when one step fails, and retries on the next tick', async () => {
    const deps = makeDeps();
    deps.statsRepo.refreshEconomicCohortSnapshot
      .mockRejectedValueOnce(new Error('statement timeout'))
      .mockResolvedValue({} as never);
    const warmer = startCacheWarmer(deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.processedBlocksRepo.getEpochComputeUnitsServiceWide).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.statsRepo.refreshEconomicCohortSnapshot).toHaveBeenCalledTimes(2);
    warmer.stop();
  });

  it('skips the cohort step when no epoch has closed yet', async () => {
    const deps = makeDeps();
    deps.epochsRepo.findLatestClosed.mockResolvedValue(null);
    const warmer = startCacheWarmer(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.statsRepo.refreshEconomicCohortSnapshot).not.toHaveBeenCalled();
    expect(deps.processedBlocksRepo.getEpochComputeUnitsServiceWide).toHaveBeenCalledTimes(1);
    warmer.stop();
  });

  it('does not overlap ticks and stops cleanly', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps();
    deps.statsRepo.refreshEconomicCohortSnapshot.mockImplementation(async () => {
      await gate;
      return {} as never;
    });
    const warmer = startCacheWarmer(deps);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(deps.statsRepo.refreshEconomicCohortSnapshot).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    warmer.stop();
    const calls = deps.statsRepo.refreshEconomicCohortSnapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(deps.statsRepo.refreshEconomicCohortSnapshot.mock.calls.length).toBe(calls);
  });
});
