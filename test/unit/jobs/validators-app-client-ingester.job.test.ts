import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ValidatorsAppClient,
  ValidatorsAppProjection,
} from '../../../src/clients/validators-app.js';
import { createValidatorsAppClientIngesterJob } from '../../../src/jobs/validators-app-client-ingester.job.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { IdentityPubkey, ValidatorClientUpsertInput } from '../../../src/types/domain.js';

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

  beforeEach(() => {
    appClient = new FakeValidatorsAppClient();
    validatorsRepo = new FakeValidatorsRepo();
  });

  function makeJob() {
    return createValidatorsAppClientIngesterJob({
      validatorsAppClient: appClient as unknown as ValidatorsAppClient,
      validatorsRepo: validatorsRepo as unknown as ValidatorsRepository,
      intervalMs: 6 * 60 * 60 * 1000,
      logger: silent,
    });
  }

  const ctrl = new AbortController();

  it('fetches + classifies on every tick (fixed 6 h cadence)', async () => {
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
  });

  it('runs again on the next tick without any cursor short-circuit', async () => {
    appClient.validators.set('IdRakurai', mkProjection('IdRakurai', 8, 'Rakurai', '2.1.0'));

    const job = makeJob();
    await job.tick(ctrl.signal);
    await job.tick(ctrl.signal);

    // No epoch / cursor gate — both ticks fetch + write.
    expect(appClient.callCount).toBe(2);
    expect(validatorsRepo.upsertCalls.length).toBe(2);
  });

  it('swallows fetch failures and retries next tick', async () => {
    appClient.throwOnNextCall = new Error('upstream 503');

    const job = makeJob();
    await job.tick(ctrl.signal);

    // First tick failed → no upsert. Service stays up; next tick is
    // a normal fetch.
    expect(validatorsRepo.upsertCalls.length).toBe(0);

    appClient.validators.set('IdAgave', mkProjection('IdAgave', 3, 'Agave', '4.0.0'));
    await job.tick(ctrl.signal);
    expect(validatorsRepo.upsertCalls.length).toBe(1);
  });

  it('degrades a row with no client info to "unknown" instead of dropping it', async () => {
    // The validator exists in validators.app's response but with
    // no client_id and no recognisable name — we still want to
    // overwrite any stale classification with `unknown` rather
    // than leaving the prior (possibly wrong) classification.
    appClient.validators.set('IdUnclassified', mkProjection('IdUnclassified', null, null, null));

    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(validatorsRepo.upsertCalls[0]?.[0]?.clientKind).toBe('unknown');
  });

  it('no-ops on an empty validators.app response', async () => {
    appClient.validators.clear();
    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(appClient.callCount).toBe(1);
    expect(validatorsRepo.upsertCalls.length).toBe(0);
  });
});
