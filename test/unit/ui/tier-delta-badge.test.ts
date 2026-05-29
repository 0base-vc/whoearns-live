import { describe, expect, it } from 'vitest';
import { tierDeltaBadge } from '../../../ui/src/lib/tier.js';
import type { NodeTierTrend } from '../../../ui/src/lib/types.js';

/*
 * tierDeltaBadge (H4) — pure helper that turns the backend `tier.trend`
 * block into the hub's composite delta badge. The voice rule on this
 * surface is "state the movement, never coach it", so the helper only
 * emits a direction glyph + signed magnitude (+ an optional tier
 * transition) — no imperative copy. These tests pin:
 *
 *   - the three direction tones (up / down / flat)
 *   - the unicode minus on negative deltas (typographic alignment)
 *   - the tier-transition append rule (only when the tier changed)
 *   - the two "show nothing" cases: null trend (brand-new validator)
 *     and null delta (one composite unmeasurable — never fabricate ±0)
 */

const BASE_TREND: NodeTierTrend = {
  prevComposite: 80,
  delta: 0,
  prevTier: 'anvil',
  epochsTracked: 4,
};

describe('tierDeltaBadge — direction tones', () => {
  it('renders an up badge for a positive delta', () => {
    const badge = tierDeltaBadge('forge', { ...BASE_TREND, delta: 3, prevTier: 'forge' });
    expect(badge).not.toBeNull();
    expect(badge?.tone).toBe('up');
    expect(badge?.arrow).toBe('▲');
    expect(badge?.deltaLabel).toBe('+3');
  });

  it('renders a down badge for a negative delta with a unicode minus', () => {
    const badge = tierDeltaBadge('anvil', { ...BASE_TREND, delta: -2, prevTier: 'anvil' });
    expect(badge?.tone).toBe('down');
    expect(badge?.arrow).toBe('▼');
    // U+2212 MINUS SIGN, not an ASCII hyphen-minus.
    expect(badge?.deltaLabel).toBe('−2');
    expect(badge?.deltaLabel).not.toContain('-');
  });

  it('renders a flat badge for a zero delta', () => {
    const badge = tierDeltaBadge('anvil', { ...BASE_TREND, delta: 0, prevTier: 'anvil' });
    expect(badge?.tone).toBe('flat');
    expect(badge?.arrow).toBe('±');
    expect(badge?.deltaLabel).toBe('0');
  });
});

describe('tierDeltaBadge — tier transition', () => {
  it('appends the transition when the tier changed', () => {
    const badge = tierDeltaBadge('forge', { ...BASE_TREND, delta: 16, prevTier: 'anvil' });
    expect(badge?.transition).toBe('anvil → forge');
  });

  it('omits the transition when the tier is unchanged', () => {
    const badge = tierDeltaBadge('anvil', { ...BASE_TREND, delta: 3, prevTier: 'anvil' });
    expect(badge?.transition).toBeNull();
  });

  it('omits the transition when prevTier is null even if the delta is non-zero', () => {
    const badge = tierDeltaBadge('anvil', { ...BASE_TREND, delta: 5, prevTier: null });
    expect(badge).not.toBeNull();
    expect(badge?.transition).toBeNull();
  });
});

describe('tierDeltaBadge — show-nothing cases', () => {
  it('returns null when trend is null (brand-new validator)', () => {
    expect(tierDeltaBadge('anvil', null)).toBeNull();
  });

  it('returns null when trend is undefined (pre-trend API response)', () => {
    expect(tierDeltaBadge('anvil', undefined)).toBeNull();
  });

  it('returns null when delta is null (one composite unmeasurable — no fabricated ±0)', () => {
    expect(tierDeltaBadge('anvil', { ...BASE_TREND, delta: null })).toBeNull();
  });
});
