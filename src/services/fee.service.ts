import type { BlockFetcher } from '../clients/block-fetcher.js';
import {
  buildFullAccountKeyList,
  decomposeTransactionFee,
  extractTipsFromAccountBalances,
} from '../clients/jito-tip-accounts.js';
import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type {
  RpcBlockReward,
  RpcFullTransactionEntry,
  RpcLeaderSchedule,
} from '../clients/types.js';
import type { Logger } from '../core/logger.js';
import { toLamports } from '../core/lamports.js';
import type { ProcessedBlocksRepository } from '../storage/repositories/processed-blocks.repo.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { Epoch, IdentityPubkey, ProcessedBlock, Slot, VotePubkey } from '../types/domain.js';

export interface FeeServiceDeps {
  rpc: SolanaRpcClient;
  /**
   * Optional router for `getBlock` calls. When provided, every
   * `getBlock` in the ingest loop goes through the router. The worker
   * does not wire an archive/hot router by default; this hook remains
   * useful for offline refill scripts.
   */
  blockFetcher?: BlockFetcher;
  statsRepo: StatsRepository;
  processedBlocksRepo: ProcessedBlocksRepository;
  logger: Logger;
}

export interface IngestPendingBlocksArgs {
  epoch: Epoch;
  identities: IdentityPubkey[];
  leaderSchedule: RpcLeaderSchedule;
  firstSlot: Slot;
  lastSlot: Slot;
  safeUpperSlot: Slot;
  batchSize: number;
}

export interface IngestPendingBlocksResult {
  processed: number;
  skipped: number;
  errors: number;
}

/**
 * Sum the lamport rewards on a block that are attributed to `leaderIdentity`
 * as block fees. The leader-filter + rewardType-filter together prevent us
 * from mistakenly counting vote/rent rewards or rewards that landed in the
 * same block but belonged to a different account (e.g. the split paid to
 * the Stakepool program on a Jito-bundled block).
 */
export function extractLeaderFees(
  rewards: RpcBlockReward[] | null | undefined,
  leaderIdentity: IdentityPubkey,
): bigint {
  if (!rewards || rewards.length === 0) return 0n;
  let total = 0n;
  for (const r of rewards) {
    if (r.rewardType !== 'Fee') continue;
    if (r.pubkey !== leaderIdentity) continue;
    // `r.lamports` may arrive as number or string depending on RPC provider;
    // `toLamports` accepts both and rejects non-integer / out-of-range input.
    total += toLamports(r.lamports);
  }
  return total;
}

/**
 * Categorised income for ONE block, derived from per-tx metadata.
 * All values are gross lamports observed on-chain during the block:
 *
 *   - `baseFees`     — 5000 × signatures across every tx (pre-burn,
 *                       gross). Leader nets post-burn — downstream
 *                       consumers can apply the current burn rate
 *                       if they want the operator-receipt number.
 *   - `priorityFees` — per-tx `meta.fee` minus base. 100% to leader
 *                       under current cluster rules; gross = net.
 *   - `mevTips`      — sum of positive balance deltas on the 8 Jito
 *                       tip accounts across every tx. See
 *                       `extractTipsFromAccountBalances` for the
 *                       algorithm rationale.
 */
export interface PerBlockIncome {
  baseFees: bigint;
  priorityFees: bigint;
  mevTips: bigint;
}

export interface PerBlockSlotFacts {
  txCount: number;
  successfulTxCount: number;
  failedTxCount: number;
  unknownMetaTxCount: number;
  signatureCount: number;
  tipTxCount: number;
  maxTipLamports: bigint;
  maxPriorityFeeLamports: bigint;
  computeUnitsConsumed: bigint;
}

export interface PerBlockAnalysis {
  income: PerBlockIncome;
  slotFacts: PerBlockSlotFacts;
}

/**
 * Decompose a block's transaction list into income buckets and
 * slot facts. Walks each tx ONCE, accumulates every derived field
 * in parallel, and does not make any extra RPC calls.
 *
 * Requires `transactionDetails: 'full'` for the source `getBlock`
 * call — we read `tx.transaction.signatures.length` and
 * `tx.meta.fee` per tx, neither of which is surfaced by the
 * lighter `'accounts'` or `'none'` modes.
 *
 * Failed txs (`tx.meta.err !== null`) are skipped: they paid the
 * base fee (to fee_payer, not leader — wait, actually failed txs
 * DO still pay fees to leader) but counting them introduces noise
 * for the median calculation. Conservative: skip. Downstream
 * consumers that want gross-gross totals can revisit.
 *
 * Actually correction: in Solana, failed txs STILL PAY THE FEE —
 * that's the whole point of the 5000 lamports/sig model, it's a
 * spam deterrent. So failed-tx fees DO accrue to the leader. We
 * used to skip failed txs when ONLY counting tips (bundle failures
 * shouldn't count as tip revenue); but for FEE attribution failed
 * txs are part of leader income. We split the handling:
 *   - fees: count failed txs (leader still got paid)
 *   - tips: skip failed txs (bundle failure = no tip deposit)
 */
export function analyzeBlockTransactions(
  transactions: RpcFullTransactionEntry[] | undefined,
): PerBlockAnalysis {
  const income: PerBlockIncome = { baseFees: 0n, priorityFees: 0n, mevTips: 0n };
  const slotFacts: PerBlockSlotFacts = {
    txCount: transactions?.length ?? 0,
    successfulTxCount: 0,
    failedTxCount: 0,
    unknownMetaTxCount: 0,
    signatureCount: 0,
    tipTxCount: 0,
    maxTipLamports: 0n,
    maxPriorityFeeLamports: 0n,
    computeUnitsConsumed: 0n,
  };
  if (!transactions || transactions.length === 0) return { income, slotFacts };

  for (const tx of transactions) {
    const signatureCount = tx.transaction.signatures.length;
    slotFacts.signatureCount += signatureCount;

    if (tx.meta === null || tx.meta === undefined) {
      slotFacts.unknownMetaTxCount += 1;
      continue;
    }
    const staticKeys = tx.transaction.message.accountKeys;
    const successful = tx.meta.err === null || tx.meta.err === undefined;
    if (successful) slotFacts.successfulTxCount += 1;
    else slotFacts.failedTxCount += 1;

    // Fee decomposition — always (failed txs pay fees too).
    const feeLamports = toBigIntLenient(tx.meta.fee);
    if (feeLamports !== null) {
      const { baseFee, priorityFee } = decomposeTransactionFee(feeLamports, signatureCount);
      income.baseFees += baseFee;
      income.priorityFees += priorityFee;
      if (priorityFee > slotFacts.maxPriorityFeeLamports) {
        slotFacts.maxPriorityFeeLamports = priorityFee;
      }
    }
    const computeUnits = toBigIntLenient(tx.meta.computeUnitsConsumed);
    if (computeUnits !== null) {
      slotFacts.computeUnitsConsumed += computeUnits;
    }

    // Tip extraction — skip failed bundles (they shouldn't have
    // deposited tips; counting them would inflate the total).
    if (!successful) continue;
    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;
    // Build the FULL account key list (static + ALT-loaded) so the
    // tip extractor can spot tips routed through Address Lookup
    // Tables. Empirical finding (SF epoch 960): ~0.16% of tips
    // arrive via ALT and were silently missed when we only passed
    // the static keys. See `buildFullAccountKeyList` docstring for
    // the ordering rule.
    const fullKeys = buildFullAccountKeyList(staticKeys, tx.meta.loadedAddresses);
    if (
      fullKeys.length === 0 ||
      preBalances.length < fullKeys.length ||
      postBalances.length < fullKeys.length
    ) {
      // Defensive: if balance arrays don't cover the full key list
      // (should never happen for a well-formed block; would mean
      // the provider stripped or mis-ordered the pre/post arrays),
      // fall back to checking only the static keys. Under-counting
      // is preferable to indexing off the end of the balance array
      // and silently reading undefined values.
      if (
        staticKeys.length === 0 ||
        preBalances.length < staticKeys.length ||
        postBalances.length < staticKeys.length
      ) {
        continue;
      }
      const tip = extractTipsFromAccountBalances(staticKeys, preBalances, postBalances);
      income.mevTips += tip;
      if (tip > 0n) slotFacts.tipTxCount += 1;
      if (tip > slotFacts.maxTipLamports) slotFacts.maxTipLamports = tip;
      continue;
    }
    const tip = extractTipsFromAccountBalances(fullKeys, preBalances, postBalances);
    income.mevTips += tip;
    if (tip > 0n) slotFacts.tipTxCount += 1;
    if (tip > slotFacts.maxTipLamports) slotFacts.maxTipLamports = tip;
  }
  return { income, slotFacts };
}

export function decomposeBlockIncome(
  transactions: RpcFullTransactionEntry[] | undefined,
): PerBlockIncome {
  return analyzeBlockTransactions(transactions).income;
}

/**
 * @deprecated Use `decomposeBlockIncome` and read `.mevTips`. Kept as
 * a thin wrapper so gRPC-ingest path (which also needs tip extraction)
 * continues to compile without touching every call site in one patch.
 */
export function extractLeaderTips(transactions: RpcFullTransactionEntry[] | undefined): bigint {
  return decomposeBlockIncome(transactions).mevTips;
}

/**
 * Defensive bigint coercion — `tx.meta.fee` may be number, string, OR
 * bigint depending on provider runtime:
 *
 *   - JSON-RPC path (polling ingester): Solana providers serialise u64
 *     as JSON number or decimal string. `JSON.parse` hands us one of
 *     those two types.
 *   - gRPC path (`@triton-one/yellowstone-grpc` napi-rs): proto types
 *     DECLARE `string` for u64 (`forceLong=string` in ts-proto config),
 *     but the napi JS wrapper passes BigInt through natively for
 *     performance. The TypeScript type lies; runtime value is bigint.
 *
 * Before we fixed this, gRPC-ingested blocks silently lost base/
 * priority fees — `toBigIntLenient` returned null for bigint inputs
 * because no `typeof` branch matched, and the caller skipped the
 * decomposition. Tips still showed up because `extractTipsFromAccount
 * Balances` already had a bigint-aware coercion helper; this function
 * didn't. The bug surfaced as running-epoch rows with tips > 0 but
 * base=0 AND priority=0.
 *
 * Returns null on anything genuinely non-integer (NaN, negative,
 * garbage string) so the caller can skip without propagating bad
 * data into aggregate math.
 */
function toBigIntLenient(value: number | string | bigint | undefined | null): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') {
    return value >= 0n ? value : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    if (value === '' || !/^\d+$/.test(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function blockTimeFromUnixSeconds(value: number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

function normaliseFetchError(err: unknown): { code: string | null; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      code: typeof code === 'string' ? code : null,
      message: err.message.slice(0, 500),
    };
  }
  return { code: null, message: String(err).slice(0, 500) };
}

/**
 * Fetches individual blocks for each leader-scheduled slot, attributes the
 * "Fee" rewards to the leader identity, and persists a `processed_blocks`
 * row per observed slot.
 *
 * Idempotency model:
 *   We rely on the `processed_blocks.slot` primary key. `insertBatch` uses
 *   `ON CONFLICT (slot) DO NOTHING` and reports the number of rows actually
 *   inserted. Fee deltas are only applied for newly inserted rows, so
 *   re-running the same batch is a no-op.
 *
 *   Tradeoff: the "which slots are new" check lives inside
 *   `processedBlocksRepo.getProcessedSlotsInRange` rather than being driven
 *   off `insertBatch`'s return count. If the process crashes between the
 *   insert and the delta update, a re-run will find no new slots (because
 *   the insert is already persisted) and the delta will be lost. This is
 *   intentional — the alternative (two-phase commit across two tables) is
 *   more code than the rare-crash loss is worth. If we observe drift in
 *   practice, the fix is a transactional insert + update combined.
 */
export class FeeService {
  private readonly rpc: SolanaRpcClient;
  private readonly blockFetcher: BlockFetcher | undefined;
  private readonly statsRepo: StatsRepository;
  private readonly processedBlocksRepo: ProcessedBlocksRepository;
  private readonly logger: Logger;

  constructor(deps: FeeServiceDeps) {
    this.rpc = deps.rpc;
    this.blockFetcher = deps.blockFetcher;
    this.statsRepo = deps.statsRepo;
    this.processedBlocksRepo = deps.processedBlocksRepo;
    this.logger = deps.logger;
  }

  /**
   * Route `getBlock` through the hot-path router when one is wired,
   * otherwise go straight to `rpc`. Every caller in this file funnels
   * through here so we can't accidentally leak a direct `rpc.getBlock`
   * call that bypasses the fallback.
   */
  private async fetchBlock(
    slot: Slot,
    opts: Parameters<SolanaRpcClient['getBlock']>[1],
  ): Promise<Awaited<ReturnType<SolanaRpcClient['getBlock']>>> {
    if (this.blockFetcher !== undefined) {
      return this.blockFetcher.getBlock(slot, opts);
    }
    return this.rpc.getBlock(slot, opts);
  }

  async ingestPendingBlocks(args: IngestPendingBlocksArgs): Promise<IngestPendingBlocksResult> {
    const { epoch, identities, leaderSchedule, firstSlot, safeUpperSlot, batchSize } = args;

    if (identities.length === 0 || safeUpperSlot < firstSlot) {
      return { processed: 0, skipped: 0, errors: 0 };
    }

    // Map each candidate slot (absolute) → the leader identity assigned to
    // it, clamped to safeUpperSlot. Identities come from the watched set
    // provided by the caller, so no further filtering is needed here.
    const slotToIdentity = new Map<Slot, IdentityPubkey>();
    for (const identity of identities) {
      const offsets = leaderSchedule[identity];
      if (!offsets) continue;
      for (const offset of offsets) {
        const slot = firstSlot + offset;
        if (slot > safeUpperSlot) continue;
        if (slot < firstSlot) continue;
        slotToIdentity.set(slot, identity);
      }
    }

    if (slotToIdentity.size === 0) {
      return { processed: 0, skipped: 0, errors: 0 };
    }

    // Subtract already-processed slots.
    const already = await this.processedBlocksRepo.getProcessedSlotsInRange(
      epoch,
      firstSlot,
      safeUpperSlot,
    );
    const pending: Slot[] = [];
    for (const slot of slotToIdentity.keys()) {
      if (!already.has(slot)) pending.push(slot);
    }
    pending.sort((a, b) => a - b);

    const effectiveBatchSize = Math.max(1, batchSize);

    let processed = 0;
    let skipped = 0;
    let errors = 0;

    // pending may be empty — the tick still needs to fall through to the
    // median recompute below so previously-ingested epochs get their
    // derived aggregates refreshed. (Historical bug: the ingester bailed
    // out early here, meaning pods that started up already-caught-up
    // never recomputed medians, leaving `median_fee_lamports` null
    // across the board.)
    for (let i = 0; i < pending.length; i += effectiveBatchSize) {
      const chunk = pending.slice(i, i + effectiveBatchSize);
      const results = await Promise.all(
        chunk.map(async (slot) => {
          const identity = slotToIdentity.get(slot);
          if (identity === undefined) {
            // Shouldn't happen: we built pending from slotToIdentity.
            return { slot, kind: 'error' as const };
          }
          try {
            // `transactionDetails: 'full'` — upgraded from 'accounts'
            // in migration 0010 to access `tx.signatures` and
            // `tx.meta.fee`, which together yield the base/priority
            // fee split:
            //   base     = 5000 × signatures.length per tx
            //   priority = meta.fee - base
            //
            // Provider credit cost is usually unchanged for this request
            // shape, while bandwidth grows ~35% (~2MB → ~3MB per block).
            // That is acceptable because we only fetch watched validators'
            // leader slots.
            //
            // `fetchBlock` is a direct primary-RPC call in the live
            // worker. Offline refill scripts can still provide a
            // BlockFetcher router through the optional service hook.
            //
            // `decomposeBlockIncome` walks every tx once and
            // aggregates the three revenue buckets in parallel — see
            // the function docstring for edge-case handling (failed
            // txs, non-Jito leaders).
            const block = await this.fetchBlock(slot, {
              transactionDetails: 'full',
              rewards: true,
              maxSupportedTransactionVersion: 0,
              commitment: 'finalized',
            });
            if (block === null) {
              return { slot, identity, kind: 'skipped' as const };
            }
            // Derive the LEADER'S NET share of fees by category —
            // what actually accrued to the operator, not what users
            // paid gross. This matches vx.tools's field semantics
            // (empirically verified: our leader-base-share = their
            // `baseFees` to ~0.1% across Wave/SF/0base/Crypto Plant
            // epochs 959-960).
            //
            //   leaderFees (= rewards[] Fee total, authoritative)
            //     = leader_base_share + leader_priority_share
            //   priority_gross (= Σ meta.fee - 5000×sigs) = leader_priority_share
            //     (SIMD-96: 100% of priority goes to leader, gross=net)
            //   ∴ leader_base_share = leaderFees - priority_gross
            //
            // Storing the LEADER SHARE in `base_fees_lamports` (not
            // the gross 5000×sigs value) gives us numbers that sum
            // correctly with priority/tips to equal what the operator
            // earned — the most intuitive interpretation for users
            // and the one vx.tools publishes.
            const leaderFees = extractLeaderFees(block.rewards, identity);
            const analysis = analyzeBlockTransactions(block.transactions);
            const { income, slotFacts } = analysis;
            const leaderBase =
              leaderFees > income.priorityFees ? leaderFees - income.priorityFees : 0n;
            return {
              slot,
              identity,
              kind: 'produced' as const,
              leaderFees,
              baseFees: leaderBase,
              priorityFees: income.priorityFees,
              tips: income.mevTips,
              blockTime: blockTimeFromUnixSeconds(block.blockTime),
              slotFacts,
            };
          } catch (err) {
            const { code, message } = normaliseFetchError(err);
            await this.processedBlocksRepo.recordFetchError({
              epoch,
              slot,
              leaderIdentity: identity,
              errorCode: code,
              errorMessage: message,
            });
            this.logger.warn(
              { err, slot, identity },
              'fee.service: getBlock failed, skipping this slot for now',
            );
            return { slot, identity, kind: 'error' as const };
          }
        }),
      );

      // First pass: shape every non-error result into an insertable row
      // and also remember the per-slot revenue splits so we can build
      // a delta from exactly those slots the DB tells us it inserted.
      const rows: ProcessedBlock[] = [];
      type SlotDelta = {
        identity: IdentityPubkey;
        leaderFees: bigint;
        baseFees: bigint;
        priorityFees: bigint;
        tips: bigint;
      };
      const deltaBySlot = new Map<Slot, SlotDelta>();
      const now = new Date();

      for (const r of results) {
        if (r.kind === 'error') {
          errors += 1;
          continue;
        }
        if (r.kind === 'skipped') {
          rows.push({
            slot: r.slot,
            epoch,
            leaderIdentity: r.identity,
            feesLamports: 0n,
            baseFeesLamports: 0n,
            priorityFeesLamports: 0n,
            tipsLamports: 0n,
            blockStatus: 'skipped',
            blockTime: null,
            txCount: 0,
            successfulTxCount: 0,
            failedTxCount: 0,
            unknownMetaTxCount: 0,
            signatureCount: 0,
            tipTxCount: 0,
            maxTipLamports: 0n,
            maxPriorityFeeLamports: 0n,
            computeUnitsConsumed: 0n,
            factsCapturedAt: now,
            processedAt: now,
          });
          deltaBySlot.set(r.slot, {
            identity: r.identity,
            leaderFees: 0n,
            baseFees: 0n,
            priorityFees: 0n,
            tips: 0n,
          });
          skipped += 1;
          continue;
        }
        rows.push({
          slot: r.slot,
          epoch,
          leaderIdentity: r.identity,
          feesLamports: r.leaderFees,
          baseFeesLamports: r.baseFees,
          priorityFeesLamports: r.priorityFees,
          tipsLamports: r.tips,
          blockStatus: 'produced',
          blockTime: r.blockTime,
          txCount: r.slotFacts.txCount,
          successfulTxCount: r.slotFacts.successfulTxCount,
          failedTxCount: r.slotFacts.failedTxCount,
          unknownMetaTxCount: r.slotFacts.unknownMetaTxCount,
          signatureCount: r.slotFacts.signatureCount,
          tipTxCount: r.slotFacts.tipTxCount,
          maxTipLamports: r.slotFacts.maxTipLamports,
          maxPriorityFeeLamports: r.slotFacts.maxPriorityFeeLamports,
          computeUnitsConsumed: r.slotFacts.computeUnitsConsumed,
          factsCapturedAt: now,
          processedAt: now,
        });
        deltaBySlot.set(r.slot, {
          identity: r.identity,
          leaderFees: r.leaderFees,
          baseFees: r.baseFees,
          priorityFees: r.priorityFees,
          tips: r.tips,
        });
        processed += 1;
      }

      if (rows.length > 0) {
        // `insertBatch` returns the slots it actually inserted. Apply
        // deltas only for those; a row that lost a race with a concurrent
        // writer (or with our own earlier run after a crash) must NOT
        // have its fee / tip added again.
        const insertedSlots = await this.processedBlocksRepo.insertBatch(rows);
        await this.processedBlocksRepo.markFetchResolved(
          epoch,
          rows.map((row) => row.slot),
        );
        if (insertedSlots.size < rows.length) {
          this.logger.warn(
            { inserted: insertedSlots.size, rows: rows.length },
            'fee.service: some rows already present (race or re-run) — deltas skipped for those',
          );
        }
        const deltaByIdentity = new Map<
          IdentityPubkey,
          { leaderFees: bigint; baseFees: bigint; priorityFees: bigint; tips: bigint }
        >();
        for (const slot of insertedSlots) {
          const entry = deltaBySlot.get(slot);
          if (!entry) continue;
          if (
            entry.leaderFees === 0n &&
            entry.baseFees === 0n &&
            entry.priorityFees === 0n &&
            entry.tips === 0n
          ) {
            continue;
          }
          const prev = deltaByIdentity.get(entry.identity) ?? {
            leaderFees: 0n,
            baseFees: 0n,
            priorityFees: 0n,
            tips: 0n,
          };
          deltaByIdentity.set(entry.identity, {
            leaderFees: prev.leaderFees + entry.leaderFees,
            baseFees: prev.baseFees + entry.baseFees,
            priorityFees: prev.priorityFees + entry.priorityFees,
            tips: prev.tips + entry.tips,
          });
        }
        for (const [identity, delta] of deltaByIdentity.entries()) {
          await this.statsRepo.addIncomeDelta({
            epoch,
            identityPubkey: identity,
            leaderFeeDeltaLamports: delta.leaderFees,
            baseFeeDeltaLamports: delta.baseFees,
            priorityFeeDeltaLamports: delta.priorityFees,
            tipDeltaLamports: delta.tips,
          });
        }
      }
    }

    // Recompute per-validator medians on EVERY tick, not just when new
    // rows were inserted. The medians are pure derived views over
    // `processed_blocks`; if a prior run populated the table but never
    // got to recompute (pod restarted mid-tick, or started up already
    // caught-up so `processed > 0` never triggered), this pass self-
    // heals. Cost: five `percentile_cont` UPDATEs per tick — still
    // cheap even for thousands of blocks per identity. No-op on empty
    // identities or when no produced blocks match.
    const medianFees = await this.statsRepo.recomputeMedianFees(epoch, identities);
    const medianBase = await this.statsRepo.recomputeMedianBaseFees(epoch, identities);
    const medianPriority = await this.statsRepo.recomputeMedianPriorityFees(epoch, identities);
    const medianTips = await this.statsRepo.recomputeMedianTips(epoch, identities);
    const medianTotals = await this.statsRepo.recomputeMedianTotals(epoch, identities);

    this.logger.info(
      {
        epoch,
        processed,
        skipped,
        errors,
        pending: pending.length,
        medianFees,
        medianBase,
        medianPriority,
        medianTips,
        medianTotals,
      },
      'fee.service: ingest complete',
    );
    return { processed, skipped, errors };
  }

  /**
   * Ingest ONE pre-fetched block (produced outside this service, e.g.
   * a Yellowstone gRPC stream). Performs the same fee + tip extraction
   * and persistence as `ingestPendingBlocks` but skips the `getBlock`
   * fetch — callers already have the block in hand.
   *
   * The per-tick median recompute is deliberately NOT triggered here
   * (it would pile up at stream rate); the polling-path ingester keeps
   * its regular cadence and is responsible for median freshness. gRPC
   * shortens the "block produced → per-block row persisted" latency,
   * which is what matters for the live path.
   *
   * Returns `true` when a new row was inserted, `false` when the slot
   * was already present (another ingester got there first — no delta
   * applied) or the block was flagged 'skipped' upstream.
   */
  async ingestStreamedBlock(args: {
    slot: Slot;
    epoch: Epoch;
    leaderIdentity: IdentityPubkey;
    blockTime?: number | null | undefined;
    rewards: RpcBlockReward[] | null | undefined;
    transactions: RpcFullTransactionEntry[] | undefined;
  }): Promise<boolean> {
    const leaderFees = extractLeaderFees(args.rewards, args.leaderIdentity);
    const analysis = analyzeBlockTransactions(args.transactions);
    const { income, slotFacts } = analysis;
    // See `ingestPendingBlocks` for the derivation — `base_fees_lamports`
    // stores the LEADER'S NET share (rewards - priority), not the gross
    // 5000×sigs amount. Keeps gRPC and polling paths semantically
    // identical so downstream consumers can't tell which produced a row.
    const leaderBase = leaderFees > income.priorityFees ? leaderFees - income.priorityFees : 0n;
    const processedAt = new Date();
    const row: ProcessedBlock = {
      slot: args.slot,
      epoch: args.epoch,
      leaderIdentity: args.leaderIdentity,
      feesLamports: leaderFees,
      baseFeesLamports: leaderBase,
      priorityFeesLamports: income.priorityFees,
      tipsLamports: income.mevTips,
      blockStatus: 'produced',
      blockTime: blockTimeFromUnixSeconds(args.blockTime),
      txCount: slotFacts.txCount,
      successfulTxCount: slotFacts.successfulTxCount,
      failedTxCount: slotFacts.failedTxCount,
      unknownMetaTxCount: slotFacts.unknownMetaTxCount,
      signatureCount: slotFacts.signatureCount,
      tipTxCount: slotFacts.tipTxCount,
      maxTipLamports: slotFacts.maxTipLamports,
      maxPriorityFeeLamports: slotFacts.maxPriorityFeeLamports,
      computeUnitsConsumed: slotFacts.computeUnitsConsumed,
      factsCapturedAt: processedAt,
      processedAt,
    };
    const inserted = await this.processedBlocksRepo.insertBatch([row]);
    await this.processedBlocksRepo.markFetchResolved(args.epoch, [args.slot]);
    if (!inserted.has(args.slot)) {
      // Lost the race with the polling path (or a previous run) — skip
      // the delta so we don't double-count.
      return false;
    }
    if (
      leaderFees !== 0n ||
      leaderBase !== 0n ||
      income.priorityFees !== 0n ||
      income.mevTips !== 0n
    ) {
      await this.statsRepo.addIncomeDelta({
        epoch: args.epoch,
        identityPubkey: args.leaderIdentity,
        leaderFeeDeltaLamports: leaderFees,
        baseFeeDeltaLamports: leaderBase,
        priorityFeeDeltaLamports: income.priorityFees,
        tipDeltaLamports: income.mevTips,
      });
    }
    return true;
  }

  /**
   * One-shot previous-epoch backfill for a newly-tracked validator.
   *
   * Called by the fee-ingester once per dynamic validator (the
   * `watched_validators_dynamic.prev_epoch_backfilled_at` flag gates
   * re-runs). Scope per the product spec: JUST the immediately-
   * previous closed epoch, not the full history — a new user adding
   * their validator sees last-epoch income immediately, and future
   * epochs flow in naturally through the regular ingest path.
   *
   * Steps:
   *   1. Materialise the `epoch_validator_stats` row from the leader
   *      schedule + existing local facts. Without this, `addIncomeDelta`
   *      (plain UPDATE) would silently no-op because the row doesn't exist
   *      yet.
   *   2. Delegate to `ingestPendingBlocks` with `safeUpperSlot = lastSlot`
   *      (the epoch is fully finalised) and a one-element `identities`
   *      array — reuses the same fee-extraction + median recompute the
   *      live ingest already exercises.
   *   3. Re-read produced/skipped counts from `processed_blocks` and update
   *      the stats row. Any RPC errors remain missing facts and are retried
   *      by the next reconciliation tick.
   *
   * Caller marks the backfill done via `watchedDynamicRepo.markBackfilled`
   * on success; on failure the flag stays null so the next tick retries.
   */
  async backfillPreviousEpoch(args: {
    epoch: Epoch;
    vote: VotePubkey;
    identity: IdentityPubkey;
    firstSlot: Slot;
    lastSlot: Slot;
    leaderSchedule: RpcLeaderSchedule;
    batchSize: number;
  }): Promise<{
    slotsAssigned: number;
    slotsProduced: number;
    slotsSkipped: number;
    processed: number;
    skipped: number;
    errors: number;
  }> {
    const slotsAssigned = args.leaderSchedule[args.identity]?.length ?? 0;
    const beforeCounts = await this.processedBlocksRepo.countStatusesForIdentityInRange(
      args.epoch,
      args.identity,
      args.firstSlot,
      args.lastSlot,
    );

    // Step 1 — materialise the stats row so subsequent income UPDATEs hit it.
    await this.statsRepo.upsertSlotStats({
      epoch: args.epoch,
      votePubkey: args.vote,
      identityPubkey: args.identity,
      slotsAssigned,
      slotsProduced: beforeCounts.produced,
      slotsSkipped: beforeCounts.skipped,
    });

    // Step 2 — attribute fees block-by-block. Since the epoch is fully
    // closed, `safeUpperSlot` is just `lastSlot` — no finality buffer
    // is needed. `ingestPendingBlocks` is safe to call single-identity.
    const result = await this.ingestPendingBlocks({
      epoch: args.epoch,
      identities: [args.identity],
      leaderSchedule: args.leaderSchedule,
      firstSlot: args.firstSlot,
      lastSlot: args.lastSlot,
      safeUpperSlot: args.lastSlot,
      batchSize: args.batchSize,
    });

    // Step 3 — publish local-fact counters after any newly inserted rows.
    const afterCounts = await this.processedBlocksRepo.countStatusesForIdentityInRange(
      args.epoch,
      args.identity,
      args.firstSlot,
      args.lastSlot,
    );
    await this.statsRepo.upsertSlotStats({
      epoch: args.epoch,
      votePubkey: args.vote,
      identityPubkey: args.identity,
      slotsAssigned,
      slotsProduced: afterCounts.produced,
      slotsSkipped: afterCounts.skipped,
    });

    this.logger.info(
      {
        epoch: args.epoch,
        vote: args.vote,
        identity: args.identity,
        slotsAssigned,
        slotsProduced: afterCounts.produced,
        slotsSkipped: afterCounts.skipped,
        ...result,
      },
      'fee.service: previous-epoch backfill complete',
    );
    return {
      slotsAssigned,
      slotsProduced: afterCounts.produced,
      slotsSkipped: afterCounts.skipped,
      ...result,
    };
  }
}
