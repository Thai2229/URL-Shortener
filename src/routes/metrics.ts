import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Metrics } from '../metrics.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const metricsRoutes: FastifyPluginAsync<{
  metrics: Metrics;
  token: string | undefined;
}> = async (app, { metrics, token }) => {
  // No rateLimit config: the plugin is not global, so scrapes are never limited.
  app.get('/metrics', async (request, reply) => {
    // Hashing gives equal-length buffers, as timingSafeEqual requires.
    if (
      token &&
      !timingSafeEqual(
        sha256(request.headers.authorization ?? ''),
        sha256(`Bearer ${token}`),
      )
    ) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    }
    return reply
      .header('Content-Type', metrics.register.contentType)
      .send(await metrics.register.metrics());
  });
};
