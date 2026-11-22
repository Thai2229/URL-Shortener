import Fastify from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { linksRoutes } from './routes/links.js';

export function buildApp(config: Config, deps: { db: pg.Pool }) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: config.logLevel },
  });
  // Fastify parses text/plain by default; only JSON is accepted here (else 415).
  app.removeContentTypeParser('text/plain');
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'Not found' } }),
  );
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
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
  app.register(healthRoutes);
  app.register(linksRoutes, { config, db: deps.db });
  return app;
}
