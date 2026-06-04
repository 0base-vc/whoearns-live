import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createValidatorInfoBulkIngesterJob } from '../../../src/jobs/validator-info-bulk-ingester.job.js';
import type { ValidatorService } from '../../../src/services/validator.service.js';

const silent = pino({ level: 'silent' });

describe('validator-info-bulk-ingester job', () => {
  const ctrl = new AbortController();

  function makeJob(refreshAllValidatorInfo: ValidatorService['refreshAllValidatorInfo']) {
    return createValidatorInfoBulkIngesterJob({
      validatorService: { refreshAllValidatorInfo } as Pick<
        ValidatorService,
        'refreshAllValidatorInfo'
      >,
      intervalMs: 6 * 60 * 60 * 1000,
      logger: silent,
    });
  }

  it('delegates the cluster-wide refresh on every tick (no cursor short-circuit)', async () => {
    const refresh = vi.fn().mockResolvedValue({ observed: 2000, updated: 3 });
    const job = makeJob(refresh);

    await job.tick(ctrl.signal);
    await job.tick(ctrl.signal);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('swallows RPC failures and retries on the next tick', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc 503'))
      .mockResolvedValueOnce({ observed: 1, updated: 1 });
    const job = makeJob(refresh);

    // A failing tick must not throw out of the scheduler loop.
    await expect(job.tick(ctrl.signal)).resolves.toBeUndefined();
    await job.tick(ctrl.signal);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('no-ops cleanly when nothing drifted (updated = 0)', async () => {
    const refresh = vi.fn().mockResolvedValue({ observed: 2000, updated: 0 });
    const job = makeJob(refresh);

    await expect(job.tick(ctrl.signal)).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
