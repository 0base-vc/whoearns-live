import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import {
  createEpochWatcherJob,
  EPOCH_WATCHER_JOB_NAME,
} from '../../../src/jobs/epoch-watcher.job.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';

const silent = pino({ level: 'silent' });

function makeServices(): { epochService: EpochService; validatorService: ValidatorService } {
  const epochService = {
    syncCurrent: vi.fn().mockResolvedValue({
      epoch: 500,
      firstSlot: 0,
      lastSlot: 100,
      slotCount: 101,
      isClosed: false,
      observedAt: new Date(),
      closedAt: null,
    }),
    getCurrent: vi.fn().mockResolvedValue(null),
  } as unknown as EpochService;
  const validatorService = {
    refreshFromRpc: vi.fn().mockResolvedValue([]),
    getActiveVotePubkeys: vi.fn(),
    getIdentityMap: vi.fn(),
  } as unknown as ValidatorService;
  return { epochService, validatorService };
}

describe('epoch-watcher.job', () => {
  it('exposes a stable job name and interval', () => {
    const { epochService, validatorService } = makeServices();
    const job = createEpochWatcherJob({
      epochService,
      validatorService,
      intervalMs: 30_000,
      logger: silent,
    });
    expect(job.name).toBe(EPOCH_WATCHER_JOB_NAME);
    expect(job.intervalMs).toBe(30_000);
  });

  it('calls syncCurrent on every tick', async () => {
    const { epochService, validatorService } = makeServices();
    const job = createEpochWatcherJob({
      epochService,
      validatorService,
      intervalMs: 1_000,
      logger: silent,
    });
    await job.tick(new AbortController().signal);
    await job.tick(new AbortController().signal);
    expect(epochService.syncCurrent).toHaveBeenCalledTimes(2);
  });

  it('refreshes validators on tick 1 (cold start)', async () => {
    const { epochService, validatorService } = makeServices();
    const job = createEpochWatcherJob({
      epochService,
      validatorService,
      intervalMs: 1_000,
      logger: silent,
      validatorRefreshEveryNTicks: 5,
    });
    await job.tick(new AbortController().signal);
    expect(validatorService.refreshFromRpc).toHaveBeenCalledWith(500);
  });

  it('refreshes validators on every Nth subsequent tick', async () => {
    const { epochService, validatorService } = makeServices();
    const job = createEpochWatcherJob({
      epochService,
      validatorService,
      intervalMs: 1_000,
      logger: silent,
      validatorRefreshEveryNTicks: 3,
    });
    for (let i = 0; i < 7; i++) {
      await job.tick(new AbortController().signal);
    }
    // Tick 1 (cold), then ticks 3, 6 → 3 refreshes.
    expect(validatorService.refreshFromRpc).toHaveBeenCalledTimes(3);
  });

  it('uses default refresh cadence of 10 when not overridden', async () => {
    const { epochService, validatorService } = makeServices();
    const job = createEpochWatcherJob({
      epochService,
      validatorService,
      intervalMs: 1_000,
      logger: silent,
    });
    for (let i = 0; i < 11; i++) {
      await job.tick(new AbortController().signal);
    }
    // Tick 1 + tick 10 = 2 refreshes.
    expect(validatorService.refreshFromRpc).toHaveBeenCalledTimes(2);
  });
});
