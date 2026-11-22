import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { findLinkByCode } from '../src/db/links.js';
import { createRedis } from '../src/redis.js';
import { createServerless } from '../src/vercel.js';
import { testDatabaseUrl, usePool } from './helpers/db.js';
import { testRedisUrl, waitReady } from './helpers/redis.js';

const pool = usePool();
const redis = createRedis(testRedisUrl());
let prefixes: string[] = [];
const cleanups: Array<() => Promise<unknown> | unknown> = [];

beforeAll(() => waitReady(redis));
afterAll(() => redis.quit());
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
  for (const p of prefixes) {
    await redis.del(p, `${p}:processing`, `${p}:lock`, `${p}:due`);
  }
  prefixes = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function randomIp() {
  const n = () => 1 + Math.floor(Math.random() * 250);
  return `100.${64 + (n() % 60)}.${n()}.${n()}`;
}

async function start(
  env: Record<string, string> = {},
  extra: { redis?: typeof redis | null } = {},
) {
  const clickPrefix = `test-vercel-${randomBytes(6).toString('hex')}`;
  prefixes.push(clickPrefix);
  const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
  const opts: Parameters<typeof createServerless>[0] = {
    env: {
      DATABASE_URL: testDatabaseUrl(),
      RATE_LIMIT_ENABLED: 'false',
      CLICK_FLUSH_INTERVAL_SECONDS: '1',
      ...env,
    },
    waitUntil,
    db: pool,
    clickPrefix,
  };
  if (extra.redis !== null) {
    opts.redis = extra.redis ?? redis;
  }
  const s = createServerless(opts);
  const server = http.createServer(s.handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    await new Promise((r) => server.close(r));
    await s.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { s, waitUntil, base, clickPrefix };
}

async function create(base: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ url: 'https://example.com/v' }),
  });
}

describe('createServerless', () => {
  it('throws a clear error without a database URL', () => {
    expect(() => createServerless({ env: {} })).toThrow(/DATABASE_URL/);
  });

  it('returns app, handler and close, and never listens', async () => {
    const s = createServerless({
      env: { DATABASE_URL: testDatabaseUrl(), RATE_LIMIT_ENABLED: 'false' },
      db: pool,
    });
    const listen = vi.spyOn(s.app, 'listen');
    expect(typeof s.handler).toBe('function');
    expect(typeof s.close).toBe('function');
    await s.app.ready();
    expect(listen).not.toHaveBeenCalled();
    await s.close();
  });

  it('serves /healthz with an x-request-id header', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('creates its own pool and redis from env and closes them', async () => {
    const s = createServerless({
      env: {
        DATABASE_URL: testDatabaseUrl(),
        REDIS_URL: testRedisUrl(),
        RATE_LIMIT_ENABLED: 'false',
      },
    });
    const server = http.createServer(s.handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    await new Promise((r) => server.close(r));
    await expect(s.close()).resolves.not.toThrow();
  });

  it('does not close injected pool or redis', async () => {
    const { s } = await start();
    await s.close();
    expect((await pool.query('select 1 as one')).rows[0].one).toBe(1);
    expect(await redis.ping()).toBe('PONG');
  });

  it('falls back to KV_URL for redis', async () => {
    const s = createServerless({
      env: {
        DATABASE_URL: testDatabaseUrl(),
        KV_URL: testRedisUrl(),
        RATE_LIMIT_ENABLED: 'false',
      },
      db: pool,
    });
    await s.app.ready();
    await s.close();
  });
});

describe('request flow over HTTP', () => {
  it('creates, redirects, flushes via waitUntil', async () => {
    const { base, waitUntil } = await start();
    const created = await create(base);
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    expect(waitUntil).not.toHaveBeenCalled();

    const res = await fetch(`${base}/${code}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/v');

    for (let i = 0; i < 50 && waitUntil.mock.calls.length === 0; i++) {
      await sleep(20);
    }
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const promise = waitUntil.mock.calls[0]![0];
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toEqual({ codes: 1, clicks: 1 });
    expect((await findLinkByCode(pool, code))?.clickCount).toBe(1);
  });

  it('calls waitUntil once per 302 and never for other statuses', async () => {
    const { base, waitUntil } = await start();
    const { code } = (await (await create(base)).json()) as { code: string };
    expect(
      (await fetch(`${base}/api/links/nope_${randomBytes(4).toString('hex')}`))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/nope_${randomBytes(4).toString('hex')}`)).status,
    ).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    await sleep(100);
    expect(waitUntil).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      expect(
        (await fetch(`${base}/${code}`, { redirect: 'manual' })).status,
      ).toBe(302);
    }
    for (let i = 0; i < 50 && waitUntil.mock.calls.length < 2; i++) {
      await sleep(20);
    }
    await sleep(100);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    // second one is throttled per instance: resolves to null, no double count
    await Promise.all(waitUntil.mock.calls.map((c) => c[0]));
    expect((await findLinkByCode(pool, code))?.clickCount).toBe(1);
  });

  it('does not call waitUntil when the interval is 0', async () => {
    const { base, waitUntil } = await start({
      CLICK_FLUSH_INTERVAL_SECONDS: '0',
    });
    const { code } = (await (await create(base)).json()) as { code: string };
    expect(
      (await fetch(`${base}/${code}`, { redirect: 'manual' })).status,
    ).toBe(302);
    expect((await fetch(`${base}/api/links/${code}`)).status).toBe(200);
    await sleep(150);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('does not call waitUntil without redis', async () => {
    const { base, waitUntil } = await start({}, { redis: null });
    const { code } = (await (await create(base)).json()) as { code: string };
    expect(
      (await fetch(`${base}/${code}`, { redirect: 'manual' })).status,
    ).toBe(302);
    expect((await fetch(`${base}/api/links/${code}`)).status).toBe(200);
    await sleep(150);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe('trusting X-Forwarded-For on Vercel', () => {
  it('rate limits by the forwarded address', async () => {
    const { base } = await start({
      VERCEL: '1',
      VERCEL_ENV: 'production',
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_CREATE_MAX: '2',
    });
    const ip = randomIp();
    const other = randomIp();
    expect((await create(base, { 'x-forwarded-for': ip })).status).toBe(201);
    expect((await create(base, { 'x-forwarded-for': ip })).status).toBe(201);
    expect((await create(base, { 'x-forwarded-for': ip })).status).toBe(429);
    expect((await create(base, { 'x-forwarded-for': other })).status).toBe(201);
  });

  it('ignores X-Forwarded-For without VERCEL or TRUST_PROXY', async () => {
    const { base } = await start({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_CREATE_MAX: '1',
    });
    // Same socket address for both: the second is limited despite different headers.
    const first = await create(base, { 'x-forwarded-for': randomIp() });
    const second = await create(base, { 'x-forwarded-for': randomIp() });
    expect(first.status === 201 || first.status === 429).toBe(true);
    expect(second.status).toBe(429);
  });
});

describe('trusting X-Forwarded-For on Vercel without VERCEL_ENV', () => {
  it('does not let a rotating X-Forwarded-For dodge the limiter', async () => {
    const { base } = await start({
      VERCEL: '1',
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_CREATE_MAX: '3',
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await create(base, { 'x-forwarded-for': randomIp() })).status,
      );
    }
    expect(statuses[3]).toBe(429);
  });
});

describe('click freshness on metadata reads', () => {
  it('schedules a flush for GET /api/links/:code and shows flushed counts', async () => {
    const { base, waitUntil } = await start();
    const { code } = (await (await create(base)).json()) as { code: string };
    for (let i = 0; i < 3; i++) {
      expect(
        (await fetch(`${base}/${code}`, { redirect: 'manual' })).status,
      ).toBe(302);
    }
    for (let i = 0; i < 50 && waitUntil.mock.calls.length < 3; i++) {
      await sleep(20);
    }
    // First redirect flushes its own click; the others fall inside the throttle window.
    await Promise.all(waitUntil.mock.calls.map((c) => c[0]));
    expect((await findLinkByCode(pool, code))?.clickCount).toBe(1);
    await sleep(1100);
    const before = waitUntil.mock.calls.length;
    const meta = await fetch(`${base}/api/links/${code}`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { clickCount: number }).clickCount).toBe(1);
    expect(waitUntil).toHaveBeenCalledTimes(before + 1);
    const promise = waitUntil.mock.calls[before]![0];
    await expect(promise).resolves.toEqual({ codes: 1, clicks: 2 });
    const again = await fetch(`${base}/api/links/${code}`);
    expect(((await again.json()) as { clickCount: number }).clickCount).toBe(3);
  });

  it('does not schedule for 404 metadata, 201 creates, /healthz or cron', async () => {
    const { base, waitUntil } = await start({
      CRON_SECRET: 'cron-secret-0123456789',
    });
    expect((await create(base)).status).toBe(201);
    expect(
      (await fetch(`${base}/api/links/zzzzzz${randomBytes(3).toString('hex')}`))
        .status,
    ).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(
      (
        await fetch(`${base}/api/cron/flush`, {
          headers: { authorization: 'Bearer cron-secret-0123456789' },
        })
      ).status,
    ).toBe(200);
    await sleep(150);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe('public endpoints on Vercel', () => {
  const token = 'metrics-token-0123456789';

  it('hides /metrics and /readyz without METRICS_TOKEN', async () => {
    const { base } = await start({ VERCEL: '1' });
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/readyz`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('requires the bearer token on /metrics and /readyz with METRICS_TOKEN', async () => {
    const { base } = await start({ VERCEL: '1', METRICS_TOKEN: token });
    for (const path of ['/metrics', '/readyz']) {
      const denied = await fetch(`${base}${path}`);
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toBe('Bearer');
      const body = (await denied.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
      const ok = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(ok.status).toBe(200);
    }
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
