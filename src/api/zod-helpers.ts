import { ValidationError } from '../core/errors.js';

/**
 * Canonical Zod-safeParse unwrap, shared by every route file.
 *
 * Turns a `.safeParse` failure into a `ValidationError` so it
 * surfaces through the central error handler with a consistent
 * `validation_error` code + context message, rather than leaking a
 * raw `ZodError`. On success it returns the parsed data unchanged.
 *
 * Previously copy-pasted inline in each route file "until we have
 * >2 call sites" — we now have six, so it lives here.
 */
export function unwrap<T>(
  result: { success: true; data: T } | { success: false; error: unknown },
  context: string,
): T {
  if (result.success) return result.data;
  throw new ValidationError(`${context} failed validation`, {
    issues: (result.error as { issues?: unknown[] }).issues ?? [result.error],
  });
}
