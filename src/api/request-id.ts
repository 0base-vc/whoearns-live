import type { FastifyInstance } from 'fastify';

/**
 * Add an `onSend` hook that copies `request.id` (which Fastify always generates)
 * to the `x-request-id` response header.
 *
 * This lets clients correlate a response back to a server-side log line, and
 * plays well with load-balancer / APM request-id conventions.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    if (!reply.hasHeader('x-request-id')) {
      reply.header('x-request-id', request.id);
    }
  });
}
