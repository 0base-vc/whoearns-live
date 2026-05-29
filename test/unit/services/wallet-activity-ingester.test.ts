import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { RpcGetSignaturesOptions, RpcSignatureInfo } from '../../../src/clients/types.js';
import { WalletActivityIngesterService } from '../../../src/services/wallet-activity-ingester.service.js';
import type { CursorsRepository } from '../../../src/storage/repositories/cursors.repo.js';
import type { WalletActivityRepository } from '../../../src/storage/repositories/wallet-activity.repo.js';
import { FakeCursorsRepo, FakeWalletActivityRepo } from './_fakes.js';

const silent = pino({ level: 'silent' });

/**
 * Fake RPC with both `getSignaturesForAddress` + `getTransactionFeeAndPayer`.
 * Per-sig fee + payer are configured via `feeAndPayerBySig`. A sig
 * without a configured entry resolves to `null` (the RPC-missed
 * path). Per-call sig list + fee+payer call args are recorded for
 * assertions.
 */
class FakeRpc {
  /** Newest-first listing. */
  signatures: RpcSignatureInfo[] = [];
  /** `null` value = simulate "RPC missed". */
  feeAndPayerBySig = new Map<string, { fee: bigint; feePayer: string } | null>();
  readonly sigCalls: RpcGetSignaturesOptions[] = [];
  readonly feeCalls: string[] = [];
  throwOnNextSigCall: Error | null = null;
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

  async getTransactionFeeAndPayer(
    signature: string,
  ): Promise<{ fee: bigint; feePayer: string } | null> {
    this.feeCalls.push(signature);
    if (this.throwOnNextFeeCall !== null) {
      const err = this.throwOnNextFeeCall;
      this.throwOnNextFeeCall = null;
      throw err;
    }
    return this.feeAndPayerBySig.get(signature) ?? null;
  }
}

const WALLET = 'WalletA1111111111111111111111111111111111';
const OTHER = 'WalletB2222222222222222222222222222222222';

let sigCounter = 0;
function mkSig(blockTime: number | null): RpcSignatureInfo {
  sigCounter += 1;
  return {
    signature: `sig${sigCounter.toString().padStart(10, '0')}`,
    slot: sigCounter,
    blockTime,
    err: null,
  };
}

describe('WalletActivityIngesterService.ingestWallet', () => {
  let rpc: FakeRpc;
  let repo: FakeWalletActivityRepo;
  let cursors: FakeCursorsRepo;
  let svc: WalletActivityIngesterService;

  beforeEach(() => {
    rpc = new FakeRpc();
    repo = new FakeWalletActivityRepo();
    cursors = new FakeCursorsRepo();
    svc = new WalletActivityIngesterService(
      {
        primaryRpc: rpc as unknown as SolanaRpcClient,
        archiveRpc: rpc as unknown as SolanaRpcClient,
        repo: repo as unknown as WalletActivityRepository,
        cursors: cursors as unknown as CursorsRepository,
        logger: silent,
      },
      { maxFeeFetchesPerTick: 1000 },
    );
  });

  it('outgoing-only: counts sigs the wallet paid for, skips incoming/reference', async () => {
    // 5 sigs total: 3 outgoing (wallet is fee payer), 2 incoming
    // (someone else is fee payer). Only the 3 outgoing contribute
    // to tx_count + fee.
    const now = Math.floor(Date.now() / 1000);
    const out1 = mkSig(now);
    const out2 = mkSig(now);
    const incoming1 = mkSig(now);
    const out3 = mkSig(now);
    const incoming2 = mkSig(now);
    rpc.signatures = [out1, out2, incoming1, out3, incoming2];
    rpc.feeAndPayerBySig.set(out1.signature, { fee: 5_000n, feePayer: WALLET });
    rpc.feeAndPayerBySig.set(out2.signature, { fee: 7_500n, feePayer: WALLET });
    rpc.feeAndPayerBySig.set(incoming1.signature, { fee: 5_000n, feePayer: OTHER });
    rpc.feeAndPayerBySig.set(out3.signature, { fee: 12_500n, feePayer: WALLET });
    rpc.feeAndPayerBySig.set(incoming2.signature, { fee: 5_000n, feePayer: OTHER });

    const result = await svc.ingestWallet(WALLET);

    expect(result.signatures).toBe(5);
    expect(result.outgoing).toBe(3);
    expect(result.fetched).toBe(5); // we fetched fee+payer for all 5 to know which to skip
    expect(result.daysWritten).toBe(1);
    const written = repo.writes[0]!;
    expect(written.length).toBe(1);
    // Only the 3 outgoing fees sum + the 3-tx count.
    expect(written[0]!.txCount).toBe(3);
    expect(written[0]!.txFeesLamports).toBe(5_000n + 7_500n + 12_500n);
  });

  it('writes ZERO rows when every sig is incoming', async () => {
    const now = Math.floor(Date.now() / 1000);
    const s1 = mkSig(now);
    const s2 = mkSig(now);
    rpc.signatures = [s1, s2];
    rpc.feeAndPayerBySig.set(s1.signature, { fee: 5_000n, feePayer: OTHER });
    rpc.feeAndPayerBySig.set(s2.signature, { fee: 5_000n, feePayer: OTHER });

    const result = await svc.ingestWallet(WALLET);

    expect(result.signatures).toBe(2);
    expect(result.outgoing).toBe(0);
    expect(repo.writes.length).toBe(0); // upsert never called with empty bucket
  });

  it('aggregates per-UTC-day for multiple outgoing sigs', async () => {
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
    for (const s of rpc.signatures) {
      rpc.feeAndPayerBySig.set(s.signature, { fee: 5_000n, feePayer: WALLET });
    }

    const result = await svc.ingestWallet(WALLET);

    expect(result.signatures).toBe(5);
    expect(result.outgoing).toBe(5);
    expect(result.daysWritten).toBe(2);
    const written = repo.writes[0]!;
    const byDate = new Map(written.map((r) => [r.activityDate, r]));
    expect([...byDate.values()].map((r) => r.txCount).sort()).toEqual([2, 3]);
    expect([...byDate.values()].map((r) => r.txFeesLamports).sort()).toEqual([10_000n, 15_000n]);
  });

  it('null-fee/RPC-throw treated as miss → frontier seeded for retry', async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = mkSig(now);
    const missed = mkSig(now);
    rpc.signatures = [good, missed];
    rpc.feeAndPayerBySig.set(good.signature, { fee: 5_000n, feePayer: WALLET });
    rpc.feeAndPayerBySig.set(missed.signature, null); // RPC missed

    await svc.ingestWallet(WALLET);

    const after = await cursors.get(`wallet-activity:${WALLET}`);
    expect(after?.payload?.['newestSignature']).toBe(good.signature);
    expect(after?.payload?.['backfillFrontier']).toBe(missed.signature);
  });

  it('checkpoint short-circuits on newest-match (no work + log debug)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const s1 = mkSig(now);
    rpc.signatures = [s1];
    rpc.feeAndPayerBySig.set(s1.signature, { fee: 5_000n, feePayer: WALLET });
    // Pre-seed checkpoint at s1 → walk visits s1, matches, exits.
    await cursors.upsert({
      jobName: `wallet-activity:${WALLET}`,
      epoch: null,
      lastProcessedSlot: null,
      payload: { newestSignature: s1.signature, backfillFrontier: null },
    });

    const result = await svc.ingestWallet(WALLET);

    expect(result.fetched).toBe(0); // no fee call — short-circuit before it
    expect(repo.writes.length).toBe(0);
  });

  it('per-tick ceiling truncates the walk (dirty exit + frontier)', async () => {
    const ceiling = 2;
    svc = new WalletActivityIngesterService(
      {
        primaryRpc: rpc as unknown as SolanaRpcClient,
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
    const s3 = mkSig(now);
    rpc.signatures = [s1, s2, s3];
    for (const s of rpc.signatures) {
      rpc.feeAndPayerBySig.set(s.signature, { fee: 5_000n, feePayer: WALLET });
    }

    const result = await svc.ingestWallet(WALLET);

    expect(result.fetched).toBe(ceiling);
    const after = await cursors.get(`wallet-activity:${WALLET}`);
    expect(after?.payload?.['newestSignature']).toBe(s1.signature);
    expect(after?.payload?.['backfillFrontier']).toBe(s2.signature);
  });

  it('blockTime past 365-day cutoff stops the walk cleanly', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = now - 400 * 24 * 60 * 60;
    const recent = mkSig(now);
    const old = mkSig(stale);
    rpc.signatures = [recent, old];
    rpc.feeAndPayerBySig.set(recent.signature, { fee: 5_000n, feePayer: WALLET });
    // No entry for `old` — if cutoff doesn't fire, fetch would
    // return null and we'd see a miss. Assert no fetch.

    await svc.ingestWallet(WALLET);

    expect(rpc.feeCalls).toEqual([recent.signature]);
    const after = await cursors.get(`wallet-activity:${WALLET}`);
    expect(after?.payload?.['newestSignature']).toBe(recent.signature);
    expect(after?.payload?.['backfillFrontier']).toBeNull();
  });

  it('getSignaturesForAddress failure → dirty exit, no real checkpoint advance', async () => {
    rpc.throwOnNextSigCall = new Error('RPC fault');
    const result = await svc.ingestWallet(WALLET);

    expect(result.fetched).toBe(0);
    expect(repo.writes.length).toBe(0);
    // Service may still write a defensive empty cursor; verify it
    // didn't ADVANCE the checkpoint past anything (both fields
    // stay null since no sigs were ever observed). A retry next
    // tick still acts as "never run".
    const after = await cursors.get(`wallet-activity:${WALLET}`);
    expect(after?.payload?.['newestSignature'] ?? null).toBeNull();
    expect(after?.payload?.['backfillFrontier'] ?? null).toBeNull();
  });

  it('empty wallet history → clean no-op', async () => {
    rpc.signatures = [];
    const result = await svc.ingestWallet(WALLET);
    expect(result.signatures).toBe(0);
    expect(result.outgoing).toBe(0);
    expect(result.fetched).toBe(0);
    expect(repo.writes.length).toBe(0);
  });
});

describe('WalletActivityIngesterService — tiered RPC routing', () => {
  let primary: FakeRpc;
  let archive: FakeRpc;
  let repo: FakeWalletActivityRepo;
  let cursors: FakeCursorsRepo;
  let svc: WalletActivityIngesterService;

  beforeEach(() => {
    primary = new FakeRpc();
    archive = new FakeRpc();
    repo = new FakeWalletActivityRepo();
    cursors = new FakeCursorsRepo();
    svc = new WalletActivityIngesterService(
      {
        primaryRpc: primary as unknown as SolanaRpcClient,
        archiveRpc: archive as unknown as SolanaRpcClient,
        repo: repo as unknown as WalletActivityRepository,
        cursors: cursors as unknown as CursorsRepository,
        logger: silent,
      },
      { maxFeeFetchesPerTick: 1000 },
    );
  });

  it('initial walk (cursor null) → primary', async () => {
    const now = Math.floor(Date.now() / 1000);
    const s = mkSig(now);
    primary.signatures = [s];
    primary.feeAndPayerBySig.set(s.signature, { fee: 5_000n, feePayer: WALLET });
    archive.signatures = []; // archive untouched

    const result = await svc.ingestWallet(WALLET);

    expect(result.rpcMode).toBe('primary-initial');
    expect(primary.sigCalls.length).toBe(1);
    expect(archive.sigCalls.length).toBe(0);
  });

  it('incremental (cursor set, no frontier) → archive', async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = mkSig(now);
    const fresh = mkSig(now);
    await cursors.upsert({
      jobName: `wallet-activity:${WALLET}`,
      epoch: null,
      lastProcessedSlot: null,
      payload: { newestSignature: old.signature, backfillFrontier: null },
    });
    archive.signatures = [fresh];
    archive.feeAndPayerBySig.set(fresh.signature, { fee: 7_000n, feePayer: WALLET });
    primary.signatures = []; // primary untouched

    const result = await svc.ingestWallet(WALLET);

    expect(result.rpcMode).toBe('archive-incremental');
    expect(archive.sigCalls.length).toBeGreaterThanOrEqual(1);
    expect(primary.sigCalls.length).toBe(0);
  });

  it('backfill-mode (frontier set) → primary', async () => {
    const now = Math.floor(Date.now() / 1000);
    const newest = mkSig(now);
    const older = mkSig(now);
    await cursors.upsert({
      jobName: `wallet-activity:${WALLET}`,
      epoch: null,
      lastProcessedSlot: null,
      payload: {
        newestSignature: newest.signature,
        backfillFrontier: newest.signature,
      },
    });
    primary.signatures = [older];
    primary.feeAndPayerBySig.set(older.signature, { fee: 6_000n, feePayer: WALLET });

    const result = await svc.ingestWallet(WALLET);

    expect(result.rpcMode).toBe('primary-backfill');
    expect(primary.sigCalls.length).toBeGreaterThanOrEqual(1);
    expect(archive.sigCalls.length).toBe(0);
  });

  it('falls back to primary when archive is unset', async () => {
    svc = new WalletActivityIngesterService(
      {
        primaryRpc: primary as unknown as SolanaRpcClient,
        // archiveRpc deliberately omitted
        repo: repo as unknown as WalletActivityRepository,
        cursors: cursors as unknown as CursorsRepository,
        logger: silent,
      },
      { maxFeeFetchesPerTick: 1000 },
    );
    const now = Math.floor(Date.now() / 1000);
    const old = mkSig(now);
    const fresh = mkSig(now);
    await cursors.upsert({
      jobName: `wallet-activity:${WALLET}`,
      epoch: null,
      lastProcessedSlot: null,
      payload: { newestSignature: old.signature, backfillFrontier: null },
    });
    primary.signatures = [fresh];
    primary.feeAndPayerBySig.set(fresh.signature, { fee: 4_000n, feePayer: WALLET });

    const result = await svc.ingestWallet(WALLET);

    // Mode label still reads "archive-incremental" (cursor state
    // called for archive), but the routing fell back to primary.
    expect(result.rpcMode).toBe('archive-incremental');
    expect(primary.sigCalls.length).toBeGreaterThanOrEqual(1);
    expect(archive.sigCalls.length).toBe(0);
  });
});
