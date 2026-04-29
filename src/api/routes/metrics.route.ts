import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { registry } from '../metrics.js';

/**
 * `GET /metrics` — Prometheus scrape endpoint.
 *
 * No bearer-token auth: this route is only ever registered on a
 * dedicated, cluster-internal port (see `METRICS_PORT` in
 * `config.ts` and the second-listener code in `server.ts`). The
 * public Ingress routes only the main API port; the metrics port
 * stays reachable only from inside the K8s cluster (Prometheus
 * scraper, kubectl port-forward, etc.).
 *
 * If you need to expose metrics on the same public port as the
 * API (e.g. when deploying outside K8s with no internal network),
 * fork this route to add bearer-token auth before doing so.
 */
const metricsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/metrics', async (_request, reply) => {
    const body = await registry.metrics();
    return reply.type(registry.contentType).header('cache-control', 'no-store').send(body);
  });
};

export default metricsRoutes;
