import type { Logger } from '../core/logger.js';

export async function withRpcFallback<TFallback, TResult>(args: {
  method: string;
  logger: Logger;
  fallback: TFallback | undefined;
  context?: Record<string, unknown>;
  runPrimary: () => Promise<TResult>;
  runFallback: (fallback: TFallback) => Promise<TResult>;
}): Promise<TResult> {
  try {
    return await args.runPrimary();
  } catch (err) {
    if (args.fallback === undefined) {
      throw err;
    }
    args.logger.warn(
      { err, method: args.method, ...(args.context ?? {}) },
      'solana-rpc primary request failed, retrying with fallback',
    );
    return args.runFallback(args.fallback);
  }
}
