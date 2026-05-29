import { describe, expect, it } from 'vitest';
import {
  classifyClient,
  clientKindFromValidatorsApp,
  compareVersions,
} from '../../../src/services/client-kind.js';

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

  it('detects sig client across real-world gossip-string shapes', () => {
    // Hyphen-suffixed, vendor-product-string, and space-separated
    // forms all observed in the wild — see SIG_RE comment.
    expect(classifyClient('0.1.0-sig')).toBe('sig');
    expect(classifyClient('solana-sig-validator/0.1.0')).toBe('sig');
    expect(classifyClient('Sig 0.1.0')).toBe('sig');
    // The `sig` token is word-delimited — a substring match must not
    // mis-classify an unrelated string.
    expect(classifyClient('2.0.18-signature-thing')).not.toBe('sig');
  });

  it('classifies hybrid Frankendancer/Jito strings as frankendancer', () => {
    // A `0.x` Frankendancer build carrying a `-jito` marker is still
    // Frankendancer — the `frkd` token wins because FRANKENDANCER_RE
    // is matched before both the JITO and bare-0.x rules.
    expect(classifyClient('0.405.20218-jito-frkd-rc1')).toBe('frankendancer');
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

describe('clientKindFromValidatorsApp', () => {
  // Numeric IDs are the wire format — most authoritative. Every
  // registered ID in `solana-foundation/solana-validator-client-ids`
  // is mapped here; a regression that drops one would silently
  // collapse a real fork into `unknown`.
  it('resolves each canonical numeric ID to its enum slug', () => {
    expect(clientKindFromValidatorsApp({ clientId: 0, clientName: null })).toBe('solana_labs');
    expect(clientKindFromValidatorsApp({ clientId: 1, clientName: null })).toBe('jito_solana');
    expect(clientKindFromValidatorsApp({ clientId: 2, clientName: null })).toBe('frankendancer');
    expect(clientKindFromValidatorsApp({ clientId: 3, clientName: null })).toBe('agave');
    expect(clientKindFromValidatorsApp({ clientId: 4, clientName: null })).toBe('paladin');
    expect(clientKindFromValidatorsApp({ clientId: 5, clientName: null })).toBe('firedancer');
    expect(clientKindFromValidatorsApp({ clientId: 6, clientName: null })).toBe('agave_bam');
    expect(clientKindFromValidatorsApp({ clientId: 7, clientName: null })).toBe('sig');
    expect(clientKindFromValidatorsApp({ clientId: 8, clientName: null })).toBe('rakurai');
    expect(clientKindFromValidatorsApp({ clientId: 9, clientName: null })).toBe(
      'harmonic_firedancer',
    );
    expect(clientKindFromValidatorsApp({ clientId: 10, clientName: null })).toBe('harmonic_agave');
    expect(clientKindFromValidatorsApp({ clientId: 11, clientName: null })).toBe(
      'harmonic_frankendancer',
    );
    expect(clientKindFromValidatorsApp({ clientId: 12, clientName: null })).toBe('firebam');
    expect(clientKindFromValidatorsApp({ clientId: 13, clientName: null })).toBe('raiku');
  });

  it('falls back to the string name when no numeric ID is present', () => {
    // The exact case + spacing combinations validators.app has been
    // observed emitting (lower-case, mixed-case, with spaces).
    expect(
      clientKindFromValidatorsApp({ clientId: null, clientName: 'HarmonicFrankendancer' }),
    ).toBe('harmonic_frankendancer');
    expect(clientKindFromValidatorsApp({ clientId: null, clientName: 'Agave Bam' })).toBe(
      'agave_bam',
    );
    expect(clientKindFromValidatorsApp({ clientId: null, clientName: 'jitolabs' })).toBe(
      'jito_solana',
    );
  });

  it('returns unknown for both fields null', () => {
    expect(clientKindFromValidatorsApp({ clientId: null, clientName: null })).toBe('unknown');
  });

  it('returns unknown for a numeric ID not in the registry yet', () => {
    // A future Foundation-registered client gets ID 14+; the
    // ingester surfaces it but until we update the table we map
    // to `'unknown'` rather than inventing a slug.
    expect(clientKindFromValidatorsApp({ clientId: 999, clientName: null })).toBe('unknown');
  });

  it('falls back to the name when the numeric ID is unknown but the name resolves', () => {
    // validators.app added a new ID before we updated the table,
    // but they also emit a canonical name we already know.
    expect(clientKindFromValidatorsApp({ clientId: 999, clientName: 'HarmonicAgave' })).toBe(
      'harmonic_agave',
    );
  });
});
