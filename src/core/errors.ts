export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('not_found', `${resource} not found: ${id}`, 404, { resource, id });
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, 400, details);
  }
}

export class UpstreamError extends AppError {
  constructor(upstream: string, message: string, details?: Record<string, unknown>) {
    super('upstream_error', `${upstream}: ${message}`, 502, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(upstream: string, retryAfterMs?: number) {
    super(
      'rate_limited',
      `${upstream} rate-limited the request`,
      429,
      retryAfterMs !== undefined ? { upstream, retryAfterMs } : { upstream },
    );
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
