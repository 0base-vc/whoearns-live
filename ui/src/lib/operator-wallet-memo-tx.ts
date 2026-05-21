/**
 * Dependency-free builder for the operator-wallet registration's
 * memo-only Solana transaction.
 *
 * The operator's browser wallet signs AND sends a transaction whose
 * single instruction is an SPL Memo carrying the canonical
 * registration nonce verbatim. The backend then fetches that
 * transaction and asserts (i) the wallet pubkey is in the signer set
 * and (ii) the memo UTF-8 data equals the canonical nonce — one
 * transaction that proves wallet custody and binds the registration.
 *
 * Why hand-rolled instead of `@solana/web3.js`: the SvelteKit UI
 * deliberately carries a minimal dependency footprint, and a
 * memo-only legacy transaction is a small, well-specified wire
 * format. This module builds exactly that — no transfer, no compute
 * budget, no lookup tables — so the ~120 lines here replace a
 * multi-hundred-KB dependency.
 *
 * Wire format (legacy transaction):
 *   tx      = compact-array(signature[64]) ++ message
 *   message = header[3]
 *          ++ compact-array(accountKey[32])
 *          ++ recentBlockhash[32]
 *          ++ compact-array(instruction)
 *   header  = numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
 *   instr   = programIdIndex:u8 ++ compact-array(accountIndex:u8)
 *          ++ compact-array(dataByte)
 *
 * The transaction is built UNSIGNED — the fee-payer signature slot is
 * 64 zero bytes. Wallet Standard `solana:signAndSendTransaction`
 * fills the real signature in and broadcasts.
 */

import { decodeBase58, encodeBase58 } from './base58.js';

/**
 * SPL Memo program id. Must match `SPL_MEMO_PROGRAM_ID` in the
 * backend `operator-wallet-verification.service.ts` — the backend
 * locates the memo instruction by this exact program id.
 */
export const SPL_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Minimum connected-wallet balance (lamports) required to send the
 * memo transaction: 5000 base fee for one signature + 5000 safety
 * buffer. Fixed by the seed. The UI blocks registration and shows
 * funding guidance below this threshold.
 */
export const FEE_THRESHOLD_LAMPORTS = 10_000;

/** Confirmation timeout for the memo transaction, in seconds. */
export const CONFIRM_TIMEOUT_SECONDS = 30;

/**
 * Decide whether a connected wallet can afford to send the memo
 * transaction. Returns `true` only when `balanceLamports` is at least
 * `FEE_THRESHOLD_LAMPORTS` — at or above the 5000-lamport base fee
 * plus the 5000-lamport safety buffer. The UI gates registration on
 * this: a `false` result blocks the flow and shows funding guidance
 * BEFORE any memo transaction is built or sent.
 */
export function canAffordMemoFee(balanceLamports: number): boolean {
  return Number.isFinite(balanceLamports) && balanceLamports >= FEE_THRESHOLD_LAMPORTS;
}

/** A confirmation level a transaction can reach. */
export type MemoTxCommitment = 'processed' | 'confirmed' | 'finalized';

/**
 * True once a status has reached at least `confirmed` commitment.
 * `finalized` counts — it is strictly stronger than `confirmed`.
 */
export function hasReachedConfirmed(status: MemoTxCommitment | null): boolean {
  return status === 'confirmed' || status === 'finalized';
}

export interface PollUntilConfirmedOptions {
  /** Overall timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Delay between status polls in milliseconds. Default 1.5s. */
  pollIntervalMs?: number;
  /** Injectable clock — defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Pure confirmation-polling loop, decoupled from any RPC transport.
 * Calls `pollStatus` repeatedly until it reports at least `confirmed`
 * commitment or the timeout elapses; resolves `true` on confirmation,
 * `false` on timeout. A throw from `pollStatus` (e.g. an on-chain tx
 * failure) propagates to the caller.
 *
 * The clock and sleep are injectable so the 30-second timeout and the
 * recovery paths can be unit-tested deterministically with no real
 * waiting and no network — this is the dependency-free core that
 * `solana-rpc-client.awaitMemoTxConfirmation` wraps with a real
 * `getSignatureStatuses` call.
 */
export async function pollUntilConfirmed(
  pollStatus: () => Promise<MemoTxCommitment | null>,
  options: PollUntilConfirmedOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? CONFIRM_TIMEOUT_SECONDS * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await pollStatus();
    if (hasReachedConfirmed(status)) return true;
    if (now() >= deadline) return false;
    await sleep(pollIntervalMs);
    if (now() >= deadline) {
      // One last check after the final sleep so a status that landed
      // during the sleep window is not missed.
      return hasReachedConfirmed(await pollStatus());
    }
  }
}

/**
 * Encode an unsigned integer as a Solana compact-u16 ("short vec"
 * length prefix): 7 bits per byte, low byte first, high bit = "more".
 */
function encodeCompactU16(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`compact-u16 out of range: ${value}`);
  }
  const out: number[] = [];
  let remaining = value;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

/**
 * A compact-array of single BYTES: a compact-u16 byte-count prefix
 * followed by the bytes verbatim. Used for the instruction-data and
 * account-index lists, where the count IS the byte count.
 */
function compactByteArray(bytes: readonly number[]): number[] {
  return [...encodeCompactU16(bytes.length), ...bytes];
}

/**
 * A compact-array of fixed-width ELEMENTS: a compact-u16 prefix
 * holding the ELEMENT count, followed by the elements concatenated.
 * Used for the signature list (64-byte elements) and the accountKeys
 * list (32-byte elements) — there the count is the number of
 * elements, NOT the total byte length.
 */
function compactElementArray(elements: readonly Uint8Array[]): number[] {
  const out: number[] = [...encodeCompactU16(elements.length)];
  for (const element of elements) out.push(...element);
  return out;
}

function decode32(label: string, base58: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase58(base58);
  } catch {
    throw new Error(`${label} is not valid base58.`);
  }
  if (bytes.length !== 32) {
    throw new Error(`${label} must decode to 32 bytes (got ${bytes.length}).`);
  }
  return bytes;
}

export interface BuildMemoTransactionArgs {
  /** Fee payer + sole signer — the connected operator wallet. */
  feePayerPubkey: string;
  /** Recent blockhash (base58) from `getLatestBlockhash`. */
  recentBlockhash: string;
  /** Exact canonical-nonce string placed in the SPL Memo instruction. */
  memo: string;
}

/**
 * Build the unsigned memo-only transaction and return its raw bytes,
 * ready to hand to a Wallet Standard `signAndSendTransaction` feature.
 *
 * Account layout: `[feePayer, memoProgram]`.
 *   - feePayer  — signer + writable (header counts it as the 1
 *                 required signature; not readonly).
 *   - memoProgram — non-signer + readonly (the 1 readonly-unsigned).
 * Header is therefore `[1, 0, 1]`. The single instruction references
 * the memo program (index 1) with no account inputs and the memo
 * UTF-8 bytes as data.
 */
export function buildMemoTransaction(args: BuildMemoTransactionArgs): Uint8Array {
  const feePayer = decode32('Connected wallet pubkey', args.feePayerPubkey);
  const memoProgram = decode32('SPL Memo program id', SPL_MEMO_PROGRAM_ID);
  const blockhash = decode32('Recent blockhash', args.recentBlockhash);
  const memoBytes = new TextEncoder().encode(args.memo);

  // Message header — 1 required signature (the fee payer), 0
  // readonly signed accounts, 1 readonly unsigned account (the memo
  // program).
  const header = [1, 0, 1];

  // accountKeys compact-array (element count = 2): fee payer first
  // (signer), memo program second (the program the instruction
  // invokes).
  const accountKeys = compactElementArray([feePayer, memoProgram]);

  // One compiled instruction: programIdIndex=1 (memo program), no
  // account inputs, data = memo bytes.
  const instruction = [
    1, // programIdIndex → accountKeys[1] = memo program
    ...compactByteArray([]), // accounts: empty account-index list
    ...compactByteArray([...memoBytes]), // data: the canonical nonce UTF-8
  ];
  // The instruction list itself is a compact-array of ONE element;
  // its element is the variable-length `instruction` blob above, so
  // emit the element count (1) then the blob.
  const instructions = [...encodeCompactU16(1), ...instruction];

  const message = [...header, ...accountKeys, ...blockhash, ...instructions];

  // Unsigned transaction: a compact-array of exactly ONE 64-byte
  // signature element, all zero — the wallet replaces it on sign.
  const signatures = compactElementArray([new Uint8Array(64)]);

  return Uint8Array.from([...signatures, ...message]);
}

/**
 * Decode the SPL Memo instruction's UTF-8 content out of a memo
 * transaction built by `buildMemoTransaction`. Test/inspection helper
 * — mirrors the backend's memo-extraction so a unit test can assert
 * round-trip equality without an RPC.
 *
 * Returns `null` when the bytes are not a memo transaction in the
 * exact shape this module emits.
 */
export function readMemoFromTransaction(tx: Uint8Array): string | null {
  let offset = 0;
  const readCompactU16 = (): number | null => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = tx[offset];
      if (byte === undefined) return null;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 21) return null;
    }
  };

  const sigCount = readCompactU16();
  if (sigCount === null) return null;
  offset += sigCount * 64; // skip signature slots
  offset += 3; // skip header

  const keyCount = readCompactU16();
  if (keyCount === null) return null;
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i += 1) {
    const slice = tx.slice(offset, offset + 32);
    if (slice.length !== 32) return null;
    keys.push(encodeBase58(slice));
    offset += 32;
  }
  offset += 32; // skip recent blockhash

  const ixCount = readCompactU16();
  if (ixCount === null) return null;
  for (let i = 0; i < ixCount; i += 1) {
    const programIdIndex = tx[offset];
    if (programIdIndex === undefined) return null;
    offset += 1;
    const accountCount = readCompactU16();
    if (accountCount === null) return null;
    offset += accountCount; // skip account indices
    const dataLen = readCompactU16();
    if (dataLen === null) return null;
    const data = tx.slice(offset, offset + dataLen);
    if (data.length !== dataLen) return null;
    offset += dataLen;
    if (keys[programIdIndex] === SPL_MEMO_PROGRAM_ID) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        return null;
      }
    }
  }
  return null;
}
