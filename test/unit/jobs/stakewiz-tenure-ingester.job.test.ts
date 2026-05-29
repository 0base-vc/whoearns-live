import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StakewizClient, StakewizValidatorProjection } from '../../../src/clients/stakewiz.js';
import { createStakewizTenureIngesterJob } from '../../../src/jobs/stakewiz-tenure-ingester.job.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';

const silent = pino({ level: 'silent' });

class FakeStakewizClient {
  facts = new Map<string, StakewizValidatorProjection>();
  callCount = 0;
  throwOnNextCall: Error | null = null;

  async fetchValidatorFacts(): Promise<Map<string, StakewizValidatorProjection>> {
    this.callCount += 1;
    if (this.throwOnNextCall !== null) {
      const err = this.throwOnNextCall;
      this.throwOnNextCall = null;
      throw err;
    }
    return this.facts;
  }
}

class FakeValidatorsRepo {
  readonly genesisCalls: Array<Array<{ votePubkey: string; genesisEpoch: number }>> = [];
  readonly mevCalls: Array<
    Array<{ votePubkey: string; mevCommissionBps: number | null; runsJito: boolean }>
  > = [];

  async setGenesisEpochs(
    entries: ReadonlyArray<{ votePubkey: string; genesisEpoch: number }>,
  ): Promise<{ updated: number }> {
    this.genesisCalls.push([...entries]);
    return { updated: entries.length };
  }

  async setMevCommissions(
    entries: ReadonlyArray<{
      votePubkey: string;
      mevCommissionBps: number | null;
      runsJito: boolean;
    }>,
  ): Promise<{ updated: number }> {
    this.mevCalls.push([...entries]);
    return { updated: entries.length };
  }
}

function fact(
  voteIdentity: string,
  firstEpochWithStake: number | null,
  jitoCommissionBps: number | null,
  runsJito: boolean,
): StakewizValidatorProjection {
  return { voteIdentity, firstEpochWithStake, jitoCommissionBps, runsJito };
}

describe('stakewiz-tenure-ingester job', () => {
  let stakewizClient: FakeStakewizClient;
  let validatorsRepo: FakeValidatorsRepo;

  beforeEach(() => {
    stakewizClient = new FakeStakewizClient();
    validatorsRepo = new FakeValidatorsRepo();
  });

  function makeJob() {
    return createStakewizTenureIngesterJob({
      stakewizClient: stakewizClient as unknown as StakewizClient,
      validatorsRepo: validatorsRepo as unknown as ValidatorsRepository,
      intervalMs: 24 * 60 * 60 * 1000,
      logger: silent,
    });
  }

  const ctrl = new AbortController();

  it('writes genesis epochs AND MEV commissions from one fetch', async () => {
    stakewizClient.facts.set('VoteA', fact('VoteA', 82, 500, true));
    stakewizClient.facts.set('VoteB', fact('VoteB', 540, null, false));

    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(stakewizClient.callCount).toBe(1);
    expect(validatorsRepo.genesisCalls.length).toBe(1);
    expect(validatorsRepo.mevCalls.length).toBe(1);

    expect(validatorsRepo.genesisCalls[0]).toEqual([
      { votePubkey: 'VoteA', genesisEpoch: 82 },
      { votePubkey: 'VoteB', genesisEpoch: 540 },
    ]);
    // MEV entries carry every validator, preserving the (bps, runsJito)
    // pairing — including the non-Jito (null, false) row.
    expect(validatorsRepo.mevCalls[0]).toEqual([
      { votePubkey: 'VoteA', mevCommissionBps: 500, runsJito: true },
      { votePubkey: 'VoteB', mevCommissionBps: null, runsJito: false },
    ]);
  });

  it('excludes a null-tenure row from genesis but still writes its MEV facts', async () => {
    // Stakewiz couldn't date VoteC, but it does run Jito at 2.5% — the
    // tenure write skips it while the MEV write keeps it.
    stakewizClient.facts.set('VoteA', fact('VoteA', 100, 0, true));
    stakewizClient.facts.set('VoteC', fact('VoteC', null, 250, true));

    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(validatorsRepo.genesisCalls[0]).toEqual([{ votePubkey: 'VoteA', genesisEpoch: 100 }]);
    expect(validatorsRepo.mevCalls[0]).toEqual([
      { votePubkey: 'VoteA', mevCommissionBps: 0, runsJito: true },
      { votePubkey: 'VoteC', mevCommissionBps: 250, runsJito: true },
    ]);
  });

  it('no-ops on an empty stakewiz response (no setter calls)', async () => {
    stakewizClient.facts.clear();
    const job = makeJob();
    await job.tick(ctrl.signal);

    expect(stakewizClient.callCount).toBe(1);
    expect(validatorsRepo.genesisCalls.length).toBe(0);
    expect(validatorsRepo.mevCalls.length).toBe(0);
  });

  it('swallows fetch failures and retries next tick', async () => {
    stakewizClient.throwOnNextCall = new Error('upstream 503');

    const job = makeJob();
    await job.tick(ctrl.signal);
    // First tick failed → neither setter ran. Service stays up.
    expect(validatorsRepo.genesisCalls.length).toBe(0);
    expect(validatorsRepo.mevCalls.length).toBe(0);

    stakewizClient.facts.set('VoteA', fact('VoteA', 10, 800, true));
    await job.tick(ctrl.signal);
    expect(validatorsRepo.genesisCalls.length).toBe(1);
    expect(validatorsRepo.mevCalls.length).toBe(1);
  });
});
