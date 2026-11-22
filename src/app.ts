import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Config } from './config.js';
import { registerRateLimit } from './ratelimit.js';
import { healthRoutes } from './routes/health.js';
import { linksRoutes } from './routes/links.js';

export function buildApp(config: Config, deps: { db: pg.Pool; redis?: Redis }) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: config.logLevel },
    // Fastify accepts a hop count at runtime; its types omit the number form.
    trustProxy: config.trustProxy as boolean,
  });
  // Fastify parses text/plain by default; only JSON is accepted here (else 415).
  app.removeContentTypeParser('text/plain');
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'Not found' } }),
  );
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    if (err.statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'rate_limited', message: 'Too many requests' },
      });
    }
    // Client errors (bad JSON, unsupported content type, ...) keep their status.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: { code: 'bad_request', message: 'Invalid request' },
      });
    }
    request.log.error(err);
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
  // Must be registered before the routes so their per-route limits are picked up.
  if (config.rateLimit.enabled) {
    registerRateLimit(app, {
      redis: deps.redis,
      windowSeconds: config.rateLimit.windowSeconds,
    });
  }
  app.register(healthRoutes, { db: deps.db, redis: deps.redis });
  app.register(linksRoutes, { config, db: deps.db, redis: deps.redis });
  return app;
}
