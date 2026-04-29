import { describe, it, expect } from 'vitest';
import {
  AppError,
  NotFoundError,
  RateLimitedError,
  UpstreamError,
  ValidationError,
  isAppError,
} from '../../../src/core/errors.js';

describe('AppError and subclasses', () => {
  it('AppError defaults statusCode to 500', () => {
    const e = new AppError('x', 'msg');
    expect(e.statusCode).toBe(500);
    expect(e.code).toBe('x');
    expect(e.name).toBe('AppError');
  });

  it('NotFoundError is 404', () => {
    const e = new NotFoundError('validator', 'VoteABC');
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe('not_found');
    expect(e.message).toContain('VoteABC');
    expect(e.details).toEqual({ resource: 'validator', id: 'VoteABC' });
  });

  it('ValidationError is 400', () => {
    const e = new ValidationError('bad', { field: 'epoch' });
    expect(e.statusCode).toBe(400);
    expect(e.details).toEqual({ field: 'epoch' });
  });

  it('UpstreamError is 502', () => {
    const e = new UpstreamError('rpc', 'timeout');
    expect(e.statusCode).toBe(502);
    expect(e.message).toContain('rpc');
    expect(e.message).toContain('timeout');
  });

  it('RateLimitedError is 429', () => {
    const e = new RateLimitedError('rpc', 5000);
    expect(e.statusCode).toBe(429);
    expect(e.details).toEqual({ upstream: 'rpc', retryAfterMs: 5000 });
  });

  it('isAppError identifies subclasses', () => {
    expect(isAppError(new NotFoundError('x', 'y'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('string')).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
