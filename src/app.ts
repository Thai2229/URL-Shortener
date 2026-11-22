import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { ClickCounter } from './clicks.js';
import type { Config } from './config.js';
import type { Metrics } from './metrics.js';
import { registerRateLimit } from './ratelimit.js';
import { cronRoutes } from './routes/cron.js';
import { healthRoutes } from './routes/health.js';
import { linksRoutes } from './routes/links.js';
import { metricsRoutes } from './routes/metrics.js';

export function buildApp(
  config: Config,
  deps: {
    db: pg.Pool;
    redis?: Redis;
    clicks?: ClickCounter;
    metrics?: Metrics;
    logStream?: Writable;
  },
) {
  const { metrics } = deps;
  // Log the path only: query strings can carry secrets. Headers are never logged.
  const serializers = {
    req: (req: {
      method?: string;
      url?: string;
      hostname?: string;
      ip?: string;
      socket?: { remotePort?: number };
    }) => ({
      method: req.method,
      url: (req.url ?? '').split('?')[0],
      hostname: req.hostname,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }),
  };
  let logger: boolean | object = false;
  if (deps.logStream) {
    logger = { level: 'info', stream: deps.logStream, serializers };
  } else if (process.env.NODE_ENV !== 'test') {
    logger = { level: config.logLevel, serializers };
  }
  // Fastify 5.12 treats a numeric trustProxy as "trust nobody"; spell the hop count out.
  let trustProxy: Config['trustProxy'] | ((a: string, hop: number) => boolean) =
    config.trustProxy;
  if (typeof trustProxy === 'number') {
    const hops = trustProxy;
    trustProxy = (_a: string, hop: number) => hop < hops;
  }
  const app = Fastify({
    logger,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (
        typeof incoming === 'string' &&
        /^[A-Za-z0-9._-]{1,64}$/.test(incoming)
      ) {
        return incoming;
      }
      return randomUUID();
    },
    trustProxy: trustProxy as boolean,
  });
  // Fastify parses text/plain by default; only JSON is accepted here (else 415).
  app.removeContentTypeParser('text/plain');
  const notFound = (_request: unknown, reply: FastifyReply) =>
    reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'Not found' } });
  // Route pattern for metric labels; never the raw URL (bounded cardinality).
  const routeLabel = (request: {
    is404: boolean;
    routeOptions: { url?: string };
  }) => {
    if (request.is404) {
      return 'unmatched';
    }
    return request.routeOptions.url ?? 'unmatched';
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  if (metrics) {
    app.addHook('onResponse', async (request, reply) => {
      metrics.observeRequest(
        request.method,
        routeLabel(request),
        reply.statusCode,
        reply.elapsedTime / 1000,
      );
    });
  }
  app.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    if (err.statusCode === 429) {
      metrics?.rateLimited(routeLabel(request));
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
    // app.rateLimit exists once the plugin has loaded; unmatched routes share the read limit.
    app.after(() =>
      app.setNotFoundHandler(
        { preHandler: app.rateLimit({ max: config.rateLimit.readMax }) },
        notFound,
      ),
    );
  } else {
    app.setNotFoundHandler(notFound);
  }
  app.register(healthRoutes, { db: deps.db, redis: deps.redis });
  app.register(linksRoutes, {
    config,
    db: deps.db,
    redis: deps.redis,
    clicks: deps.clicks,
    metrics,
  });
  if (config.metricsEnabled && metrics) {
    app.register(metricsRoutes, { metrics, token: config.metricsToken });
  }
  if (config.cronSecret) {
    app.register(cronRoutes, {
      clicks: deps.clicks,
      secret: config.cronSecret,
    });
  }
  return app;
}
