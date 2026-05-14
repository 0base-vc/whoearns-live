import { describe, expect, it } from 'vitest';
import { CACHE_TIERS, NO_STORE, cacheControl } from '../../../src/api/cache-control.js';

describe('cacheControl', () => {
  it('renders a public Cache-Control header for each tier', () => {
    expect(cacheControl('SCORING')).toBe('public, max-age=300, s-maxage=1800');
    expect(cacheControl('CATALOGUE')).toBe('public, max-age=600, s-maxage=3600');
    expect(cacheControl('IMMUTABLE_ASSET')).toBe('public, max-age=3600, s-maxage=86400');
    expect(cacheControl('REALTIME')).toBe('public, max-age=30, s-maxage=60');
  });

  it('always emits public — the API has no per-caller responses', () => {
    for (const tier of Object.keys(CACHE_TIERS) as Array<keyof typeof CACHE_TIERS>) {
      expect(cacheControl(tier).startsWith('public, ')).toBe(true);
    }
  });
});

describe('CACHE_TIERS invariants', () => {
  it('keeps sMaxAge >= maxAge for every tier — the CDN never expires before the client', () => {
    for (const [name, tier] of Object.entries(CACHE_TIERS)) {
      expect(tier.sMaxAge, `${name}: sMaxAge must be >= maxAge`).toBeGreaterThanOrEqual(
        tier.maxAge,
      );
    }
  });

  it('uses strictly positive durations', () => {
    for (const [name, tier] of Object.entries(CACHE_TIERS)) {
      expect(tier.maxAge, `${name}.maxAge`).toBeGreaterThan(0);
      expect(tier.sMaxAge, `${name}.sMaxAge`).toBeGreaterThan(0);
    }
  });

  it('orders the tiers by lifetime: REALTIME < SCORING < CATALOGUE < IMMUTABLE_ASSET', () => {
    expect(CACHE_TIERS.REALTIME.maxAge).toBeLessThan(CACHE_TIERS.SCORING.maxAge);
    expect(CACHE_TIERS.SCORING.maxAge).toBeLessThan(CACHE_TIERS.CATALOGUE.maxAge);
    expect(CACHE_TIERS.CATALOGUE.maxAge).toBeLessThan(CACHE_TIERS.IMMUTABLE_ASSET.maxAge);
  });
});

describe('NO_STORE', () => {
  it('is the literal no-store directive', () => {
    expect(NO_STORE).toBe('no-store');
  });
});
