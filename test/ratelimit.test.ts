import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRedis } from '../src/redis.js';
import { uniqueCode, usePool } from './helpers/db.js';
import { testConfig } from './helpers/config.js';
import {
  testRedisUrl,
  useRedis,
  waitFailed,
  waitReady,
} from './helpers/redis.js';

type App = ReturnType<typeof buildApp>;

const pool = usePool();
const raw = useRedis();
const appRedis = createRedis(testRedisUrl());
const deadRedis = createRedis('redis://127.0.0.1:1');
const apps: App[] = [];
const usedIps: string[] = [];

beforeAll(async () => {
  await waitReady(appRedis);
  await waitFailed(deadRedis);
});
afterAll(async () => {
  for (const a of apps) {
    await a.close();
  }
  // Delete only keys belonging to this file's unique client IPs.
  for (const ip of usedIps) {
    const keys = await raw.keys(`rl:*${ip}*`);
    if (keys.length > 0) {
      await raw.del(...keys);
    }
  }
  appRedis.disconnect();
  deadRedis.disconnect();
});

function randomIp() {
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  usedIps.push(ip);
  return ip;
}

const SMALL = {
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_CREATE_MAX: '3',
  RATE_LIMIT_REDIRECT_MAX: '4',
  RATE_LIMIT_READ_MAX: '5',
};

function make(
  env: Record<string, string> = {},
  redis: typeof appRedis | undefined = appRedis,
) {
  const app = buildApp(testConfig({ ...SMALL, ...env }), { db: pool, redis });
  apps.push(app);
  return app;
}

function create(app: App, ip: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/links',
    remoteAddress: ip,
    headers,
    payload: { url: 'https://example.com/rl' },
  });
}

function redirect(app: App, ip: string, code = uniqueCode('rl')) {
  return app.inject({ method: 'GET', url: `/${code}`, remoteAddress: ip });
}

function read(app: App, ip: string, code = uniqueCode('rl')) {
  return app.inject({
    method: 'GET',
    url: `/api/links/${code}`,
    remoteAddress: ip,
  });
}

describe('rate limiting', () => {
  it('allows createMax creates then returns 429 in the app error format', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      expect((await create(app, ip)).statusCode).toBe(201);
    }
    const res = await create(app, ip);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(typeof res.json().error.message).toBe('string');
    expect(Object.keys(res.json())).toEqual(['error']);
  });

  it('sends an integer Retry-After >= 1 on 429', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      await create(app, ip);
    }
    const res = await create(app, ip);
    expect(res.statusCode).toBe(429);
    const retry = String(res.headers['retry-after']);
    expect(retry).toMatch(/^\d+$/);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
    expect(Number(retry)).toBeLessThanOrEqual(60);
  });

  it('adds ratelimit headers to successful responses', async () => {
    const app = make();
    const ip = randomIp();
    const first = await create(app, ip);
    expect(first.statusCode).toBe(201);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');
    expect(Number(first.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    const second = await create(app, ip);
    expect(second.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('limits GET /:code to redirectMax', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 4; i++) {
      expect((await redirect(app, ip)).statusCode).toBe(404);
    }
    const res = await redirect(app, ip);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('limits GET /api/links/:code to readMax', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 5; i++) {
      expect((await read(app, ip)).statusCode).toBe(404);
    }
    const res = await read(app, ip);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('keeps a separate bucket per route', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      await create(app, ip);
    }
    expect((await create(app, ip)).statusCode).toBe(429);
    expect((await redirect(app, ip)).statusCode).toBe(404);
    expect((await read(app, ip)).statusCode).toBe(404);
  });

  it('keeps a separate bucket per client IP', async () => {
    const app = make();
    const a = randomIp();
    const b = randomIp();
    for (let i = 0; i < 3; i++) {
      await create(app, a);
    }
    expect((await create(app, a)).statusCode).toBe(429);
    expect((await create(app, b)).statusCode).toBe(201);
  });

  it('never limits /healthz or /readyz', async () => {
    const app = make({
      RATE_LIMIT_CREATE_MAX: '1',
      RATE_LIMIT_REDIRECT_MAX: '1',
      RATE_LIMIT_READ_MAX: '1',
    });
    const ip = randomIp();
    for (let i = 0; i < 10; i++) {
      const h = await app.inject({
        method: 'GET',
        url: '/healthz',
        remoteAddress: ip,
      });
      expect(h.statusCode).toBe(200);
      const r = await app.inject({
        method: 'GET',
        url: '/readyz',
        remoteAddress: ip,
      });
      expect(r.statusCode).toBe(200);
    }
  });

  it('does not rate limit when disabled', async () => {
    const app = make({ RATE_LIMIT_ENABLED: 'false' });
    const ip = randomIp();
    for (let i = 0; i < 6; i++) {
      const res = await create(app, ip);
      expect(res.statusCode).toBe(201);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
      expect(res.headers['x-ratelimit-reset']).toBeUndefined();
    }
  });

  it('allows requests again after the window resets', async () => {
    const app = make({ RATE_LIMIT_WINDOW_SECONDS: '1' });
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      await create(app, ip);
    }
    expect((await create(app, ip)).statusCode).toBe(429);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await create(app, ip)).statusCode).toBe(201);
  });
});

describe('shared state across instances', () => {
  it('enforces one limit between two apps sharing Redis', async () => {
    const other = createRedis(testRedisUrl());
    await waitReady(other);
    const a = make();
    const b = buildApp(testConfig(SMALL), { db: pool, redis: other });
    apps.push(b);
    const ip = randomIp();
    expect((await create(a, ip)).statusCode).toBe(201);
    expect((await create(b, ip)).statusCode).toBe(201);
    expect((await create(a, ip)).statusCode).toBe(201);
    expect((await create(b, ip)).statusCode).toBe(429);
    await b.close();
    other.disconnect();
  });
});

describe('Redis unavailable', () => {
  it('falls back to an in-memory limiter without added latency', async () => {
    const app = make({}, deadRedis);
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      const start = Date.now();
      const res = await create(app, ip);
      expect(res.statusCode).toBe(201);
      expect(Date.now() - start).toBeLessThan(150);
    }
    const start = Date.now();
    const res = await create(app, ip);
    expect(Date.now() - start).toBeLessThan(150);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('falls back when no redis client is passed', async () => {
    const app = make({}, undefined);
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      expect((await create(app, ip)).statusCode).toBe(201);
    }
    expect((await create(app, ip)).statusCode).toBe(429);
  });
});

describe('trustProxy', () => {
  it('ignores a spoofed X-Forwarded-For when TRUST_PROXY is unset', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      const res = await create(app, ip, { 'x-forwarded-for': `1.2.3.${i}` });
      expect(res.statusCode).toBe(201);
    }
    const res = await create(app, ip, { 'x-forwarded-for': '9.9.9.9' });
    expect(res.statusCode).toBe(429);
  });

  it('buckets by X-Forwarded-For client IP when TRUST_PROXY=true', async () => {
    const app = make({ TRUST_PROXY: 'true' });
    const proxy = randomIp();
    const clientA = randomIp();
    const clientB = randomIp();
    for (let i = 0; i < 3; i++) {
      const res = await create(app, proxy, { 'x-forwarded-for': clientA });
      expect(res.statusCode).toBe(201);
    }
    expect(
      (await create(app, proxy, { 'x-forwarded-for': clientA })).statusCode,
    ).toBe(429);
    expect(
      (await create(app, proxy, { 'x-forwarded-for': clientB })).statusCode,
    ).toBe(201);
  });
});
