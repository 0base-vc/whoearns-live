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

  it('propagates RPC failures so the scheduler records outcome=fail', async () => {
    // Previously this job self-caught its throws and returned normally,
    // which made the scheduler count every failure as `outcome=success`
    // — a permanently-failing tick read as healthy in Prometheus. The
    // contract is now: throw out, let `Scheduler.runLoop`'s outer catch
    // log at `error` and increment `jobs_executed_total{outcome="fail"}`.
    const refresh = vi.fn().mockRejectedValue(new Error('rpc 503'));
    const job = makeJob(refresh);
    await expect(job.tick(ctrl.signal)).rejects.toThrow('rpc 503');
  });

  it('skips the heavy refresh when the signal is already aborted', async () => {
    // Early-abort guard — no `getConfigProgramAccounts` (~3 MB) or
    // batch UPDATE should fire if the scheduler is shutting down.
    const refresh = vi.fn().mockResolvedValue({ observed: 0, updated: 0 });
    const job = makeJob(refresh);
    const aborted = new AbortController();
    aborted.abort();

    await expect(job.tick(aborted.signal)).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('no-ops cleanly when nothing drifted (updated = 0)', async () => {
    const refresh = vi.fn().mockResolvedValue({ observed: 2000, updated: 0 });
    const job = makeJob(refresh);

    await expect(job.tick(ctrl.signal)).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
