import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { isReady } from '../cache.js';
import { sha256 } from './metrics.js';

const CHECK_TIMEOUT_MS = 1000;

async function check(probe: () => Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([probe(), timeout]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export const healthRoutes: FastifyPluginAsync<{
  db: pg.Pool;
  redis?: Redis;
  vercel?: boolean;
  token?: string;
}> = async (app, { db, redis, vercel, token }) => {
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Public Vercel deployments expose /readyz only behind the bearer token.
  if (vercel && !token) {
    return;
  }

  app.get('/readyz', async (request, reply) => {
    if (
      vercel &&
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
    let redisCheck = Promise.resolve('disabled');
    if (redis) {
      redisCheck = Promise.resolve('down');
      if (isReady(redis)) {
        redisCheck = check(() => redis.ping());
      }
    }
    const [postgres, redisStatus] = await Promise.all([
      check(() => db.query('SELECT 1')),
      redisCheck,
    ]);
    const checks = { postgres, redis: redisStatus };
    if (postgres !== 'ok') {
      return reply.code(503).send({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  });
};
