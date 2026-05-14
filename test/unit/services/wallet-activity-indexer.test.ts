import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { RpcSignatureInfo } from '../../../src/clients/types.js';
import { WalletActivityIndexerService } from '../../../src/services/wallet-activity-indexer.service.js';
import type { WalletActivityRepository } from '../../../src/storage/repositories/wallet-activity.repo.js';
import { FakeWalletActivityRepo } from './_fakes.js';

const silent = pino({ level: 'silent' });

class FakeRpc {
  signatures: RpcSignatureInfo[] = [];
  throwOnNextCall: Error | null = null;
  async getSignaturesForAddress(): Promise<RpcSignatureInfo[]> {
    if (this.throwOnNextCall !== null) {
      const err = this.throwOnNextCall;
      this.throwOnNextCall = null;
      throw err;
    }
    return this.signatures;
  }
}

const WALLET = 'Wallet11111111111111111111111111111111111';

function mkSig(blockTime: number | null): RpcSignatureInfo {
  return {
    signature: 'sig' + Math.random().toString(36).slice(2, 10),
    slot: 0,
    blockTime,
    err: null,
  };
}

function utcEpochSec(year: number, month1Based: number, day: number, hour = 12): number {
  return Math.floor(Date.UTC(year, month1Based - 1, day, hour, 0, 0) / 1000);
}

describe('WalletActivityIndexerService.indexWallet', () => {
  let rpc: FakeRpc;
  let repo: FakeWalletActivityRepo;
  let svc: WalletActivityIndexerService;

  beforeEach(() => {
    rpc = new FakeRpc();
    repo = new FakeWalletActivityRepo();
    svc = new WalletActivityIndexerService({
      rpc: rpc as unknown as SolanaRpcClient,
      repo: repo as unknown as WalletActivityRepository,
      logger: silent,
    });
  });

  it('aggregates signatures into per-UTC-day tx counts', async () => {
    // Use times relative to TODAY so the 90-day window catches them.
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const today = Math.floor(now / 1000);
    const yesterday = Math.floor((now - oneDay) / 1000);
    rpc.signatures = [mkSig(today), mkSig(today), mkSig(today), mkSig(yesterday), mkSig(yesterday)];
    const result = await svc.indexWallet(WALLET);
    expect(result.signatures).toBe(5);
    expect(result.daysWritten).toBe(2);
    expect(repo.writes.length).toBe(1);
    const written = repo.writes[0]!;
    const countByDate = new Map(written.map((r) => [r.activityDate, r.txCount]));
    expect([...countByDate.values()].sort()).toEqual([2, 3]);
    // Fees are zero in the P4 release (deferred to a future pass).
    expect(written.every((r) => r.txFeesLamports === 0n)).toBe(true);
  });

  it('skips signatures with null blockTime', async () => {
    const today = Math.floor(Date.now() / 1000);
    rpc.signatures = [mkSig(today), mkSig(null), mkSig(today)];
    const result = await svc.indexWallet(WALLET);
    expect(result.signatures).toBe(3);
    expect(result.daysWritten).toBe(1);
    expect(repo.writes[0]![0]!.txCount).toBe(2);
  });

  it('skips signatures older than the 90-day window', async () => {
    const veryOld = utcEpochSec(2020, 1, 1); // ~6 years ago
    rpc.signatures = [mkSig(veryOld), mkSig(veryOld)];
    const result = await svc.indexWallet(WALLET);
    expect(result.signatures).toBe(2);
    expect(result.daysWritten).toBe(0);
    expect(repo.writes.length).toBe(0); // nothing to write
  });

  it('returns zero on empty upstream', async () => {
    rpc.signatures = [];
    const result = await svc.indexWallet(WALLET);
    expect(result.daysWritten).toBe(0);
    expect(result.signatures).toBe(0);
    expect(repo.writes.length).toBe(0);
  });

  it('swallows RPC failures and reports zero', async () => {
    rpc.throwOnNextCall = new Error('rpc down');
    const result = await svc.indexWallet(WALLET);
    expect(result.signatures).toBe(0);
    expect(result.daysWritten).toBe(0);
    expect(repo.writes.length).toBe(0);
  });
});
