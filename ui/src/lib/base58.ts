/**
 * Dependency-free Bitcoin-alphabet base58 codec.
 *
 * The operator-wallet memo-tx flow needs base58 in the browser to:
 *   - render a connected wallet's pubkey (`operator-wallet-discovery`);
 *   - serialise a wallet pubkey into a hand-built memo transaction
 *     and decode tx signatures (`operator-wallet-memo-tx`).
 *
 * The Node backend uses the `bs58` npm package, but the SvelteKit UI
 * deliberately carries no `bs58` dependency — and the wallet-discovery
 * module is intentionally dependency-free. This tiny codec keeps the
 * UI free of an extra runtime dependency for ~30 lines of well-known
 * arithmetic. It is byte-for-byte compatible with `bs58` (same
 * alphabet, same leading-zero handling).
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Reverse lookup: codepoint → value. Index 255 (an impossible base58
// char value) marks "not a base58 character".
const ALPHABET_MAP: Int8Array = (() => {
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    map[ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

/** Encode raw bytes as a base58 string. */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Big-endian base-256 → base-58 conversion. `digits` holds the
  // base-58 result little-endian; the final string reverses it.
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = (digits[i] ?? 0) * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  // Each leading 0x00 byte encodes to a leading '1'.
  let encoded = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded += ALPHABET[0];
  }
  // Emit the numeric part without most-significant zero digits — for
  // an all-zero input the numeric part is empty and the leading '1's
  // above are the entire encoding (matches bs58 / base-x).
  let hi = digits.length - 1;
  while (hi >= 0 && digits[hi] === 0) hi -= 1;
  for (let i = hi; i >= 0; i -= 1) {
    encoded += ALPHABET[digits[i] ?? 0];
  }
  return encoded;
}

/**
 * Decode a base58 string to raw bytes. Throws on any non-base58
 * character — callers that want a soft failure should catch.
 */
export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);

  // base-58 → base-256 conversion, mirror of `encodeBase58`.
  const bytes: number[] = [0];
  for (const char of value) {
    const code = char.charCodeAt(0);
    const carryStart = code < 128 ? (ALPHABET_MAP[code] ?? -1) : -1;
    if (carryStart < 0) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    let carry = carryStart;
    for (let i = 0; i < bytes.length; i += 1) {
      const acc = (bytes[i] ?? 0) * 58 + carry;
      bytes[i] = acc & 0xff;
      carry = acc >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Each leading '1' decodes to a leading 0x00 byte.
  let leadingZeros = 0;
  for (const char of value) {
    if (char !== ALPHABET[0]) break;
    leadingZeros += 1;
  }

  // Drop the most-significant zero bytes of the computed value — for
  // an all-'1' input the value is 0 and the leading 0x00 bytes above
  // are the entire decoding (matches bs58 / base-x).
  let hi = bytes.length - 1;
  while (hi > 0 && bytes[hi] === 0) hi -= 1;
  const valueLen = hi === 0 && bytes[0] === 0 ? 0 : hi + 1;
  const out = new Uint8Array(leadingZeros + valueLen);
  for (let i = 0; i < valueLen; i += 1) {
    out[leadingZeros + i] = bytes[valueLen - 1 - i] ?? 0;
  }
  return out;
}
