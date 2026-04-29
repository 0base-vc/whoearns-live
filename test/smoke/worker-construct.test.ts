import { describe, it, expect } from 'vitest';
import { SolanaRpcClient } from '../../src/clients/solana-rpc.js';
import { EpochService } from '../../src/services/epoch.service.js';
import { FeeService } from '../../src/services/fee.service.js';
import { SlotService } from '../../src/services/slot.service.js';
import { ValidatorService } from '../../src/services/validator.service.js';
import { Scheduler } from '../../src/jobs/scheduler.js';
import { createEpochWatcherJob } from '../../src/jobs/epoch-watcher.job.js';
import { createFeeIngesterJob } from '../../src/jobs/fee-ingester.job.js';
import { createIncomeReconcilerJob } from '../../src/jobs/income-reconciler.job.js';
import { createSlotIngesterJob } from '../../src/jobs/slot-ingester.job.js';
import { pino } from 'pino';

import {
  FakeEpochsRepo,
  FakeProcessedBlocksRepo,
  FakeStatsRepo,
  FakeValidatorsRepo,
} from '../unit/services/_fakes.js';

/**
 * Verifies the worker's service+job graph constructs successfully without a
 * real database or RPC. Catches wiring breakage (missing deps, wrong signatures)
 * before it reaches production. Does NOT start the scheduler.
 */
describe('worker construction', () => {
  it('wires all services and jobs without throwing', () => {
    const logger = pino({ level: 'silent' });
    const validatorsRepo = new FakeValidatorsRepo();
    const epochsRepo = new FakeEpochsRepo();
    const statsRepo = new FakeStatsRepo();
    const processedBlocksRepo = new FakeProcessedBlocksRepo();

    const rpc = new SolanaRpcClient({
      url: 'https://solana-rpc.publicnode.com',
      timeoutMs: 1000,
      concurrency: 1,
      maxRetries: 0,
      logger,
    });
    const validatorService = new ValidatorService({
      validatorsRepo: validatorsRepo as unknown as ConstructorParameters<
        typeof ValidatorService
      >[0]['validatorsRepo'],
      rpc,
      logger,
    });
    const epochService = new EpochService({
      epochsRepo: epochsRepo as unknown as ConstructorParameters<
        typeof EpochService
      >[0]['epochsRepo'],
      rpc,
      logger,
    });
    const slotService = new SlotService({
      statsRepo: statsRepo as unknown as ConstructorParameters<typeof SlotService>[0]['statsRepo'],
      processedBlocksRepo: processedBlocksRepo as unknown as ConstructorParameters<
        typeof SlotService
      >[0]['processedBlocksRepo'],
      validatorsRepo: validatorsRepo as unknown as ConstructorParameters<
        typeof SlotService
      >[0]['validatorsRepo'],
      logger,
    });
    const feeService = new FeeService({
      rpc,
      statsRepo: statsRepo as unknown as ConstructorParameters<typeof FeeService>[0]['statsRepo'],
      processedBlocksRepo: processedBlocksRepo as unknown as ConstructorParameters<
        typeof FeeService
      >[0]['processedBlocksRepo'],
      logger,
    });
    const scheduler = new Scheduler({ logger });
    scheduler.register(
      createEpochWatcherJob({ epochService, validatorService, intervalMs: 30000, logger }),
    );
    scheduler.register(
      createSlotIngesterJob({
        epochService,
        validatorService,
        slotService,
        rpc,
        watchMode: 'explicit',
        explicitVotes: [],
        intervalMs: 60000,
        finalityBuffer: 32,
        logger,
      }),
    );
    scheduler.register(
      createFeeIngesterJob({
        epochService,
        validatorService,
        feeService,
        statsRepo: statsRepo as unknown as ConstructorParameters<typeof FeeService>[0]['statsRepo'],
        rpc,
        watchMode: 'explicit',
        explicitVotes: [],
        intervalMs: 30000,
        batchSize: 50,
        finalityBuffer: 32,
        logger,
      }),
    );
    scheduler.register(
      createIncomeReconcilerJob({
        epochService,
        epochsRepo,
        validatorService,
        feeService,
        statsRepo: statsRepo as unknown as Parameters<
          typeof createIncomeReconcilerJob
        >[0]['statsRepo'],
        rpc,
        watchMode: 'explicit',
        explicitVotes: [],
        intervalMs: 300000,
        batchSize: 50,
        logger,
      }),
    );
    expect(scheduler).toBeDefined();
  });
});
