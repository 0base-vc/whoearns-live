import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ValidatorsAppClient,
  ValidatorsAppProjection,
} from '../../../src/clients/validators-app.js';
import { createValidatorsAppClientIngesterJob } from '../../../src/jobs/validators-app-client-ingester.job.js';
import type { CursorsRepository } from '../../../src/storage/repositories/cursors.repo.js';
import type { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type {
  EpochInfo,
  IdentityPubkey,
  IngestionCursor,
  ValidatorClientUpsertInput,
} from '../../../src/types/domain.js';

const silent = pino({ level: 'silent' });

class FakeValidatorsAppClient {
  validators = new Map<string, ValidatorsAppProjection>();
  callCount = 0;
  throwOnNextCall: Error | null = null;

  async fetchValidatorClients(): Promise<Map<string, ValidatorsAppProjection>> {
    this.callCount += 1;
    if (this.throwOnNextCall !== null) {
      const err = this.throwOnNextCall;
      this.throwOnNextCall = null;
      throw err;
    }
    return this.validators;
  }
}

class FakeValidatorsRepo {
  readonly upsertCalls: ValidatorClientUpsertInput[][] = [];
  async upsertClientBatch(
    entries: ReadonlyArray<ValidatorClientUpsertInput>,
  ): Promise<{ updated: number; attempted: number }> {
    this.upsertCalls.push([...entries]);
    return { updated: entries.length, attempted: entries.length };
  }
}

class FakeEpochsRepo {
  current: EpochInfo | null = null;
  async findCurrent(): Promise<EpochInfo | null> {
    return this.current;
  }
}

class FakeCursorsRepo {
  readonly rows = new Map<string, IngestionCursor>();
  async get(jobName: string): Promise<IngestionCursor | null> {
    return this.rows.get(jobName) ?? null;
  }
  async upsert(c: Omit<IngestionCursor, 'updatedAt'>): Promise<void> {
    this.rows.set(c.jobName, { ...c, updatedAt: new Date() });
  }
}

function mkEpoch(epoch: number): EpochInfo {
  return {
    epoch,
    firstSlot: 0,
    lastSlot: 100,
    slotCount: 100,
    currentSlot: null,
    isClosed: false,
    observedAt: new Date(),
    closedAt: null,
  };
}

function mkProjection(
  identity: string,
  clientId: number | null,
  clientName: string | null,
  version: string | null,
): ValidatorsAppProjection {
  return {
    identityPubkey: identity,
    softwareClientId: clientId,
    softwareClientName: clientName,
    softwareVersion: version,
  };
}

describe('validators-app-client-ingester job', () => {
  let appClient: FakeValidatorsAppClient;
  let validatorsRepo: FakeValidatorsRepo;
  let epochsRepo: FakeEpochsRepo;
  let cursorsRepo: FakeCursorsRepo;

  beforeEach(() => {
    appClient = new FakeValidatorsAppClient();
    validatorsRepo = new FakeValidatorsRepo();
    epochsRepo = new FakeEpochsRepo();
    cursorsRepo = new FakeCursorsRepo();
  });

  function makeJob() {
    return createValidatorsAppClientIngesterJob({
      validatorsAppClient: appClient as unknown as ValidatorsAppClient,
      validatorsRepo: validatorsRepo as unknown as ValidatorsRepository,
      epochsRepo: epochsRepo as unknown as EpochsRepository,
      cursorsRepo: cursorsRepo as unknown as CursorsRepository,
      intervalMs: 600_000,
      logger: silent,
    });
  }

  const ctrl = new AbortController();

  it('runs the fetch + classification on the first tick (no cursor)', async () => {
    epochsRepo.current = mkEpoch(977);
    appClient.validators.set(
      'IdHarmonic',
      mkProjection('IdHarmonic', 11, 'HarmonicFrankendancer', '0.909.0-rc.40001'),
    );
    appClient.validators.set('IdAgaveBam', mkProjection('IdAgaveBam', 6, 'AgaveBam', '4.0.0'));

    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(appClient.callCount).toBe(1);
    expect(validatorsRepo.upsertCalls.length).toBe(1);
    const written = validatorsRepo.upsertCalls[0]!;
    const byIdentity = new Map(written.map((w) => [w.identityPubkey, w]));
    expect(byIdentity.get('IdHarmonic' as IdentityPubkey)?.clientKind).toBe(
      'harmonic_frankendancer',
    );
    expect(byIdentity.get('IdAgaveBam' as IdentityPubkey)?.clientKind).toBe('agave_bam');
    // Cursor is advanced to the current epoch — the next tick within
    // the same epoch will short-circuit on the `<=` check.
    const cursor = await cursorsRepo.get('validators-app-client-ingester');
    expect(cursor?.epoch).toBe(977);
  });

  it('short-circuits on subsequent ticks while the epoch is unchanged', async () => {
    epochsRepo.current = mkEpoch(977);
    await cursorsRepo.upsert({
      jobName: 'validators-app-client-ingester',
      epoch: 977,
      lastProcessedSlot: null,
      payload: null,
    });
    appClient.validators.set(
      'IdHarmonic',
      mkProjection('IdHarmonic', 11, 'HarmonicFrankendancer', '0.909.0-rc.40001'),
    );

    const job = makeJob();
    await job.tick(ctrl.signal);

    // The fetch never fires when the epoch hasn't advanced.
    expect(appClient.callCount).toBe(0);
    expect(validatorsRepo.upsertCalls.length).toBe(0);
  });

  it('re-runs the fetch on the next epoch transition', async () => {
    epochsRepo.current = mkEpoch(978); // epoch advanced from 977 → 978
    await cursorsRepo.upsert({
      jobName: 'validators-app-client-ingester',
      epoch: 977,
      lastProcessedSlot: null,
      payload: null,
    });
    appClient.validators.set('IdRakurai', mkProjection('IdRakurai', 8, 'Rakurai', '2.1.0'));

    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(appClient.callCount).toBe(1);
    expect(validatorsRepo.upsertCalls[0]?.[0]?.clientKind).toBe('rakurai');
    const cursor = await cursorsRepo.get('validators-app-client-ingester');
    expect(cursor?.epoch).toBe(978);
  });

  it('leaves the cursor untouched on a fetch failure (next tick retries)', async () => {
    epochsRepo.current = mkEpoch(977);
    appClient.throwOnNextCall = new Error('upstream 503');

    const job = makeJob();
    await job.tick(ctrl.signal);

    // No upsert, no cursor advance — next tick re-fires the same
    // logic (no `<=` short-circuit because the cursor stays null).
    expect(validatorsRepo.upsertCalls.length).toBe(0);
    expect(await cursorsRepo.get('validators-app-client-ingester')).toBeNull();
  });

  it('degrades a row with no client info to "unknown" instead of dropping it', async () => {
    epochsRepo.current = mkEpoch(977);
    // The validator exists in validators.app's response but with
    // no client_id and no recognisable name — we still want to
    // overwrite any stale classification with `unknown` rather
    // than leaving the prior (possibly wrong) classification.
    appClient.validators.set('IdUnclassified', mkProjection('IdUnclassified', null, null, null));

    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(validatorsRepo.upsertCalls[0]?.[0]?.clientKind).toBe('unknown');
  });

  it('does nothing when the epochs table has no current epoch yet', async () => {
    epochsRepo.current = null;

    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(appClient.callCount).toBe(0);
    expect(validatorsRepo.upsertCalls.length).toBe(0);
  });
});
