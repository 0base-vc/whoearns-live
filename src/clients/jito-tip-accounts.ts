/**
 * Jito MEV tip-payment accounts (mainnet-beta).
 *
 * These are the 8 public accounts that Jito searchers deposit tips into
 * when submitting bundles. At the end of each Jito-produced block, the
 * block leader transfers accumulated tips out of these accounts to their
 * own identity — so per-block tip revenue for a leader can be derived
 * from the balance deltas observed on these 8 accounts during the block.
 *
 * The list is fixed on-chain — not configurable per-epoch and not expected
 * to change without a coordinated protocol update. Source of truth:
 *   - `getTipAccounts` RPC on `https://mainnet.block-engine.jito.wtf` —
 *     THIS is the canonical list. Docs can be stale; the RPC is not.
 *   - Jito docs: https://docs.jito.wtf/lowlatencytxnfeed/#tip-accounts
 *
 * History: A previous version of this constant had a typo in account
 * #6 (`ADuUkR4vqLUMWXxW9gh6D6L8pivKeVBBzqFuRsixXcmL` instead of the
 * correct `ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt`). This caused
 * ~10-20% under-counting of MEV tips across all watched validators —
 * not visible by eye (base58 pubkeys are hard to diff), surfaced only
 * after a quantitative comparison against vx.tools's numbers. Fixed
 * in migration 0010's follow-up commit with a test that verifies the
 * constant matches Jito's live `getTipAccounts` response.
 *
 * We hard-code rather than fetch at runtime because:
 *   1. A fetch at ingester startup introduces another failure mode and
 *      rate-limit exposure for zero benefit (the answer is constant).
 *   2. A silent change would be catastrophic (we'd start under-counting
 *      tips) and the on-chain canary is louder than a silent fetch.
 *   The CI test against live RPC (see
 *   `test/unit/clients/jito-tip-accounts.test.ts`) catches any drift
 *   so we can update this constant deliberately.
 *
 * The `Set<string>` shape is chosen to make membership checks O(1) —
 * the hot-path tip-extraction loop runs this check once per account-key
 * per transaction per block across every watched validator.
 */
export const JITO_TIP_ACCOUNTS: ReadonlySet<string> = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

/**
 * Sum the Jito tips deposited into any of the 8 tip accounts during one
 * block transaction.
 *
 * Algorithm: walk the FULL account key list (static + ALT-loaded) looking
 * for tip-account matches; for each match, add `postBalance - preBalance`
 * (if positive) to the running total. Positive deltas are user searchers
 * depositing tips; negative deltas are the leader sweeping accumulated
 * tips out at end of block (we ignore those — they're just a shuffle
 * within the same block's income and would double-count if summed too).
 *
 * **Caller obligation — pass the FULL account list**, not just static
 * `message.accountKeys`. Solana v0 txs can load tip accounts via an
 * Address Lookup Table (ALT); those addresses appear in
 * `meta.loadedAddresses.writable` and are REQUIRED for this function
 * to return a complete total. We empirically verified (SF epoch 960
 * post-mortem) that ~0.16% of Jito tips are routed through ALT —
 * passing only static keys here silently under-counts. See
 * `src/audit/cross-source.ts` TIP_ROUTER_NET_BPS docstring.
 *
 * `preBalances` / `postBalances` are indexed by the SAME full list —
 * the caller must splice them in matching order (static-then-writable-
 * then-readonly per Solana protocol), which is what the raw RPC
 * response already gives you.
 *
 * Why "positive only": a Jito-enabled leader both receives deposits and
 * runs a sweep tx within the same block. Counting positive-only equals
 * "tips deposited this block", which is the leader's actual earnings.
 * Counting negative-only would ALSO work (equals "tips swept"), but
 * positive-only is robust against missed-sweep edge cases (e.g. first
 * block after a restart where tips accumulate from prior leaders).
 *
 * Non-Jito validators pass through zero here because no tip-account keys
 * appear in their blocks — the filter naturally returns 0n.
 */
export function extractTipsFromAccountBalances(
  /**
   * FULL account key list for the transaction, in protocol order:
   * `[...staticKeys, ...altLoaded.writable, ...altLoaded.readonly]`.
   * Parallel to `preBalances` / `postBalances`. Callers that pass only
   * static keys silently under-count ALT-routed tips.
   */
  accountKeys: readonly string[],
  preBalances: readonly (number | string | bigint)[],
  postBalances: readonly (number | string | bigint)[],
): bigint {
  let total = 0n;
  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys[i];
    if (key === undefined) continue;
    if (!JITO_TIP_ACCOUNTS.has(key)) continue;

    const pre = toBigIntSafe(preBalances[i]);
    const post = toBigIntSafe(postBalances[i]);
    if (pre === null || post === null) continue;

    const delta = post - pre;
    if (delta > 0n) total += delta;
  }
  return total;
}

/**
 * Build the full account key list for a transaction by concatenating
 * static keys with ALT-loaded writable + readonly keys, preserving the
 * protocol-defined order. This order MUST match the indexing of
 * `preBalances` / `postBalances` — Solana's block encoder produces the
 * parallel arrays in exactly this sequence.
 *
 * A helper rather than inlining the concat at each call site so there's
 * exactly one place that knows the ordering rule. If Solana ever changes
 * the ordering (very unlikely — it's protocol-level), this function
 * updates and every caller picks it up.
 *
 * `loadedAddresses` being `null` / `undefined` / partial (e.g. only
 * `writable` set) is tolerated — we treat missing sides as empty.
 * Legacy (pre-v0) transactions have no loaded addresses at all; passing
 * the static keys back unchanged is the correct behaviour there.
 */
export function buildFullAccountKeyList(
  staticKeys: readonly string[],
  loadedAddresses:
    | {
        writable?: readonly string[];
        readonly?: readonly string[];
      }
    | null
    | undefined,
): string[] {
  if (loadedAddresses === null || loadedAddresses === undefined) {
    return [...staticKeys];
  }
  const writable = loadedAddresses.writable ?? [];
  const readOnly = loadedAddresses.readonly ?? [];
  // Short-circuit the common case (no ALT) to avoid array allocations
  // on the hot path. Every pre-v0 tx falls into this branch.
  if (writable.length === 0 && readOnly.length === 0) {
    return [...staticKeys];
  }
  return [...staticKeys, ...writable, ...readOnly];
}

/**
 * Base-fee rate on Solana: 5000 lamports per signature. Hasn't changed
 * since mainnet launch. Protocol burns 50% of this (SIMD-96 era) with
 * the remaining going to the leader via `getBlock.rewards[]` — so
 * reading the `rewards[]` total gets you the LEADER'S POST-BURN RECEIPT
 * of base fees, while `5000 × signatures.length × tx_count` gives the
 * GROSS base fee paid by users. The split is useful because:
 *
 *   - Gross base × fee volume is a network-wide throughput signal
 *   - Leader's post-burn share is what actually pays the operator
 *
 * We publish gross because it's the direct on-chain observable from
 * per-tx metadata; the leader's share can be recomputed downstream
 * by applying the current burn rate if ever needed.
 */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Decompose a transaction's `meta.fee` into base-fee and priority-fee
 * components. Solana protocol guarantees:
 *
 *   base_fee     = BASE_FEE_LAMPORTS_PER_SIGNATURE × signatures.length
 *   priority_fee = meta.fee - base_fee  (≥ 0)
 *
 * Priority fee can be zero (tx didn't set a compute-unit price). Base
 * fee is ALWAYS present since every tx pays 5000 × its sig count.
 *
 * We clamp priority at zero rather than trusting `fee < base` (which
 * shouldn't happen on a well-formed block): if the provider serialised
 * `meta.fee` oddly, we prefer a 0 over a negative number leaking into
 * aggregate math.
 */
export function decomposeTransactionFee(
  totalFeeLamports: bigint,
  signatureCount: number,
): { baseFee: bigint; priorityFee: bigint } {
  const baseFee = BASE_FEE_LAMPORTS_PER_SIGNATURE * BigInt(Math.max(0, signatureCount));
  const priorityFee = totalFeeLamports > baseFee ? totalFeeLamports - baseFee : 0n;
  return { baseFee, priorityFee };
}

/**
 * Defensive bigint coercion — the RPC can return balances as number,
 * string, or (with some providers) already bigint. We accept all three
 * and return null on anything unusable rather than throwing, so a single
 * malformed account entry can't poison the entire block's tip sum.
 */
function toBigIntSafe(value: number | string | bigint | undefined): bigint | null {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    // Balances fit in u64; JS number covers 2^53 which is plenty for
    // per-account balance amounts in practice, but we still prefer the
    // bigint path for safety.
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
