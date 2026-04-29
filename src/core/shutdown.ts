import type { Logger } from 'pino';

export type ShutdownHook = () => Promise<void> | void;

export interface ShutdownManagerOptions {
  timeoutMs: number;
  logger: Logger;
  signals?: NodeJS.Signals[];
}

/**
 * Coordinates graceful shutdown. Hooks run in reverse registration order (LIFO),
 * each with its own timeout budget. Guaranteed to call `process.exit` after the
 * overall timeout even if a hook hangs.
 */
export class ShutdownManager {
  private readonly hooks: Array<{ name: string; fn: ShutdownHook }> = [];
  private shuttingDown = false;
  private readonly signals: NodeJS.Signals[];

  constructor(private readonly opts: ShutdownManagerOptions) {
    this.signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
  }

  register(name: string, fn: ShutdownHook): void {
    this.hooks.push({ name, fn });
  }

  install(): void {
    for (const sig of this.signals) {
      process.on(sig, () => {
        void this.trigger(sig);
      });
    }
    process.on('uncaughtException', (err) => {
      this.opts.logger.fatal({ err }, 'uncaughtException');
      void this.trigger('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
      this.opts.logger.fatal({ reason }, 'unhandledRejection');
      void this.trigger('unhandledRejection', 1);
    });
  }

  async trigger(reason: string, exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = this.opts.logger.child({ shutdownReason: reason });
    log.info({ hooks: this.hooks.length }, 'shutdown:start');

    const forceExit = setTimeout(() => {
      log.error('shutdown:forced-exit (timeout)');
      process.exit(exitCode || 1);
    }, this.opts.timeoutMs);
    forceExit.unref();

    for (const hook of [...this.hooks].reverse()) {
      try {
        log.debug({ hook: hook.name }, 'shutdown:hook:run');
        await hook.fn();
        log.debug({ hook: hook.name }, 'shutdown:hook:done');
      } catch (err) {
        log.error({ err, hook: hook.name }, 'shutdown:hook:error');
      }
    }

    clearTimeout(forceExit);
    log.info('shutdown:complete');
    process.exit(exitCode);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
