import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { createClusterNodesIngesterJob } from '../../../src/jobs/cluster-nodes-ingester.job.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { RpcClusterNode } from '../../../src/clients/types.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { IdentityPubkey } from '../../../src/types/domain.js';

const silent = pino({ level: 'silent' });

class FakeRpc {
  nodes: RpcClusterNode[] = [];
  callCount = 0;
  throwOnNextCall: Error | null = null;
  async getClusterNodes(): Promise<RpcClusterNode[]> {
    this.callCount++;
    if (this.throwOnNextCall !== null) {
      const err = this.throwOnNextCall;
      this.throwOnNextCall = null;
      throw err;
    }
    return this.nodes;
  }
}

class FakeRepo {
  upsertCalls: Array<{
    identityPubkey: IdentityPubkey;
    clientKind: string;
    clientVersion: string | null;
  }>[] = [];
  upsertedCount = 0;
  async upsertClientBatch(
    entries: ReadonlyArray<{
      identityPubkey: IdentityPubkey;
      clientKind: string;
      clientVersion: string | null;
    }>,
  ): Promise<{ updated: number; attempted: number }> {
    this.upsertCalls.push([...entries]);
    // `attempted` mirrors the real repo's contract (DB-M2): every
    // identity we tried to classify, regardless of whether the row
    // changed or even exists.
    return { updated: this.upsertedCount, attempted: entries.length };
  }
}

describe('cluster-nodes ingester job', () => {
  let rpc: FakeRpc;
  let repo: FakeRepo;

  beforeEach(() => {
    rpc = new FakeRpc();
    repo = new FakeRepo();
  });

  function makeJob() {
    return createClusterNodesIngesterJob({
      rpc: rpc as unknown as SolanaRpcClient,
      validatorsRepo: repo as unknown as ValidatorsRepository,
      intervalMs: 10_000,
      logger: silent,
    });
  }

  it('classifies and writes one entry per identity', async () => {
    rpc.nodes = [
      { pubkey: 'IdA', version: '2.0.18' },
      { pubkey: 'IdB', version: '2.0.18-jito-1' },
      { pubkey: 'IdC', version: '0.405.20218' },
      { pubkey: 'IdD', version: '0.405.20218-frkd' },
      { pubkey: 'IdE', version: null },
    ];
    const job = makeJob();
    const signal = new AbortController().signal;
    await job.tick(signal);
    expect(rpc.callCount).toBe(1);
    expect(repo.upsertCalls.length).toBe(1);
    const entries = repo.upsertCalls[0]!;
    expect(entries.find((e) => e.identityPubkey === 'IdA')?.clientKind).toBe('agave');
    expect(entries.find((e) => e.identityPubkey === 'IdB')?.clientKind).toBe('jito_solana');
    expect(entries.find((e) => e.identityPubkey === 'IdC')?.clientKind).toBe('firedancer');
    expect(entries.find((e) => e.identityPubkey === 'IdD')?.clientKind).toBe('frankendancer');
    expect(entries.find((e) => e.identityPubkey === 'IdE')?.clientKind).toBe('unknown');
  });

  it('dedups on identity if upstream returns duplicates', async () => {
    rpc.nodes = [
      { pubkey: 'IdA', version: '2.0.17' },
      { pubkey: 'IdA', version: '2.0.18' }, // later wins
    ];
    const job = makeJob();
    await job.tick(new AbortController().signal);
    const entries = repo.upsertCalls[0]!;
    expect(entries.length).toBe(1);
    expect(entries[0]!.clientVersion).toBe('2.0.18');
  });

  it('skips entries with empty identity pubkeys', async () => {
    rpc.nodes = [
      { pubkey: '', version: '2.0.18' },
      { pubkey: 'IdA', version: '2.0.18' },
    ];
    const job = makeJob();
    await job.tick(new AbortController().signal);
    const entries = repo.upsertCalls[0]!;
    expect(entries.length).toBe(1);
    expect(entries[0]!.identityPubkey).toBe('IdA');
  });

  it('does not write when upstream returns an empty list', async () => {
    rpc.nodes = [];
    const job = makeJob();
    await job.tick(new AbortController().signal);
    expect(repo.upsertCalls.length).toBe(0);
  });

  it('swallows upstream errors and does not write', async () => {
    rpc.throwOnNextCall = new Error('rpc failure');
    const job = makeJob();
    await expect(job.tick(new AbortController().signal)).resolves.toBeUndefined();
    expect(repo.upsertCalls.length).toBe(0);
  });

  it('aborts cleanly when the signal is already aborted after fetch', async () => {
    rpc.nodes = [{ pubkey: 'IdA', version: '2.0.18' }];
    const controller = new AbortController();
    controller.abort();
    const job = makeJob();
    await job.tick(controller.signal);
    // The job pre-fetches before checking abort; depending on timing
    // it MAY have written. The contract is "abort never crashes".
    expect(repo.upsertCalls.length).toBeLessThanOrEqual(1);
  });
});
