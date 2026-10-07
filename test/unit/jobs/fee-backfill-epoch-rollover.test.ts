import { withBulkTargets } from './_backfill-target-fake.js';
import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { createFeeIngesterJob } from '../../../src/jobs/fee-ingester.job.js';
import { FeeService } from '../../../src/services/fee.service.js';
import type { EpochService } from '../../../src/services/epoch.service.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import type { ProcessedBlocksRepository } from '../../../src/storage/repositories/processed-blocks.repo.js';
import { FakeProcessedBlocksRepo, FakeStatsRepo } from '../services/_fakes.js';
import { IDENTITY_A, IDENTITY_B, VOTE_A, VOTE_B } from '../../fixtures/rpc-fixtures.js';

describe.each([false, true])('dynamic backfill rollover (restart=%s)', (restart) => {
  it('finishes the original epoch, rotates past errors and lets a new target finish independently', async () => {
    const logger = pino({ level: 'silent' });
    let currentEpoch = 500;
    let historyAvailable = false;
    const stats = new FakeStatsRepo();
    const blocks = new FakeProcessedBlocksRepo();
    // This store outlives a job instance, like the dynamic watched DB row.
    // The integration suite separately checks the real atomic SQL behavior.
    const targets = new Map<string, { epoch: number; identity: string }>();
    const completed = new Map<string, number>();
    const tracked = [VOTE_A];
    const watchedDynamicRepo = withBulkTargets(
      {
        listPendingBackfill: vi.fn(async () => tracked.filter((vote) => !completed.has(vote))),
        getOrSetBackfillTarget: vi.fn(async (vote: string, proposed: number, identity: string) => {
          if (!targets.has(vote)) targets.set(vote, { epoch: proposed, identity });
          return targets.get(vote)!;
        }),
        markBackfilled: vi.fn(async (vote: string, epoch: number, identity: string) => {
          if (targets.get(vote)?.epoch === epoch && targets.get(vote)?.identity === identity) {
            completed.set(vote, epoch);
            return true;
          }
          return false;
        }),
      },
      async () =>
        new Map([
          [VOTE_A, IDENTITY_A],
          [VOTE_B, IDENTITY_B],
        ]),
    );
    const getBlock = vi.fn(async (slot: number) => {
      if (slot === 0 && !historyAvailable) throw new Error('persistent pruned slot');
      return null; // skipped slots are still durably captured facts
    });
    const rpc = {
      getBlock,
      getSlot: vi.fn(async () => (currentEpoch - 499) * 100 + 5),
      getLeaderSchedule: vi.fn(async (firstSlot: number) => {
        if (firstSlot === 0) return { [IDENTITY_A]: [0, 1, 2] };
        if (firstSlot === 100) return { [IDENTITY_A]: [0], [IDENTITY_B]: [1, 2] };
        return { [IDENTITY_A]: [0], [IDENTITY_B]: [1] };
      }),
    } as unknown as SolanaRpcClient;
    const getEpoch = (epoch: number) => ({
      epoch,
      firstSlot: (epoch - 499) * 100,
      lastSlot: (epoch - 499) * 100 + 99,
      slotCount: 100,
      currentSlot: null,
      isClosed: epoch < currentEpoch,
      observedAt: new Date(),
      closedAt: epoch < currentEpoch ? new Date() : null,
    });
    const makeJob = () => {
      const feeService = new FeeService({
        rpc,
        logger,
        statsRepo: stats as unknown as StatsRepository,
        processedBlocksRepo: blocks as unknown as ProcessedBlocksRepository,
      });
      const backfill = vi.spyOn(feeService, 'backfillPreviousEpoch');
      const job = createFeeIngesterJob({
        rpc,
        feeService,
        logger,
        epochService: {
          getCurrent: async () => getEpoch(currentEpoch),
          syncCurrent: async () => getEpoch(currentEpoch),
        } as EpochService,
        epochsRepo: { findByEpoch: vi.fn(async (epoch) => getEpoch(epoch)) },
        validatorService: {
          getActiveVotePubkeys: async () => tracked,
          getIdentityMap: async (votes: string[]) =>
            new Map(
              (
                [
                  [VOTE_A, IDENTITY_A],
                  [VOTE_B, IDENTITY_B],
                ] as const
              ).filter(([vote]) => votes.includes(vote)),
            ),
          getActivatedStakeLamports: () => null,
        } as unknown as ValidatorService,
        statsRepo: {
          backfillMissingMedianFees: vi
            .fn()
            .mockResolvedValue({ epochsTouched: 0, rowsUpdated: 0 }),
          ensureSlotStatsRows: vi.fn(),
          rebuildIncomeTotalsFromProcessedBlocks: vi.fn().mockResolvedValue(0),
        },
        watchedDynamicRepo,
        watchMode: 'explicit',
        explicitVotes: tracked,
        intervalMs: 30_000,
        batchSize: 1,
        finalityBuffer: 0,
      });
      return { job, backfill };
    };
    let worker = makeJob();
    const oldBackfills = [worker.backfill];
    const signal = new AbortController().signal;
    await worker.job.tick(signal);
    expect(completed.size).toBe(0);

    // Epoch 499 still has three missing facts. Epoch 500's A facts are
    // already complete, so switching targets would incorrectly stamp A.
    currentEpoch = 501;
    tracked.push(VOTE_B);
    if (restart) {
      worker = makeJob();
      oldBackfills.push(worker.backfill);
    }
    for (let n = 0; n < 8; n++) await worker.job.tick(signal);

    const calls = oldBackfills.flatMap((spy) => spy.mock.calls.map(([args]) => args));
    expect(calls.filter((args) => args.vote === VOTE_A).every((args) => args.epoch === 499)).toBe(
      true,
    );
    expect(calls.filter((args) => args.vote === VOTE_B).every((args) => args.epoch === 500)).toBe(
      true,
    );
    expect(watchedDynamicRepo.markBackfilled).not.toHaveBeenCalledWith(VOTE_A, 500, IDENTITY_A);
    expect(completed.get(VOTE_B)).toBe(500);
    expect(completed.has(VOTE_A)).toBe(false);
    expect(blocks.rows.has(1)).toBe(true);
    expect(blocks.rows.has(2)).toBe(true);
    expect(blocks.rows.has(0)).toBe(false);
    expect(blocks.rows.has(200)).toBe(true); // new epoch live work continues
    expect(blocks.rows.has(201)).toBe(true);

    historyAvailable = true;
    await worker.job.tick(signal);
    expect(completed.get(VOTE_A)).toBe(499);
    expect(blocks.rows.has(0)).toBe(true);
    expect(stats.rows.get(`499:${VOTE_A}`)?.slotsSkipped).toBe(3);
    expect(watchedDynamicRepo.markBackfilled).toHaveBeenCalledWith(VOTE_A, 499, IDENTITY_A);
    const attempts = getBlock.mock.calls.map(([slot]) => slot);
    expect(attempts.filter((slot) => slot === 100)).toHaveLength(1);
    expect(attempts.filter((slot) => slot === 1)).toHaveLength(1);
    expect(attempts.filter((slot) => slot === 2)).toHaveLength(1);
  });
});
