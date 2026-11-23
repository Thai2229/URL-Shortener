import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createClickCounter } from '../src/clicks.js';
import { insertLink } from '../src/db/links.js';
import { createMetrics } from '../src/metrics.js';
import { testConfig } from './helpers/config.js';
import { uniqueCode, usePool } from './helpers/db.js';

const pool = usePool();
const apps: ReturnType<typeof buildApp>[] = [];
afterAll(async () => {
  for (const a of apps) {
    await a.close();
  }
});

const SECRET = 'cron-secret-0123456789';
function make(env: Record<string, string> = {}, db: pg.Pool = pool) {
  const app = buildApp(
    testConfig({ BASE_URL: 'http://short.test', CRON_SECRET: SECRET, ...env }),
    { db, metrics: createMetrics({ db }), clicks: createClickCounter({ db }) },
  );
  apps.push(app);
  return app;
}
const app = make();
const randomIp = () =>
  `100.${64 + Math.floor(Math.random() * 60)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

describe('x-content-type-options: nosniff', () => {
  it('is on a 201 and the metadata API', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/links',
      payload: { url: 'https://example.com/n' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-content-type-options']).toBe('nosniff');
    const meta = await app.inject({
      method: 'GET',
      url: `/api/links/${created.json().code}`,
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is on a redirect, a link 404 and an unmatched 404', async () => {
    const code = uniqueCode('nh');
    await insertLink(pool, { code, targetUrl: 'https://example.com/nh' });
    const redirect = await app.inject({ method: 'GET', url: `/${code}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers['x-content-type-options']).toBe('nosniff');
    const missing = await app.inject({
      method: 'GET',
      url: `/${uniqueCode('nx')}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
    const unmatched = await app.inject({ method: 'GET', url: '/no/such' });
    expect(unmatched.statusCode).toBe(404);
    expect(unmatched.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is on 400, 415 and bad-percent-encoding errors', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/links',
      payload: { url: 'http://127.0.0.1/' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['x-content-type-options']).toBe('nosniff');
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.headers['x-content-type-options']).toBe('nosniff');
    const badUrl = await app.inject({ method: 'GET', url: '/%ff' });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is on a 429', async () => {
    const limited = make({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_READ_MAX: '1',
    });
    const ip = randomIp();
    const send = () =>
      limited.inject({
        method: 'GET',
        url: '/api/links/abc',
        remoteAddress: ip,
      });
    await send();
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is on a 500', async () => {
    const broken = {
      query: async () => {
        throw new Error('db down');
      },
    } as unknown as pg.Pool;
    const res = await make({}, broken).inject({
      method: 'GET',
      url: '/api/links/abc',
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is on /healthz, /metrics and the cron route', async () => {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['x-content-type-options']).toBe('nosniff');
    const cron = await app.inject({
      method: 'GET',
      url: '/api/cron/flush',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(cron.statusCode).toBe(200);
    expect(cron.headers['x-content-type-options']).toBe('nosniff');
    const denied = await app.inject({ method: 'GET', url: '/api/cron/flush' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('bad percent-encoding in the path', () => {
  it.each(['/%ff', '/%', '/api/links/%zz'])(
    'GET %s gives the standard 400 without echoing the path',
    async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: { code: 'bad_request', message: 'Invalid request' },
      });
      expect(res.body).not.toContain(url);
      expect(res.body).not.toContain('%zz');
      expect(res.body).not.toContain('FST_');
      expect(res.headers['x-request-id']).toBeTruthy();
    },
  );
});
