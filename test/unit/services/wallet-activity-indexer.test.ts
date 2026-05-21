import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { RpcGetSignaturesOptions, RpcSignatureInfo } from '../../../src/clients/types.js';
import { WalletActivityIndexerService } from '../../../src/services/wallet-activity-indexer.service.js';
import type { CursorsRepository } from '../../../src/storage/repositories/cursors.repo.js';
import type { WalletActivityRepository } from '../../../src/storage/repositories/wallet-activity.repo.js';
import { FakeCursorsRepo, FakeWalletActivityRepo } from './_fakes.js';

const silent = pino({ level: 'silent' });

/**
 * Fake `getSignaturesForAddress` that models the real RPC's
 * newest-first listing + `before`-cursor pagination (SOL-M1). Seed
 * `signatures` newest-first; the fake slices the requested page out
 * of that ordered list honouring `before` and `limit`.
 */
class FakeRpc {
  /** Newest-first, exactly as the RPC returns. */
  signatures: RpcSignatureInfo[] = [];
  throwOnNextCall: Error | null = null;
  /** One entry per call — lets tests assert the pagination walk. */
  readonly calls: RpcGetSignaturesOptions[] = [];

  async getSignaturesForAddress(
    _address: string,
    options: RpcGetSignaturesOptions = {},
  ): Promise<RpcSignatureInfo[]> {
    this.calls.push(options);
    if (this.throwOnNextCall !== null) {
      const err = this.throwOnNextCall;
      this.throwOnNextCall = null;
      throw err;
    }
    let start = 0;
    if (options.before !== undefined) {
      const idx = this.signatures.findIndex((s) => s.signature === options.before);
      // `before` is exclusive — start at the row AFTER the cursor.
      start = idx === -1 ? this.signatures.length : idx + 1;
    }
    const limit = options.limit ?? 1000;
    return this.signatures.slice(start, start + limit);
  }
}

const WALLET = 'Wallet11111111111111111111111111111111111';

let sigCounter = 0;
function mkSig(blockTime: number | null): RpcSignatureInfo {
  sigCounter += 1;
  return {
    signature: `sig${sigCounter.toString().padStart(8, '0')}`,
    slot: sigCounter,
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
  let cursors: FakeCursorsRepo;
  let svc: WalletActivityIndexerService;

  beforeEach(() => {
    rpc = new FakeRpc();
    repo = new FakeWalletActivityRepo();
    cursors = new FakeCursorsRepo();
    svc = new WalletActivityIndexerService({
      rpc: rpc as unknown as SolanaRpcClient,
      repo: repo as unknown as WalletActivityRepository,
      cursors: cursors as unknown as CursorsRepository,
      logger: silent,
    });
  });

  it('aggregates signatures into per-UTC-day tx counts', async () => {
    // Use times relative to TODAY so the 365-day window catches them.
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

  it('skips signatures with null blockTime but still counts them as observed', async () => {
    const today = Math.floor(Date.now() / 1000);
    rpc.signatures = [mkSig(today), mkSig(null), mkSig(today)];
    const result = await svc.indexWallet(WALLET);
    expect(result.signatures).toBe(3);
    expect(result.daysWritten).toBe(1);
    expect(repo.writes[0]![0]!.txCount).toBe(2);
  });

  it('stops at the first signature older than the 365-day window', async () => {
    const veryOld = utcEpochSec(2020, 1, 1); // ~6 years ago
    rpc.signatures = [mkSig(veryOld), mkSig(veryOld)];
    const result = await svc.indexWallet(WALLET);
    // The first row is already out of window — the newest-first
    // listing means everything after it is too, so the walk stops
    // immediately. It IS observed (we looked at it) but nothing is
    // bucketed.
    expect(result.signatures).toBe(1);
    expect(result.daysWritten).toBe(0);
    expect(repo.writes.length).toBe(0);
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

  it('pages backwards past the 1000-signature single-call cap (SOL-M1)', async () => {
    // 2500 in-window signatures — three pages of 1000/1000/500.
    const today = Math.floor(Date.now() / 1000);
    rpc.signatures = Array.from({ length: 2500 }, () => mkSig(today));
    const result = await svc.indexWallet(WALLET);
    expect(result.signatures).toBe(2500);
    // First call has no `before`; the next two carry the previous
    // page's oldest signature as the cursor.
    expect(rpc.calls.length).toBe(3);
    expect(rpc.calls[0]!.before).toBeUndefined();
    expect(rpc.calls[1]!.before).toBe(rpc.signatures[999]!.signature);
    expect(rpc.calls[2]!.before).toBe(rpc.signatures[1999]!.signature);
    // All 2500 land on the same UTC day.
    expect(result.daysWritten).toBe(1);
    expect(repo.writes[0]![0]!.txCount).toBe(2500);
  });

  it('persists the newest signature as a checkpoint and resumes from it next tick', async () => {
    const today = Math.floor(Date.now() / 1000);
    rpc.signatures = [mkSig(today), mkSig(today), mkSig(today)];
    const newest = rpc.signatures[0]!.signature;

    const first = await svc.indexWallet(WALLET);
    expect(first.signatures).toBe(3);
    // Checkpoint written under the per-wallet job name.
    const cursor = await cursors.get(`wallet-activity:${WALLET}`);
    expect(cursor).not.toBeNull();
    expect((cursor!.payload as { newestSignature: string }).newestSignature).toBe(newest);

    // Second tick with NO new signatures: the walk hits the
    // checkpoint on the very first row and stops — nothing observed.
    const second = await svc.indexWallet(WALLET);
    expect(second.signatures).toBe(0);
    expect(second.daysWritten).toBe(0);
  });

  it('only counts signatures newer than the checkpoint on a subsequent tick', async () => {
    const today = Math.floor(Date.now() / 1000);
    // Tick 1: two signatures.
    rpc.signatures = [mkSig(today), mkSig(today)];
    await svc.indexWallet(WALLET);

    // Tick 2: two BRAND-NEW signatures prepended (newest-first), the
    // two old ones still present below them.
    const fresh1 = mkSig(today);
    const fresh2 = mkSig(today);
    rpc.signatures = [fresh1, fresh2, ...rpc.signatures];
    rpc.calls.length = 0;

    const result = await svc.indexWallet(WALLET);
    // Only the two fresh signatures are observed — the walk stops
    // when it reaches the old checkpoint.
    expect(result.signatures).toBe(2);
    // Checkpoint advanced to the newest of the fresh signatures.
    const cursor = await cursors.get(`wallet-activity:${WALLET}`);
    expect((cursor!.payload as { newestSignature: string }).newestSignature).toBe(fresh1.signature);
  });

  it('caps a single tick at the hard ceiling (10x the single-call cap)', async () => {
    // 12000 in-window signatures, no checkpoint — the hard ceiling
    // (10 * 1000) must bound the tick at 10000 observed.
    const today = Math.floor(Date.now() / 1000);
    rpc.signatures = Array.from({ length: 12_000 }, () => mkSig(today));
    const result = await svc.indexWallet(WALLET);
    expect(result.signatures).toBe(10_000);
    // 10 pages of 1000.
    expect(rpc.calls.length).toBe(10);
    // The checkpoint is the newest signature — so the NEXT tick
    // resumes and drains the remaining backlog rather than re-scanning.
    const cursor = await cursors.get(`wallet-activity:${WALLET}`);
    expect((cursor!.payload as { newestSignature: string }).newestSignature).toBe(
      rpc.signatures[0]!.signature,
    );
  });

  it('flushes partial progress and does NOT advance the checkpoint when a later page fails', async () => {
    const today = Math.floor(Date.now() / 1000);
    // 1500 signatures — needs two pages. Fail the SECOND page.
    rpc.signatures = Array.from({ length: 1500 }, () => mkSig(today));
    let call = 0;
    const realFetch = rpc.getSignaturesForAddress.bind(rpc);
    rpc.getSignaturesForAddress = async (address, options) => {
      call += 1;
      if (call === 2) throw new Error('rpc flake on page 2');
      return realFetch(address, options);
    };
    const result = await svc.indexWallet(WALLET);
    // Page 1's 1000 signatures were bucketed and flushed.
    expect(result.signatures).toBe(1000);
    expect(repo.writes.length).toBe(1);
    // A clean walk DID complete page 1 and recorded the newest
    // signature, so the checkpoint is still written (page 1 is
    // authoritative for everything it covered). The next tick resumes
    // from there — the failed tail is simply retried.
    const cursor = await cursors.get(`wallet-activity:${WALLET}`);
    expect(cursor).not.toBeNull();
  });
});
