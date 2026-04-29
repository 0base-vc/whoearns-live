import { describe, it, expect } from 'vitest';
import {
  lamportsToSol,
  lamportsToString,
  solToLamports,
  toLamports,
  LAMPORTS_PER_SOL,
} from '../../../src/core/lamports.js';

describe('toLamports', () => {
  it('passes through bigint', () => {
    expect(toLamports(1_234n)).toBe(1_234n);
  });
  it('converts integer number', () => {
    expect(toLamports(42)).toBe(42n);
  });
  it('parses decimal string integer', () => {
    expect(toLamports('123456789')).toBe(123_456_789n);
  });
  it('rejects non-integer number', () => {
    expect(() => toLamports(1.5)).toThrow(RangeError);
  });
  it('rejects non-digit string', () => {
    expect(() => toLamports('1.5')).toThrow(RangeError);
    expect(() => toLamports('abc')).toThrow(RangeError);
  });
  it('handles negative strings', () => {
    expect(toLamports('-100')).toBe(-100n);
  });
});

describe('lamportsToSol', () => {
  it('converts exactly 1 SOL', () => {
    expect(lamportsToSol(LAMPORTS_PER_SOL)).toBe('1');
  });
  it('converts zero', () => {
    expect(lamportsToSol(0n)).toBe('0');
  });
  it('trims trailing zeros', () => {
    expect(lamportsToSol(1_500_000_000n)).toBe('1.5');
  });
  it('preserves up to 9 fractional digits', () => {
    expect(lamportsToSol(1_000_000_001n)).toBe('1.000000001');
  });
  it('handles sub-SOL values', () => {
    expect(lamportsToSol(1n)).toBe('0.000000001');
    expect(lamportsToSol(123_456n)).toBe('0.000123456');
  });
  it('handles very large values without precision loss', () => {
    const huge = LAMPORTS_PER_SOL * 10_000_000n + 123n;
    expect(lamportsToSol(huge)).toBe('10000000.000000123');
  });
  it('handles negatives', () => {
    expect(lamportsToSol(-LAMPORTS_PER_SOL)).toBe('-1');
  });
});

describe('lamportsToString', () => {
  it('returns null for null', () => {
    expect(lamportsToString(null)).toBeNull();
  });
  it('stringifies bigint', () => {
    expect(lamportsToString(12345n)).toBe('12345');
  });
});

describe('solToLamports', () => {
  it('converts "1" to LAMPORTS_PER_SOL', () => {
    expect(solToLamports('1')).toBe(LAMPORTS_PER_SOL);
  });
  it('converts fractional SOL', () => {
    expect(solToLamports('0.5')).toBe(500_000_000n);
    expect(solToLamports('1.000000001')).toBe(1_000_000_001n);
  });
  it('handles zero', () => {
    expect(solToLamports('0')).toBe(0n);
    expect(solToLamports('0.0')).toBe(0n);
  });
  it('rejects more than 9 fractional digits', () => {
    expect(() => solToLamports('0.1234567890')).toThrow(RangeError);
  });
  it('rejects non-numeric', () => {
    expect(() => solToLamports('abc')).toThrow(RangeError);
  });
  it('round-trips', () => {
    const original = 7_123_456_789n;
    expect(solToLamports(lamportsToSol(original))).toBe(original);
  });
});
