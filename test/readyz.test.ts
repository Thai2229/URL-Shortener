import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createRedis } from '../src/redis.js';
import { usePool } from './helpers/db.js';
import { testRedisUrl, waitFailed, waitReady } from './helpers/redis.js';

const pool = usePool();
const config = loadConfig({});
const apps: ReturnType<typeof buildApp>[] = [];
const closers: (() => unknown)[] = [];
afterAll(async () => {
  for (const a of apps) {
    await a.close();
  }
  for (const c of closers) {
    await c();
  }
});

function make(deps: Parameters<typeof buildApp>[1]) {
  const app = buildApp(config, deps);
  apps.push(app);
  return app;
}

async function ready(app: ReturnType<typeof buildApp>) {
  const start = Date.now();
  const res = await app.inject({ method: 'GET', url: '/readyz' });
  return { res, ms: Date.now() - start };
}

function badPool() {
  const p = new pg.Pool({
    connectionString: 'postgres://u:p@127.0.0.1:1/none',
    connectionTimeoutMillis: 500,
  });
  p.on('error', () => {});
  closers.push(() => p.end());
  return p;
}

describe('GET /readyz', () => {
  it('is ok with postgres and redis up', async () => {
    const redis = createRedis(testRedisUrl());
    closers.push(() => redis.disconnect());
    await waitReady(redis);
    const { res } = await ready(make({ db: pool, redis }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('reports redis disabled when not configured', async () => {
    const { res } = await ready(make({ db: pool }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'disabled' },
    });
  });

  it('is degraded but 200 when redis is down', async () => {
    const redis = createRedis('redis://127.0.0.1:1');
    closers.push(() => redis.disconnect());
    await waitFailed(redis);
    const { res, ms } = await ready(make({ db: pool, redis }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'down' },
    });
    expect(ms).toBeLessThan(150);
  });

  it('returns 503 when postgres is down', async () => {
    const { res } = await ready(make({ db: badPool() }));
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('unavailable');
    expect(body.checks.postgres).toBe('down');
  });

  it('returns 503 when postgres is down even with redis up', async () => {
    const redis = createRedis(testRedisUrl());
    closers.push(() => redis.disconnect());
    await waitReady(redis);
    const { res } = await ready(make({ db: badPool(), redis }));
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.postgres).toBe('down');
  });

  it('is not shadowed by /:code and /healthz still works', async () => {
    const app = make({ db: pool });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.json().error).toBeUndefined();
    expect(res.json().checks).toBeDefined();
    const h = await app.inject({ method: 'GET', url: '/healthz' });
    expect(h.json()).toEqual({ status: 'ok' });
  });
});
