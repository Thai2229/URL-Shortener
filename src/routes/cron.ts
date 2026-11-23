import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ClickCounter } from '../clicks.js';
import { sha256 } from './metrics.js';

export const cronRoutes: FastifyPluginAsync<{
  clicks: ClickCounter | undefined;
  secret: string;
}> = async (app, { clicks, secret }) => {
  // No rateLimit config: the plugin is not global, so cron calls are never limited.
  app.get('/api/cron/flush', async (request, reply) => {
    if (
      !timingSafeEqual(
        sha256(request.headers.authorization ?? ''),
        sha256(`Bearer ${secret}`),
      )
    ) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    }
    const flushed = (await clicks?.flush()) ?? null;
    return { flushed };
  });
};
