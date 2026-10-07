import { abortable } from '../core/cancellation.js';
import type { Logger } from '../core/logger.js';

export async function withRpcFallback<TFallback, TResult>(args: {
  method: string;
  logger: Logger;
  fallback: TFallback | undefined;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  runPrimary: () => Promise<TResult>;
  runFallback: (fallback: TFallback) => Promise<TResult>;
}): Promise<TResult> {
  args.signal?.throwIfAborted();
  try {
    return await abortable(args.runPrimary(), args.signal);
  } catch (err) {
    args.signal?.throwIfAborted();
    if (args.fallback === undefined) {
      throw err;
    }
    args.logger.warn(
      { err, method: args.method, ...(args.context ?? {}) },
      'solana-rpc primary request failed, retrying with fallback',
    );
    return abortable(args.runFallback(args.fallback), args.signal);
  }
}
