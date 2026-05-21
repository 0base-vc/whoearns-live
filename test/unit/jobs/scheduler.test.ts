import { describe, it, expect, vi, afterEach } from 'vitest';
import { pino } from 'pino';
import { Scheduler, type Job } from '../../../src/jobs/scheduler.js';

const silent = pino({ level: 'silent' });

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Helper: returns a promise that resolves on the next microtask flush.
 * Used alongside `vi.advanceTimersByTimeAsync` to let in-flight job ticks
 * complete before making assertions.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe('Scheduler', () => {
  it('runs the first tick immediately on start', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const job: Job = { name: 'j1', intervalMs: 1_000, tick };
    const sched = new Scheduler({ logger: silent });
    sched.register(job);
    sched.start();
    await flushMicrotasks();
    expect(tick).toHaveBeenCalledTimes(1);
    await sched.stop();
  });

  it('waits initialDelayMs before the first tick when set', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const job: Job = { name: 'delayed', intervalMs: 1_000, initialDelayMs: 5_000, tick };
    const sched = new Scheduler({ logger: silent });
    sched.register(job);
    sched.start();
    await flushMicrotasks();
    // Nothing yet — still inside the initial delay.
    expect(tick).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(tick).toHaveBeenCalledTimes(0);

    // First tick fires once the initial delay elapses.
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);

    // Then the regular interval takes over.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    await sched.stop();
  });

  it('staggered jobs do not delay an immediate-first-tick sibling', async () => {
    vi.useFakeTimers();
    const immediateTick = vi.fn(async () => {});
    const delayedTick = vi.fn(async () => {});
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'immediate', intervalMs: 1_000, tick: immediateTick });
    sched.register({
      name: 'delayed',
      intervalMs: 1_000,
      initialDelayMs: 3_000,
      tick: delayedTick,
    });
    sched.start();
    await flushMicrotasks();
    // The job that opted out of staggering still ticks at second 0.
    expect(immediateTick).toHaveBeenCalledTimes(1);
    expect(delayedTick).toHaveBeenCalledTimes(0);
    await sched.stop();
  });

  it('stop during the initial delay exits cleanly without ticking', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'delayed', intervalMs: 1_000, initialDelayMs: 10_000, tick });
    sched.start();
    await flushMicrotasks();
    await sched.stop();
    // Even after time well past the initial delay, the tick never ran.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(0);
  });

  it('runs subsequent ticks on interval', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'j1', intervalMs: 1_000, tick });
    sched.start();
    await flushMicrotasks();
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tick).toHaveBeenCalledTimes(4);
    await sched.stop();
  });

  it('per-tick errors are logged and do not kill the loop', async () => {
    vi.useFakeTimers();
    let count = 0;
    const tick = vi.fn(async () => {
      count += 1;
      if (count === 1) throw new Error('boom');
    });
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'err-job', intervalMs: 500, tick });
    sched.start();
    await flushMicrotasks();
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(3);
    await sched.stop();
  });

  it('one job failing does not impact a sibling job', async () => {
    vi.useFakeTimers();
    const goodTick = vi.fn(async () => {});
    const badTick = vi.fn(async () => {
      throw new Error('boom');
    });
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'good', intervalMs: 500, tick: goodTick });
    sched.register({ name: 'bad', intervalMs: 500, tick: badTick });
    sched.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(goodTick).toHaveBeenCalledTimes(3);
    expect(badTick).toHaveBeenCalledTimes(3);
    await sched.stop();
  });

  it('stop aborts the loop and waits for in-flight ticks', async () => {
    vi.useFakeTimers();
    let resolveTick: ((v: void) => void) | null = null;
    let tickStarted = false;
    const tick = vi.fn(async (signal: AbortSignal) => {
      tickStarted = true;
      void signal;
      await new Promise<void>((r) => {
        resolveTick = r;
      });
    });
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'slow', intervalMs: 100, tick });
    sched.start();
    await flushMicrotasks();
    expect(tickStarted).toBe(true);

    const stopP = sched.stop();
    // stop() should not resolve until we let the tick finish.
    resolveTick!();
    await stopP;
    // After stop, no further ticks even if time advances.
    const callsBefore = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick.mock.calls.length).toBe(callsBefore);
  });

  it('stop is idempotent', async () => {
    vi.useFakeTimers();
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'j', intervalMs: 100, tick: vi.fn(async () => {}) });
    sched.start();
    await flushMicrotasks();
    await sched.stop();
    await sched.stop();
  });

  it('stop before start is a no-op', async () => {
    const sched = new Scheduler({ logger: silent });
    await sched.stop(); // shouldn't throw
  });

  it('rejects registration after start', () => {
    const sched = new Scheduler({ logger: silent });
    sched.start();
    expect(() => sched.register({ name: 'late', intervalMs: 10, tick: async () => {} })).toThrow(
      /after start/,
    );
    void sched.stop();
  });

  it('start is idempotent', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const sched = new Scheduler({ logger: silent });
    sched.register({ name: 'j', intervalMs: 100, tick });
    sched.start();
    sched.start();
    await flushMicrotasks();
    expect(tick).toHaveBeenCalledTimes(1);
    await sched.stop();
  });
});
