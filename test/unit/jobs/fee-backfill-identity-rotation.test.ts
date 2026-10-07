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
import { IDENTITY_A, IDENTITY_B, VOTE_A } from '../../fixtures/rpc-fixtures.js';

describe.each([false, true])('backfill identity rotation (restart=%s)', (restart) => {
  it.each([false, true])(
    'finishes the original schedule even when the new identity has old slots=%s',
    async (newIdentityHasSlots) => {
      const logger = pino({ level: 'silent' });
      const stats = new FakeStatsRepo();
      const blocks = new FakeProcessedBlocksRepo();
      let epoch = 500;
      let identity = IDENTITY_A;
      let available = false;
      let target: { epoch: number; identity: string } | undefined;
      let complete = false;
      const watchedDynamicRepo = {
        listPendingBackfill: vi.fn(async () => (complete ? [] : [VOTE_A])),
        getOrSetBackfillTarget: vi.fn(
          async (_vote: string, proposed: number, proposedIdentity: string) =>
            (target ??= { epoch: proposed, identity: proposedIdentity }),
        ),
        markBackfilled: vi.fn(async () => {
          complete = true;
        }),
      };
      const getBlock = vi.fn(async (slot: number) => {
        if (slot === 0 && !available) throw new Error('persistent unavailable original slot');
        return null;
      });
      const rpc = {
        getBlock,
        getSlot: async () => (epoch - 499) * 100 + 5,
        getLeaderSchedule: vi.fn(async (firstSlot: number) =>
          firstSlot === 0
            ? { [IDENTITY_A]: [0, 1, 2], ...(newIdentityHasSlots ? { [IDENTITY_B]: [3, 4] } : {}) }
            : { [IDENTITY_A]: [0], [IDENTITY_B]: [1] },
        ),
      } as unknown as SolanaRpcClient;
      const info = (e: number) => ({
        epoch: e,
        firstSlot: (e - 499) * 100,
        lastSlot: (e - 499) * 100 + 99,
        slotCount: 100,
        currentSlot: null,
        isClosed: e < epoch,
        observedAt: new Date(),
        closedAt: e < epoch ? new Date() : null,
      });
      const makeWorker = () => {
        const feeService = new FeeService({
          rpc,
          logger,
          statsRepo: stats as unknown as StatsRepository,
          processedBlocksRepo: blocks as unknown as ProcessedBlocksRepository,
        });
        const historical = vi.spyOn(feeService, 'backfillPreviousEpoch');
        const job = createFeeIngesterJob({
          rpc,
          logger,
          feeService,
          watchedDynamicRepo,
          epochService: { getCurrent: async () => info(epoch) } as EpochService,
          epochsRepo: { findByEpoch: async (e) => info(e) },
          validatorService: {
            getActiveVotePubkeys: async () => [VOTE_A],
            getIdentityMap: async () => new Map([[VOTE_A, identity]]),
            getActivatedStakeLamports: () => null,
          } as unknown as ValidatorService,
          statsRepo: {
            backfillMissingMedianFees: vi
              .fn()
              .mockResolvedValue({ epochsTouched: 0, rowsUpdated: 0 }),
            ensureSlotStatsRows: vi.fn(),
            rebuildIncomeTotalsFromProcessedBlocks: vi.fn().mockResolvedValue(0),
          },
          watchMode: 'explicit',
          explicitVotes: [VOTE_A],
          intervalMs: 30_000,
          batchSize: 1,
          finalityBuffer: 0,
        });
        return { job, historical };
      };
      let worker = makeWorker();
      const histories = [worker.historical];
      const signal = new AbortController().signal;
      await worker.job.tick(signal);
      expect(stats.rows.get(`499:${VOTE_A}`)?.identityPubkey).toBe(IDENTITY_A);
      expect(complete).toBe(false);
      identity = IDENTITY_B;
      epoch = 501;
      if (restart) {
        worker = makeWorker();
        histories.push(worker.historical);
      }
      for (let n = 0; n < 4; n++) await worker.job.tick(signal);
      expect(complete).toBe(false);
      expect(blocks.rows.has(0)).toBe(false);
      expect(blocks.rows.has(1)).toBe(true);
      expect(blocks.rows.has(2)).toBe(true);
      expect(blocks.rows.has(201)).toBe(true); // live polling follows new identity
      expect(stats.rows.get(`499:${VOTE_A}`)).toMatchObject({
        identityPubkey: IDENTITY_A,
        slotsAssigned: 3,
        slotsSkipped: 2,
      });
      expect(
        histories
          .flatMap((spy) => spy.mock.calls)
          .every(([args]) => args.epoch === 499 && args.identity === IDENTITY_A),
      ).toBe(true);
      available = true;
      await worker.job.tick(signal);
      expect(complete).toBe(true);
      expect(stats.rows.get(`499:${VOTE_A}`)).toMatchObject({
        identityPubkey: IDENTITY_A,
        slotsAssigned: 3,
        slotsSkipped: 3,
      });
      expect(watchedDynamicRepo.markBackfilled).toHaveBeenCalledTimes(1);
      expect(watchedDynamicRepo.markBackfilled).toHaveBeenCalledWith(VOTE_A, 499, IDENTITY_A);
      expect(blocks.rows.has(3)).toBe(false);
      expect(blocks.rows.has(4)).toBe(false);
      for (const slot of [1, 2])
        expect(getBlock.mock.calls.filter(([attempt]) => attempt === slot)).toHaveLength(1);
    },
  );
});
