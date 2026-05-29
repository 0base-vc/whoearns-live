import { describe, expect, it } from 'vitest';
import {
  computeGovernance,
  computeOperatorActivityIndex,
} from '../../../src/services/operator-activity-index.js';

describe('computeGovernance', () => {
  it('returns 0 for no signal', () => {
    const r = computeGovernance({ commentCount: 0, reactionsReceived: 0, activeWindowCount: 0 });
    expect(r.score).toBe(0);
  });

  it('saturates so a prolific commenter does not get 100', () => {
    const r = computeGovernance({
      commentCount: 200,
      reactionsReceived: 500,
      activeWindowCount: 100,
    });
    // Even an extreme commenter shouldn't hit 100 — the saturation
    // function tops out below 100 by design.
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThan(80);
  });

  it('weights active-window comments higher', () => {
    const stale = computeGovernance({
      commentCount: 10,
      reactionsReceived: 0,
      activeWindowCount: 0,
    });
    const live = computeGovernance({
      commentCount: 10,
      reactionsReceived: 0,
      activeWindowCount: 10,
    });
    expect(live.score).toBeGreaterThan(stale.score);
  });

  it('passes component counts through to result', () => {
    const r = computeGovernance({
      commentCount: 7,
      reactionsReceived: 12,
      activeWindowCount: 3,
    });
    expect(r.components.commentCount).toBe(7);
    expect(r.components.reactionsReceived).toBe(12);
    expect(r.components.activeWindowCount).toBe(3);
  });
});

describe('computeOperatorActivityIndex', () => {
  it('returns null composite when both halves have no signal', () => {
    const r = computeOperatorActivityIndex({
      governance: { commentCount: 0, reactionsReceived: 0, activeWindowCount: 0 },
      wallet: { activeDaysLast90: 0 },
    });
    expect(r.composite).toBeNull();
  });

  it('composites both halves when both have signal', () => {
    const r = computeOperatorActivityIndex({
      governance: { commentCount: 5, reactionsReceived: 10, activeWindowCount: 2 },
      wallet: { activeDaysLast90: 30 },
    });
    expect(r.composite).not.toBeNull();
    expect(r.composite!).toBeGreaterThan(0);
    expect(r.composite!).toBeLessThanOrEqual(100);
  });

  it('returns governance-only composite when wallet is dormant', () => {
    const r = computeOperatorActivityIndex({
      governance: { commentCount: 20, reactionsReceived: 50, activeWindowCount: 10 },
      wallet: { activeDaysLast90: 0 },
    });
    expect(r.composite).not.toBeNull();
    expect(r.walletScore).toBe(0);
    expect(r.governance.score).toBeGreaterThan(0);
  });

  it('treats lingering reactions (zero comments) as governance signal', () => {
    // A validator whose comments were deleted but whose peer reactions
    // linger still has governance signal — `hasGovernanceSignal` must
    // check `reactionsReceived` too, not `commentCount` alone, or the
    // composite would wrongly null out.
    const r = computeOperatorActivityIndex({
      governance: { commentCount: 0, reactionsReceived: 8, activeWindowCount: 0 },
      wallet: { activeDaysLast90: 0 },
    });
    expect(r.composite).not.toBeNull();
    expect(r.governance.score).toBeGreaterThan(0);
  });

  it('caps wallet score at 100 even with many active days', () => {
    const r = computeOperatorActivityIndex({
      governance: { commentCount: 0, reactionsReceived: 0, activeWindowCount: 0 },
      wallet: { activeDaysLast90: 90 },
    });
    expect(r.walletScore).toBeGreaterThan(70);
    expect(r.walletScore).toBeLessThanOrEqual(100);
  });
});
