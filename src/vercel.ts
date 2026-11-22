import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachDatabasePool, waitUntil } from '@vercel/functions';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { buildApp } from './app.js';
import { createClickCounter } from './clicks.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createMetrics } from './metrics.js';
import { createRedis } from './redis.js';

export function createServerless(opts: {
  env: NodeJS.ProcessEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
  attachDatabasePool?: (pool: pg.Pool) => void;
  db?: pg.Pool;
  redis?: Redis;
  clickPrefix?: string;
}) {
  const config = loadConfig(opts.env);
  let db = opts.db;
  let redis = opts.redis;
  const ownsDb = db === undefined;
  const ownsRedis = redis === undefined && config.redisUrl !== undefined;
  if (!db) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required');
    }
    // Instances share 1,024 file descriptors on Vercel, so default to a small pool.
    let env = opts.env;
    if (env.VERCEL === '1' && !env.PG_POOL_MAX) {
      env = { ...env, PG_POOL_MAX: '5' };
    }
    db = createPool(config.databaseUrl, env);
    opts.attachDatabasePool?.(db);
  }
  if (!redis && config.redisUrl) {
    // Not attached: attachDatabasePool rejects ioredis clients (it expects node-redis's options.socket).
    redis = createRedis(config.redisUrl, opts.env);
  }
  const metrics = createMetrics({ db, redis });
  const clicks = createClickCounter({
    redis,
    db,
    prefix: opts.clickPrefix,
    metrics,
  });
  const app = buildApp(config, { db, redis, clicks, metrics });
  const intervalMs = config.clickFlushIntervalSeconds * 1000;
  if (redis && intervalMs > 0 && opts.waitUntil) {
    const keepAlive = opts.waitUntil;
    // onSend runs while the response is still open, so the function is kept alive for the flush.
    app.addHook('onSend', async (_request, reply, payload) => {
      if (reply.statusCode === 302) {
        keepAlive(clicks.flushIfDue(intervalMs));
      }
      return payload;
    });
  }
  async function handler(req: IncomingMessage, res: ServerResponse) {
    await app.ready();
    app.server.emit('request', req, res);
  }
  async function close() {
    await app.close();
    if (ownsRedis) {
      await redis?.quit().catch(() => redis?.disconnect());
    }
    if (ownsDb) {
      await db?.end();
    }
  }
  return { app, handler, close };
}

let instance: ReturnType<typeof createServerless> | undefined;

export default function handler(req: IncomingMessage, res: ServerResponse) {
  instance ??= createServerless({
    env: process.env,
    waitUntil,
    attachDatabasePool,
  });
  return instance.handler(req, res);
}
