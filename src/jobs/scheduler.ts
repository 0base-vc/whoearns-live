import type { Logger } from '../core/logger.js';

export interface Job {
  /** Stable human-readable name used in logs and status reporting. */
  name: string;
  /** Interval between the end of one tick and the start of the next, in ms. */
  intervalMs: number;
  /**
   * Perform one unit of work. Implementations MUST respect `signal` and
   * return promptly when it is aborted.
   */
  tick(signal: AbortSignal): Promise<void>;
}

export interface SchedulerDeps {
  logger: Logger;
}

/**
 * Runs a set of jobs, each on its own interval, in a single process.
 *
 * Design:
 *   - Registration is independent of start; call `register` any number of
 *     times, then `start` once.
 *   - Each job runs in its own `async` loop. A failure in one job's tick
 *     logs and moves on — other jobs are unaffected.
 *   - `stop()` aborts the shared signal and waits for every in-flight tick
 *     to drain (or until the grace deadline elapses). Jobs that don't
 *     cooperate with `signal` will still eventually settle; we never force
 *     a timer-based exit here because the ShutdownManager owns the process
 *     kill-switch.
 */
export class Scheduler {
  private readonly logger: Logger;
  private readonly jobs: Job[] = [];
  private readonly loops: Promise<void>[] = [];
  private controller: AbortController | null = null;
  private started = false;
  private stopped = false;

  constructor(deps: SchedulerDeps) {
    this.logger = deps.logger;
  }

  register(job: Job): void {
    if (this.started) {
      throw new Error('Scheduler: cannot register jobs after start()');
    }
    this.jobs.push(job);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    for (const job of this.jobs) {
      this.loops.push(this.runLoop(job, signal));
    }

    this.logger.info({ jobs: this.jobs.length }, 'scheduler: started');
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    // Wait for every loop to settle. `runLoop` never throws so a plain
    // `Promise.all` is safe here.
    await Promise.all(this.loops);
    this.logger.info('scheduler: stopped');
  }

  /**
   * Job-level loop. Catches everything so one job's failure can never leak
   * into another's loop or into `stop()`.
   */
  private async runLoop(job: Job, signal: AbortSignal): Promise<void> {
    const log = this.logger.child({ job: job.name });
    // First tick runs immediately.
    while (!signal.aborted) {
      try {
        await job.tick(signal);
      } catch (err) {
        log.error({ err }, 'scheduler: tick failed — continuing');
      }
      if (signal.aborted) break;
      try {
        await sleep(job.intervalMs, signal);
      } catch {
        // Aborted during sleep — exit cleanly.
        break;
      }
    }
    log.debug('scheduler: loop exited');
  }
}

/**
 * Promise-returning sleep that rejects if the signal aborts mid-wait.
 *
 * Kept local because `scheduler.ts` is the only caller — if another module
 * grows a need for this, move it to `core/`.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
