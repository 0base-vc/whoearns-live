import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isAppError, ValidationError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

interface ErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

function makePayload(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorPayload {
  const inner: ErrorPayload['error'] = { code, message, requestId };
  if (details !== undefined) {
    inner.details = details;
  }
  return { error: inner };
}

/**
 * Install the project-wide Fastify error handler.
 *
 * - `AppError` subclasses (ours) are surfaced with their `code`, `statusCode`,
 *   `message`, and optional `details`.
 * - Zod errors — which fall through here only if zod was invoked inside a
 *   handler without being re-thrown as a `ValidationError` — are mapped to 400
 *   with `code: 'validation_error'`.
 * - Fastify's own validation errors (from attached JSON schemas, if any) are
 *   similarly mapped to 400.
 * - Everything else is a 500 with `code: 'internal_error'`; the original
 *   message is logged but not echoed to the client.
 */
export function setErrorHandler(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (isAppError(error)) {
      logger.warn(
        { err: error, requestId, code: error.code, statusCode: error.statusCode },
        'api: handled app error',
      );
      reply
        .code(error.statusCode)
        .send(makePayload(error.code, error.message, requestId, error.details));
      return;
    }

    if (error instanceof ZodError) {
      const ve = new ValidationError('request validation failed', {
        issues: error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
      logger.warn({ err: ve, requestId }, 'api: zod validation error');
      reply.code(ve.statusCode).send(makePayload(ve.code, ve.message, requestId, ve.details));
      return;
    }

    // Fastify's own JSON-schema validation error: `error.validation` is set.
    if (error.validation) {
      const ve = new ValidationError('request validation failed', {
        issues: error.validation.map((v) => ({
          instancePath: v.instancePath,
          message: v.message,
          keyword: v.keyword,
        })),
      });
      logger.warn({ err: ve, requestId }, 'api: fastify schema validation error');
      reply.code(400).send(makePayload(ve.code, ve.message, requestId, ve.details));
      return;
    }

    // 4xx errors thrown by Fastify itself (e.g. body-too-large, unsupported
    // media type) arrive here with a numeric `statusCode` already set. We
    // echo their message but don't dignify them with a custom code.
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      logger.warn(
        { err: error, requestId, statusCode: error.statusCode },
        'api: client error from fastify',
      );
      reply
        .code(error.statusCode)
        .send(makePayload(error.code ?? 'client_error', error.message, requestId));
      return;
    }

    logger.error({ err: error, requestId }, 'api: unhandled error');
    reply.code(500).send(makePayload('internal_error', 'internal server error', requestId));
  });
}
