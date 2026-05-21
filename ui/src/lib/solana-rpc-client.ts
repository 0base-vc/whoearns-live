/**
 * Minimal dependency-free Solana JSON-RPC client for the browser.
 *
 * The operator-wallet memo-tx registration needs three RPC calls from
 * the browser, none of which the indexer backend proxies:
 *   - `getBalance`           — gate the fee affordability check;
 *   - `getLatestBlockhash`   — fill the memo transaction's blockhash;
 *   - `getSignatureStatuses` — poll for `confirmed` commitment.
 *
 * This is intentionally NOT `@solana/web3.js` — three JSON-RPC POSTs
 * do not justify a multi-hundred-KB dependency in the SPA bundle.
 *
 * The endpoint is `PUBLIC_SOLANA_RPC_URL`; when unset it falls back
 * to the public mainnet endpoint. Operators with a dedicated RPC
 * should override it (the public endpoint is rate-limited).
 */

import { PUBLIC_SOLANA_RPC_URL } from '$env/static/public';
import { pollUntilConfirmed, type MemoTxCommitment } from './operator-wallet-memo-tx.js';

const FALLBACK_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Per-request fetch timeout. A hung RPC must not wedge the register
// flow forever — `AbortSignal.timeout` aborts the `fetch`, and the
// `catch` in `rpcCall` wraps the resulting error into `SolanaRpcError`.
const RPC_TIMEOUT_MS = 15_000;

/** Resolve the Solana RPC endpoint — env override or public fallback. */
export function getSolanaRpcUrl(): string {
  const fromEnv = (PUBLIC_SOLANA_RPC_URL ?? '').trim();
  return fromEnv.length > 0 ? fromEnv : FALLBACK_RPC_URL;
}

/** A confirmation level a transaction can reach. */
export type SolanaCommitment = MemoTxCommitment;

export class SolanaRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaRpcError';
  }
}

let nextRequestId = 1;

async function rpcCall<T>(
  method: string,
  params: readonly unknown[],
  fetchFn: typeof fetch,
): Promise<T> {
  const id = nextRequestId;
  nextRequestId += 1;
  let response: Response;
  try {
    response = await fetchFn(getSolanaRpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    // A fired `AbortSignal.timeout` rejects the `fetch` with a
    // `TimeoutError`; a caller-side abort surfaces as `AbortError`.
    // Spell the timeout out so the operator sees an actionable
    // message instead of a bare DOMException name.
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) {
      throw new SolanaRpcError(
        `The Solana RPC did not respond within ${RPC_TIMEOUT_MS / 1000}s (${method}). Retry in a few seconds.`,
      );
    }
    throw new SolanaRpcError(
      `Could not reach the Solana RPC (${method}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new SolanaRpcError(`Solana RPC ${method} returned HTTP ${response.status}.`);
  }
  let body: { result?: unknown; error?: { message?: string } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new SolanaRpcError(`Solana RPC ${method} returned a malformed JSON body.`);
  }
  if (body.error !== undefined) {
    throw new SolanaRpcError(`Solana RPC ${method} error: ${body.error.message ?? 'unknown'}.`);
  }
  return body.result as T;
}

/**
 * Connected-wallet balance in lamports. Used to gate the fee
 * affordability check before any memo transaction is built.
 */
export async function getBalanceLamports(
  pubkey: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const result = await rpcCall<{ value?: unknown }>(
    'getBalance',
    [pubkey, { commitment: 'confirmed' }],
    fetchFn,
  );
  const value = result?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SolanaRpcError('getBalance returned a non-numeric balance.');
  }
  return value;
}

/**
 * A recent blockhash for the memo transaction. `confirmed` commitment
 * keeps it consistent with the rest of the flow (the seed fixes
 * `confirmed` everywhere).
 */
export async function getLatestBlockhash(fetchFn: typeof fetch = fetch): Promise<string> {
  const result = await rpcCall<{ value?: { blockhash?: unknown } }>(
    'getLatestBlockhash',
    [{ commitment: 'confirmed' }],
    fetchFn,
  );
  const blockhash = result?.value?.blockhash;
  if (typeof blockhash !== 'string' || blockhash.length === 0) {
    throw new SolanaRpcError('getLatestBlockhash returned no blockhash.');
  }
  return blockhash;
}

/**
 * Confirmation status of a single transaction signature, or `null`
 * when the cluster has no record of it yet (still propagating, or
 * dropped). The string is the highest commitment reached.
 */
export async function getSignatureStatus(
  signature: string,
  fetchFn: typeof fetch = fetch,
): Promise<SolanaCommitment | null> {
  const result = await rpcCall<{
    value?: Array<{ confirmationStatus?: unknown; err?: unknown } | null>;
  }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], fetchFn);
  const entry = result?.value?.[0];
  if (entry === null || entry === undefined) return null;
  if (entry.err !== null && entry.err !== undefined) {
    throw new SolanaRpcError('The memo transaction failed on chain.');
  }
  const status = entry.confirmationStatus;
  if (status === 'processed' || status === 'confirmed' || status === 'finalized') {
    return status;
  }
  return null;
}

export interface AwaitConfirmationOptions {
  /** Overall timeout in milliseconds. */
  timeoutMs?: number;
  /** Delay between status polls in milliseconds. */
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `getSignatureStatuses` until the signature reaches `confirmed`
 * commitment or the timeout elapses. Resolves `true` on confirmation,
 * `false` on timeout. An on-chain failure rejects via
 * `getSignatureStatus`.
 *
 * The actual timeout loop is `pollUntilConfirmed` in the
 * dependency-free memo-tx module — this just supplies a real
 * `getSignatureStatuses`-backed status poller. The clock and sleep
 * stay injectable for tests.
 */
export async function awaitMemoTxConfirmation(
  signature: string,
  options: AwaitConfirmationOptions = {},
): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch;
  const pollOptions: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {};
  if (options.timeoutMs !== undefined) pollOptions.timeoutMs = options.timeoutMs;
  if (options.pollIntervalMs !== undefined) pollOptions.pollIntervalMs = options.pollIntervalMs;
  if (options.now !== undefined) pollOptions.now = options.now;
  if (options.sleep !== undefined) pollOptions.sleep = options.sleep;
  return pollUntilConfirmed(() => getSignatureStatus(signature, fetchFn), pollOptions);
}
