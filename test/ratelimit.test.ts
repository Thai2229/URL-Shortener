import { randomInt } from 'node:crypto';
import { normalizeIP } from '@fastify/rate-limit';
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
    const app = make({ RATE_LIMIT_WINDOW_SECONDS: '2' });
    const ip = randomIp();
    for (let i = 0; i < 3; i++) {
      await create(app, ip);
    }
    const blocked = await create(app, ip);
    expect(blocked.statusCode).toBe(429);
    const retry = Number(blocked.headers['retry-after']);
    const reset = Number(blocked.headers['x-ratelimit-reset']);
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(2);
    expect(reset).toBeGreaterThanOrEqual(1);
    await new Promise((r) =>
      setTimeout(r, Math.max(retry, reset) * 1000 + 100),
    );
    expect((await create(app, ip)).statusCode).toBe(201);
  }, 15000);
});

function randomV6Prefix() {
  const hex = () => randomInt(0x10000).toString(16);
  return `2001:db8:${hex()}:${hex()}`;
}

describe('IPv6 and mapped address normalization', () => {
  it('shares one bucket across a /64', async () => {
    const app = make({ RATE_LIMIT_REDIRECT_MAX: '3' });
    const prefix = randomV6Prefix();
    usedIps.push(normalizeIP(`${prefix}::1`, 64));
    const codes: number[] = [];
    for (let i = 1; i <= 8; i++) {
      codes.push((await redirect(app, `${prefix}::${i}`)).statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([404, 404, 404]);
    expect(codes.slice(3)).toEqual([429, 429, 429, 429, 429]);
  });

  it('keeps separate buckets for different /64s', async () => {
    const app = make({ RATE_LIMIT_REDIRECT_MAX: '3' });
    const a = randomV6Prefix();
    const b = randomV6Prefix();
    usedIps.push(normalizeIP(`${a}::1`, 64), normalizeIP(`${b}::1`, 64));
    for (let i = 0; i < 3; i++) {
      await redirect(app, `${a}::1`);
    }
    expect((await redirect(app, `${a}::2`)).statusCode).toBe(429);
    expect((await redirect(app, `${b}::1`)).statusCode).toBe(404);
  });

  it('shares a bucket between an IPv4-mapped address and the IPv4', async () => {
    const app = make({ RATE_LIMIT_REDIRECT_MAX: '3' });
    const v4 = randomIp();
    expect((await redirect(app, v4)).statusCode).toBe(404);
    expect((await redirect(app, `::ffff:${v4}`)).statusCode).toBe(404);
    expect((await redirect(app, v4)).statusCode).toBe(404);
    expect((await redirect(app, `::ffff:${v4}`)).statusCode).toBe(429);
  });
});

describe('client-chosen keys under TRUST_PROXY=true', () => {
  const garbage = [
    () => `zz1:/:link:${uniqueCode('abc')}`,
    () => `zz${'Q/:'.repeat(1700)}${uniqueCode('g')}`,
  ];

  it.each(garbage)(
    'falls back to the socket address for invalid XFF',
    async (mk) => {
      const app = make({ TRUST_PROXY: 'true', RATE_LIMIT_REDIRECT_MAX: '3' });
      const ip = randomIp();
      const sent: string[] = [];
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) {
        const value = `${i}${mk()}`;
        sent.push(value);
        const res = await app.inject({
          method: 'GET',
          url: `/${uniqueCode('rl')}`,
          remoteAddress: ip,
          headers: { 'x-forwarded-for': value },
        });
        codes.push(res.statusCode);
      }
      expect(codes.slice(0, 3)).not.toContain(429);
      expect(codes[3]).toBe(429);
      const keys = await raw.keys('rl:*');
      const leaked = keys.filter(
        (k) => k.includes('zz') || sent.some((v) => k.includes(v)),
      );
      if (leaked.length > 0) {
        await raw.del(...leaked);
      }
      expect(leaked).toEqual([]);
    },
  );
});

describe('in-memory fallback bounds', () => {
  it('stays fast and bounded under a flood of distinct IPs and keeps enforcing', async () => {
    const app = make({ RATE_LIMIT_CREATE_MAX: '3' }, deadRedis);
    const fixed = randomIp();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const start = Date.now();
    for (let i = 0; i < 25000; i++) {
      const ip = `10.${200 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`;
      await app.inject({
        method: 'POST',
        url: '/api/links',
        remoteAddress: ip,
        payload: {},
      });
    }
    expect(Date.now() - start).toBeLessThan(5000);
    if (global.gc) {
      global.gc();
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(
        60 * 1024 * 1024,
      );
    }
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await create(app, fixed)).statusCode);
    }
    expect(codes.slice(0, 3)).not.toContain(429);
    expect(codes[3]).toBe(429);
  }, 60000);
});

describe('unmatched routes', () => {
  it('limits 404s to readMax with the standard 429 format', async () => {
    const app = make();
    const ip = randomIp();
    const other = randomIp();
    for (let i = 0; i < 5; i++) {
      const url = '/a/b/c/d';
      const res = await app.inject({ method: 'GET', url, remoteAddress: ip });
      expect(res.statusCode).toBe(404);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/a/b/c/d',
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(Object.keys(res.json())).toEqual(['error']);
    expect(String(res.headers['retry-after'])).toMatch(/^\d+$/);
    const post = await app.inject({
      method: 'POST',
      url: '/api/nothing',
      remoteAddress: ip,
    });
    expect(post.statusCode).toBe(429);
    const fresh = await app.inject({
      method: 'GET',
      url: '/a/b/c/d',
      remoteAddress: other,
    });
    expect(fresh.statusCode).toBe(404);
  });

  it('limits POST to an unknown path after readMax requests', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/nothing',
        remoteAddress: ip,
      });
      expect(res.statusCode).toBe(404);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/nothing',
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('keeps /healthz and /readyz unlimited', async () => {
    const app = make();
    const ip = randomIp();
    for (let i = 0; i < 12; i++) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/healthz',
            remoteAddress: ip,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'GET', url: '/readyz', remoteAddress: ip }))
          .statusCode,
      ).toBe(200);
    }
  });
});

describe('counter without TTL', () => {
  it('repairs a key that has no expiry', async () => {
    const app = make();
    const ip = randomIp();
    const key = `rl:/api/links:${ip}`;
    await raw.set(key, '100');
    expect(await raw.ttl(key)).toBe(-1);
    const res = await create(app, ip);
    expect(res.statusCode).toBe(429);
    const retry = String(res.headers['retry-after']);
    expect(retry).toMatch(/^\d+$/);
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
    expect(await raw.pttl(key)).toBeGreaterThan(0);
    await raw.del(key);
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
