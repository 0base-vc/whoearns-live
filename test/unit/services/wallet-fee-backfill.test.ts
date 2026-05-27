import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { RpcGetSignaturesOptions, RpcSignatureInfo } from '../../../src/clients/types.js';
import { WalletFeeBackfillService } from '../../../src/services/wallet-fee-backfill.service.js';
import type { CursorsRepository } from '../../../src/storage/repositories/cursors.repo.js';
import type { WalletActivityRepository } from '../../../src/storage/repositories/wallet-activity.repo.js';
import { FakeCursorsRepo, FakeWalletActivityRepo } from './_fakes.js';

const silent = pino({ level: 'silent' });

/**
 * Fake archive RPC modelling the two methods the backfill service
 * touches: newest-first `getSignaturesForAddress` (same shape as the
 * indexer's fake, copied so the two service tests stay independent)
 * + per-signature `getTransactionFee`. Seed `feesBySignature` with
 * `null` for the "RPC missed / malformed meta" path the service must
 * tolerate without locking the checkpoint.
 */
class FakeArchiveRpc {
  signatures: RpcSignatureInfo[] = [];
  feesBySignature = new Map<string, bigint | null>();
  /** Per-call options for `getSignaturesForAddress`. */
  readonly sigCalls: RpcGetSignaturesOptions[] = [];
  /** Per-call signature for `getTransactionFee`. */
  readonly feeCalls: string[] = [];
  /** When non-null, the NEXT getSignaturesForAddress call throws. */
  throwOnNextSigCall: Error | null = null;
  /** When non-null, the NEXT getTransactionFee call throws. */
  throwOnNextFeeCall: Error | null = null;

  async getSignaturesForAddress(
    _address: string,
    options: RpcGetSignaturesOptions = {},
  ): Promise<RpcSignatureInfo[]> {
    this.sigCalls.push(options);
    if (this.throwOnNextSigCall !== null) {
      const err = this.throwOnNextSigCall;
      this.throwOnNextSigCall = null;
      throw err;
    }
    let start = 0;
    if (options.before !== undefined) {
      const idx = this.signatures.findIndex((s) => s.signature === options.before);
      start = idx === -1 ? this.signatures.length : idx + 1;
    }
    const limit = options.limit ?? 1000;
    return this.signatures.slice(start, start + limit);
  }

  async getTransactionFee(signature: string): Promise<bigint | null> {
    this.feeCalls.push(signature);
    if (this.throwOnNextFeeCall !== null) {
      const err = this.throwOnNextFeeCall;
      this.throwOnNextFeeCall = null;
      throw err;
    }
    return this.feesBySignature.get(signature) ?? null;
  }
}

const WALLET = 'Wallet22222222222222222222222222222222222';

let sigCounter = 0;
function mkSig(blockTime: number | null): RpcSignatureInfo {
  sigCounter += 1;
  return {
    signature: `feesig${sigCounter.toString().padStart(8, '0')}`,
    slot: sigCounter,
    blockTime,
    err: null,
  };
}

describe('WalletFeeBackfillService.backfillWallet', () => {
  let rpc: FakeArchiveRpc;
  let repo: FakeWalletActivityRepo;
  let cursors: FakeCursorsRepo;
  let svc: WalletFeeBackfillService;

  beforeEach(() => {
    rpc = new FakeArchiveRpc();
    repo = new FakeWalletActivityRepo();
    cursors = new FakeCursorsRepo();
    svc = new WalletFeeBackfillService(
      {
        archiveRpc: rpc as unknown as SolanaRpcClient,
        repo: repo as unknown as WalletActivityRepository,
        cursors: cursors as unknown as CursorsRepository,
        logger: silent,
      },
      // Generous per-tick limit so the basic-case tests never trip
      // the ceiling unexpectedly. Ceiling behaviour is exercised in
      // its own block below.
      { maxFeeFetchesPerTick: 1000 },
    );
  });

  it('aggregates per-signature fees into per-UTC-day totals', async () => {
    // Stable timestamps within the 365-day window — relative-to-now
    // so the cutoff doesn't trim them.
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const today = Math.floor(now / 1000);
    const yesterday = Math.floor((now - oneDay) / 1000);
    const a = mkSig(today);
    const b = mkSig(today);
    const c = mkSig(today);
    const d = mkSig(yesterday);
    const e = mkSig(yesterday);
    rpc.signatures = [a, b, c, d, e];
    rpc.feesBySignature.set(a.signature, 5_000n);
    rpc.feesBySignature.set(b.signature, 7_500n);
    rpc.feesBySignature.set(c.signature, 12_500n);
    rpc.feesBySignature.set(d.signature, 5_000n);
    rpc.feesBySignature.set(e.signature, 5_000n);

    const result = await svc.backfillWallet(WALLET);

    expect(result.signatures).toBe(5);
    expect(result.fetched).toBe(5);
    expect(result.daysWritten).toBe(2);

    expect(repo.feeWrites.length).toBe(1);
    const written = repo.feeWrites[0]!;
    const feeByDate = new Map(written.map((r) => [r.activityDate, r.txFeesLamports]));
    const sorted = [...feeByDate.values()].sort((x, y) => Number(x - y));
    expect(sorted).toEqual([10_000n, 25_000n]);
    // And the per-day tx count came along for the INSERT path.
    const countByDate = new Map(written.map((r) => [r.activityDate, r.txCount]));
    expect([...countByDate.values()].sort()).toEqual([2, 3]);
  });

  it('skips signatures whose getTransactionFee returns null', async () => {
    const now = Math.floor(Date.now() / 1000);
    const good1 = mkSig(now);
    const missed = mkSig(now);
    const good2 = mkSig(now);
    rpc.signatures = [good1, missed, good2];
    rpc.feesBySignature.set(good1.signature, 5_000n);
    rpc.feesBySignature.set(missed.signature, null);
    rpc.feesBySignature.set(good2.signature, 7_000n);

    const result = await svc.backfillWallet(WALLET);

    // All three sigs were observed and we issued a fee fetch for each.
    expect(result.signatures).toBe(3);
    expect(result.fetched).toBe(3);
    // Only the two non-null returns contribute to the daily sum.
    expect(repo.feeWrites[0]!.length).toBe(1);
    expect(repo.feeWrites[0]![0]!.txFeesLamports).toBe(12_000n);
    // Tx count reflects the sigs that produced fees — `missed` was
    // not bucketed because the fee couldn't be added to a per-day
    // sum. Next tick will retry it via the cleanExit checkpoint
    // logic (which only advances past sigs we've seen).
    expect(repo.feeWrites[0]![0]!.txCount).toBe(2);
  });

  it('stops at the existing checkpoint on subsequent ticks (newest-first)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const newest = mkSig(now);
    const middle = mkSig(now);
    const oldest = mkSig(now);
    rpc.signatures = [newest, middle, oldest];
    for (const s of rpc.signatures) {
      rpc.feesBySignature.set(s.signature, 5_000n);
    }

    // Pre-seed the checkpoint at `middle` so only `newest` is in scope.
    await cursors.upsert({
      jobName: `wallet-fee-backfill:${WALLET}`,
      epoch: null,
      lastProcessedSlot: null,
      payload: { newestFeeFilled: middle.signature, backfillFrontier: null },
    });

    const result = await svc.backfillWallet(WALLET);

    // Only one sig should be fetched — the walk stops at `middle`.
    expect(result.fetched).toBe(1);
    expect(repo.feeWrites[0]![0]!.txFeesLamports).toBe(5_000n);
    // Checkpoint advances to the new newest sig (clean exit).
    const after = await cursors.get(`wallet-fee-backfill:${WALLET}`);
    expect(after?.payload?.['newestFeeFilled']).toBe(newest.signature);
    expect(after?.payload?.['backfillFrontier']).toBeNull();
  });

  it('saves a backfill frontier when the per-tick ceiling is hit (dirty exit)', async () => {
    const ceiling = 2;
    svc = new WalletFeeBackfillService(
      {
        archiveRpc: rpc as unknown as SolanaRpcClient,
        repo: repo as unknown as WalletActivityRepository,
        cursors: cursors as unknown as CursorsRepository,
        logger: silent,
      },
      { maxFeeFetchesPerTick: ceiling },
    );
    const now = Math.floor(Date.now() / 1000);
    const s1 = mkSig(now);
    const s2 = mkSig(now);
    const s3 = mkSig(now); // ceiling cuts off before this one
    rpc.signatures = [s1, s2, s3];
    for (const s of rpc.signatures) {
      rpc.feesBySignature.set(s.signature, 5_000n);
    }

    const result = await svc.backfillWallet(WALLET);

    expect(result.fetched).toBe(ceiling);
    const after = await cursors.get(`wallet-fee-backfill:${WALLET}`);
    // newestFeeFilled CAN advance — we saw `s1` cleanly during the
    // newest-first walk (the page-1-top row). The frontier holds
    // the oldest sig the dirty tick visited, so the next tick
    // resumes paginating from there in BACKFILL mode (older).
    expect(after?.payload?.['newestFeeFilled']).toBe(s1.signature);
    expect(after?.payload?.['backfillFrontier']).toBe(s2.signature);
  });

  it('drains the backfill frontier on a clean follow-up tick', async () => {
    const now = Math.floor(Date.now() / 1000);
    const s1 = mkSig(now);
    const s2 = mkSig(now);
    const s3 = mkSig(now);
    rpc.signatures = [s1, s2, s3];
    for (const s of rpc.signatures) {
      rpc.feesBySignature.set(s.signature, 5_000n);
    }
    // Pre-seed the cursor as if a previous tick hit the ceiling.
    await cursors.upsert({
      jobName: `wallet-fee-backfill:${WALLET}`,
      epoch: null,
      lastProcessedSlot: null,
      payload: { newestFeeFilled: s1.signature, backfillFrontier: s2.signature },
    });

    const result = await svc.backfillWallet(WALLET);

    // Backfill mode: starts AFTER s2 (the saved frontier). Sees s3.
    // Empty page after that → clean exit, frontier cleared.
    expect(result.fetched).toBe(1);
    expect(rpc.feeCalls).toEqual([s3.signature]);
    const after = await cursors.get(`wallet-fee-backfill:${WALLET}`);
    expect(after?.payload?.['newestFeeFilled']).toBe(s1.signature); // unchanged in backfill mode
    expect(after?.payload?.['backfillFrontier']).toBeNull();
  });

  it('stops walking when blockTime crosses the 365-day cutoff', async () => {
    // Two recent sigs followed by one stale (>365 days ago). The
    // service must stop at the stale row WITHOUT issuing a fee
    // fetch for it (and without bucketing it into a day).
    const now = Math.floor(Date.now() / 1000);
    const stale = Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60;
    const recent1 = mkSig(now);
    const recent2 = mkSig(now);
    const old = mkSig(stale);
    rpc.signatures = [recent1, recent2, old];
    rpc.feesBySignature.set(recent1.signature, 5_000n);
    rpc.feesBySignature.set(recent2.signature, 5_000n);
    // No fee entry for `old` — if the cutoff check is broken the
    // test fetches it and the missing entry returns null, but
    // we'd still observe the call in `feeCalls`.

    await svc.backfillWallet(WALLET);

    expect(rpc.feeCalls).toEqual([recent1.signature, recent2.signature]);
    // Clean exit on cutoff → newest advances, no frontier.
    const after = await cursors.get(`wallet-fee-backfill:${WALLET}`);
    expect(after?.payload?.['newestFeeFilled']).toBe(recent1.signature);
    expect(after?.payload?.['backfillFrontier']).toBeNull();
  });

  it('treats getSignaturesForAddress failure as a dirty exit (no checkpoint advance)', async () => {
    rpc.throwOnNextSigCall = new Error('RPC fault');

    const result = await svc.backfillWallet(WALLET);

    expect(result.fetched).toBe(0);
    // No checkpoint write or fees upserted on a fault before any
    // sigs were observed — service degrades gracefully.
    expect(repo.feeWrites.length).toBe(0);
  });

  it('persists a 0n txFeesLamports row for nothing — empty walk is a no-op', async () => {
    rpc.signatures = []; // wallet has no history
    const result = await svc.backfillWallet(WALLET);
    expect(result.signatures).toBe(0);
    expect(result.fetched).toBe(0);
    expect(result.daysWritten).toBe(0);
    expect(repo.feeWrites.length).toBe(0);
  });
});
