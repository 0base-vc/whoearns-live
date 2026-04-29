import { describe, expect, it } from 'vitest';
import { isValidPubkey, PubkeySchema } from '../../../src/api/schemas/pubkey.js';

describe('isValidPubkey', () => {
  it('accepts a canonical 44-char base58 pubkey', () => {
    const s = 'Vote111111111111111111111111111111111111111'.padEnd(44, '1');
    expect(s).toHaveLength(44);
    expect(isValidPubkey(s)).toBe(true);
  });

  it('accepts a 32-char boundary', () => {
    const s = '1'.repeat(32);
    expect(isValidPubkey(s)).toBe(true);
  });

  it('accepts a 44-char boundary', () => {
    const s = '1'.repeat(44);
    expect(isValidPubkey(s)).toBe(true);
  });

  it('rejects strings shorter than 32 chars', () => {
    expect(isValidPubkey('1'.repeat(31))).toBe(false);
  });

  it('rejects strings longer than 44 chars', () => {
    expect(isValidPubkey('1'.repeat(45))).toBe(false);
  });

  it('rejects strings with excluded base58 characters (0)', () => {
    const bad = '0'.repeat(32);
    expect(isValidPubkey(bad)).toBe(false);
  });

  it('rejects strings with excluded base58 characters (O)', () => {
    const bad = 'O'.repeat(32);
    expect(isValidPubkey(bad)).toBe(false);
  });

  it('rejects strings with excluded base58 characters (I)', () => {
    const bad = 'I'.repeat(32);
    expect(isValidPubkey(bad)).toBe(false);
  });

  it('rejects strings with excluded base58 characters (l)', () => {
    const bad = 'l'.repeat(32);
    expect(isValidPubkey(bad)).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(isValidPubkey(' ' + '1'.repeat(31))).toBe(false);
  });

  it('rejects non-string inputs', () => {
    // @ts-expect-error runtime check
    expect(isValidPubkey(null)).toBe(false);
    // @ts-expect-error runtime check
    expect(isValidPubkey(undefined)).toBe(false);
    // @ts-expect-error runtime check
    expect(isValidPubkey(42)).toBe(false);
  });

  it('rejects punctuation', () => {
    const bad = '1'.repeat(31) + '!';
    expect(isValidPubkey(bad)).toBe(false);
  });
});

describe('PubkeySchema', () => {
  it('parses a valid pubkey', () => {
    const s = 'Vote111111111111111111111111111111111111111';
    expect(PubkeySchema.parse(s)).toBe(s);
  });

  it('fails on bad length', () => {
    const res = PubkeySchema.safeParse('1'.repeat(10));
    expect(res.success).toBe(false);
  });

  it('fails on bad charset', () => {
    const res = PubkeySchema.safeParse('0'.repeat(32));
    expect(res.success).toBe(false);
  });
});
