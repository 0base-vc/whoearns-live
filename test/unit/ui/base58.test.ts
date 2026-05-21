import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58 } from '../../../ui/src/lib/base58.js';

/**
 * The UI's hand-rolled base58 codec claims to be byte-for-byte
 * compatible with the `bs58` npm package. These tests pin that claim,
 * with special attention to the all-zero / all-'1' edge case that a
 * `[0]`-initialised accumulator gets wrong (a spurious extra
 * most-significant zero digit/byte).
 */
describe('encodeBase58', () => {
  it('encodes an all-zero input without a spurious extra digit', () => {
    // Regression: the buggy codec returned '11' for [0] and '111' for
    // [0,0] — one '1' too many. bs58 returns one '1' per leading zero
    // byte and nothing else.
    expect(encodeBase58(Uint8Array.from([0]))).toBe('1');
    expect(encodeBase58(Uint8Array.from([0, 0]))).toBe('11');
    expect(encodeBase58(Uint8Array.from([0, 0, 0]))).toBe('111');
  });

  it('matches bs58 for all-zero inputs', () => {
    for (let n = 1; n <= 32; n += 1) {
      const input = new Uint8Array(n); // all 0x00
      expect(encodeBase58(input)).toBe(bs58.encode(input));
    }
  });

  it('matches bs58 for the empty input', () => {
    expect(encodeBase58(new Uint8Array(0))).toBe('');
    expect(encodeBase58(new Uint8Array(0))).toBe(bs58.encode(new Uint8Array(0)));
  });

  it('matches bs58 for non-zero and leading-zero-prefixed inputs', () => {
    const cases: Uint8Array[] = [
      Uint8Array.from([1]),
      Uint8Array.from([255]),
      Uint8Array.from([0, 1]),
      Uint8Array.from([0, 0, 255, 1]),
      new Uint8Array(32).fill(7),
      new Uint8Array(64).fill(255),
    ];
    for (const input of cases) {
      expect(encodeBase58(input)).toBe(bs58.encode(input));
    }
  });
});

describe('decodeBase58', () => {
  it('decodes all-"1" input to exactly N zero bytes, not N+1', () => {
    // Regression: the buggy codec returned N+1 bytes for N '1's.
    expect(decodeBase58('1')).toHaveLength(1);
    expect(decodeBase58('11')).toHaveLength(2);
    expect(decodeBase58('1'.repeat(32))).toHaveLength(32);
    expect(Array.from(decodeBase58('1'))).toEqual([0]);
  });

  it('matches bs58 for all-"1" inputs', () => {
    for (let n = 1; n <= 32; n += 1) {
      const input = '1'.repeat(n);
      expect(Array.from(decodeBase58(input))).toEqual(Array.from(bs58.decode(input)));
    }
  });

  it('matches bs58 for the empty input', () => {
    expect(decodeBase58('')).toHaveLength(0);
  });

  it('round-trips encode → decode for all-zero and mixed inputs', () => {
    const cases: Uint8Array[] = [
      Uint8Array.from([0]),
      Uint8Array.from([0, 0]),
      new Uint8Array(32), // all zero
      Uint8Array.from([0, 0, 1, 2, 3]),
      new Uint8Array(64).fill(255),
    ];
    for (const input of cases) {
      expect(Array.from(decodeBase58(encodeBase58(input)))).toEqual(Array.from(input));
    }
  });

  it('matches bs58 for non-"1" inputs', () => {
    const inputs = ['2', 'z', 'StV1DL6CwTryKyV', bs58.encode(new Uint8Array(32).fill(9))];
    for (const value of inputs) {
      expect(Array.from(decodeBase58(value))).toEqual(Array.from(bs58.decode(value)));
    }
  });

  it('throws on a non-base58 character', () => {
    expect(() => decodeBase58('0')).toThrow();
    expect(() => decodeBase58('not-base58!')).toThrow();
  });
});
