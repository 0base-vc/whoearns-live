import { z } from 'zod';

/**
 * Solana pubkey alphabet and length bounds.
 *
 * Solana uses base58 (Bitcoin alphabet): digits 1-9 + letters A-Z / a-z minus
 * the visually ambiguous `0`, `O`, `I`, `l`. Pubkeys are 32-byte values, which
 * encode to 32–44 base58 characters depending on the leading-zero count.
 */
const BASE58_CHARSET = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MIN_LEN = 32;
const MAX_LEN = 44;

/** Returns true iff `s` looks like a valid base58-encoded Solana pubkey. */
export function isValidPubkey(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.length < MIN_LEN || s.length > MAX_LEN) return false;
  return BASE58_CHARSET.test(s);
}

/**
 * Zod schema accepting a Solana pubkey as a base58 string with length in
 * `[32, 44]` characters. Any other input is rejected with a 400-worthy error.
 */
export const PubkeySchema = z
  .string()
  .min(MIN_LEN, 'pubkey must be at least 32 characters')
  .max(MAX_LEN, 'pubkey must be at most 44 characters')
  .regex(BASE58_CHARSET, 'pubkey contains non-base58 characters');
