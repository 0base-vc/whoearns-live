import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { setErrorHandler } from '../../../src/api/error-handler.js';
import { AppError, NotFoundError } from '../../../src/core/errors.js';
import { makeTestApp } from './_fakes.js';

const silent = pino({ level: 'silent' });

describe('setErrorHandler', () => {
  it('serialises AppError with statusCode/code/message/details', async () => {
    const app = makeTestApp(silent);
    setErrorHandler(app, silent);
    app.get('/boom', async () => {
      throw new NotFoundError('thing', 'xyz');
    });

    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as {
      error: { code: string; message: string; requestId: string; details?: unknown };
    };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('thing');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.details).toEqual({ resource: 'thing', id: 'xyz' });
    await app.close();
  });

  it('maps ZodError to 400 validation_error with issues', async () => {
    const app = makeTestApp(silent);
    setErrorHandler(app, silent);
    app.get('/zod', async () => {
      z.object({ x: z.string() }).parse({ x: 42 });
      return 'unreachable';
    });

    const res = await app.inject({ method: 'GET', url: '/zod' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: { code: string; details?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('validation_error');
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
    await app.close();
  });

  it('maps an AppError without details to a payload without details', async () => {
    const app = makeTestApp(silent);
    setErrorHandler(app, silent);
    app.get('/partial', async () => {
      throw new AppError('teapot', 'I am a teapot', 418);
    });

    const res = await app.inject({ method: 'GET', url: '/partial' });
    expect(res.statusCode).toBe(418);
    const body = res.json() as { error: { code: string; details?: unknown } };
    expect(body.error).not.toHaveProperty('details');
    expect(body.error.code).toBe('teapot');
    await app.close();
  });

  it('maps Fastify schema validation errors to 400', async () => {
    const app = makeTestApp(silent);
    setErrorHandler(app, silent);
    app.post(
      '/v',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
          },
        },
      },
      async () => 'ok',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v',
      payload: { other: 'x' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
    await app.close();
  });

  it('maps a raw non-app 4xx error to its statusCode', async () => {
    const app = makeTestApp(silent);
    setErrorHandler(app, silent);
    app.get('/bad-request', async (_request, reply) => {
      const err = new Error('too large') as Error & { statusCode?: number; code?: string };
      err.statusCode = 413;
      err.code = 'FST_ERR_CTP_BODY_TOO_LARGE';
      void reply; // suppress unused
      throw err;
    });

    const res = await app.inject({ method: 'GET', url: '/bad-request' });
    expect(res.statusCode).toBe(413);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
    expect(body.error.message).toBe('too large');
    await app.close();
  });

  it('maps unknown errors to 500 internal_error', async () => {
    const app = makeTestApp(silent);
    setErrorHandler(app, silent);
    app.get('/crash', async () => {
      throw new Error('kaboom');
    });

    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('internal server error');
    await app.close();
  });
});
