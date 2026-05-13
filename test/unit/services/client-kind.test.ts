import { describe, expect, it } from 'vitest';
import { classifyClient, compareVersions } from '../../../src/services/client-kind.js';

describe('classifyClient', () => {
  it('classifies plain semver Agave releases', () => {
    expect(classifyClient('2.0.18')).toBe('agave');
    expect(classifyClient('1.18.22')).toBe('agave');
  });

  it('detects Jito-Solana by suffix marker', () => {
    expect(classifyClient('2.0.18-jito-1')).toBe('jito_solana');
    expect(classifyClient('1.18.22-jito')).toBe('jito_solana');
  });

  it('detects Firedancer by 0.x major version', () => {
    expect(classifyClient('0.405.20218')).toBe('firedancer');
    expect(classifyClient('0.420.0')).toBe('firedancer');
  });

  it('detects Frankendancer ahead of the bare 0.x rule', () => {
    expect(classifyClient('0.405.20218-frkd')).toBe('frankendancer');
    expect(classifyClient('0.420.0-frankendancer')).toBe('frankendancer');
  });

  it('detects Paladin / Sig variants', () => {
    expect(classifyClient('2.0.0-paladin')).toBe('paladin');
    expect(classifyClient('sig-0.1.0')).toBe('sig');
  });

  it('returns unknown for null / empty / unrecognised strings', () => {
    expect(classifyClient(null)).toBe('unknown');
    expect(classifyClient(undefined)).toBe('unknown');
    expect(classifyClient('')).toBe('unknown');
    expect(classifyClient('   ')).toBe('unknown');
    expect(classifyClient('nonsense')).toBe('unknown');
  });

  it('trims whitespace before classifying', () => {
    expect(classifyClient('  2.0.18  ')).toBe('agave');
    expect(classifyClient('\n0.405.20218\n')).toBe('firedancer');
  });
});

describe('compareVersions', () => {
  it('orders semver-ish versions numerically', () => {
    expect(compareVersions('2.0.18', '2.0.19')).toBe(-1);
    expect(compareVersions('2.0.19', '2.0.18')).toBe(1);
    expect(compareVersions('2.0.18', '2.0.18')).toBe(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(compareVersions('2', '2.0.1')).toBe(-1);
  });

  it('handles Firedancer-style longer versions', () => {
    expect(compareVersions('0.405.20218', '0.405.20219')).toBe(-1);
    expect(compareVersions('0.405.20218-jito-1', '0.405.20218-jito-2')).toBe(-1);
  });
});
