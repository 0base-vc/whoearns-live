import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { pino } from 'pino';
import { ShutdownManager } from '../../../src/core/shutdown.js';

describe('ShutdownManager', () => {
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: string | number | null | undefined,
    ): never => {
      return undefined as never;
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  const silentLogger = pino({ level: 'silent' });

  it('runs hooks in reverse (LIFO) order', async () => {
    const order: string[] = [];
    const mgr = new ShutdownManager({ timeoutMs: 5000, logger: silentLogger, signals: [] });
    mgr.register('a', () => {
      order.push('a');
    });
    mgr.register('b', () => {
      order.push('b');
    });
    mgr.register('c', () => {
      order.push('c');
    });
    await mgr.trigger('test');
    expect(order).toEqual(['c', 'b', 'a']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('continues on hook error', async () => {
    const order: string[] = [];
    const mgr = new ShutdownManager({ timeoutMs: 5000, logger: silentLogger, signals: [] });
    mgr.register('ok1', () => {
      order.push('ok1');
    });
    mgr.register('bad', () => {
      throw new Error('boom');
    });
    mgr.register('ok2', () => {
      order.push('ok2');
    });
    await mgr.trigger('test');
    expect(order).toEqual(['ok2', 'ok1']);
  });

  it('is idempotent', async () => {
    const fn = vi.fn();
    const mgr = new ShutdownManager({ timeoutMs: 5000, logger: silentLogger, signals: [] });
    mgr.register('x', fn);
    await mgr.trigger('first');
    await mgr.trigger('second');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exposes isShuttingDown', async () => {
    const mgr = new ShutdownManager({ timeoutMs: 5000, logger: silentLogger, signals: [] });
    expect(mgr.isShuttingDown).toBe(false);
    await mgr.trigger('x');
    expect(mgr.isShuttingDown).toBe(true);
  });

  it('supports async hooks', async () => {
    const calls: string[] = [];
    const mgr = new ShutdownManager({ timeoutMs: 5000, logger: silentLogger, signals: [] });
    mgr.register('async', async () => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push('done');
    });
    await mgr.trigger('test');
    expect(calls).toEqual(['done']);
  });
});
