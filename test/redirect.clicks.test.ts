import { randomBytes } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildApp } from '../src/app.js';
import { cacheKey } from '../src/cache.js';
import { createClickCounter } from '../src/clicks.js';
import { insertLink } from '../src/db/links.js';
import { createRedis } from '../src/redis.js';
import { testConfig } from './helpers/config.js';
import { uniqueCode, usePool } from './helpers/db.js';
import {
  testRedisUrl,
  trackKey,
  useRedis,
  waitFailed,
  waitReady,
} from './helpers/redis.js';

const pool = usePool();
const raw = useRedis();
const appRedis = createRedis(testRedisUrl());
const deadRedis = createRedis('redis://127.0.0.1:1');
const prefix = `test-clicks-${randomBytes(6).toString('hex')}`;
const config = testConfig({ BASE_URL: 'http://short.test' });
const counter = createClickCounter({ redis: appRedis, db: pool, prefix });
const app = buildApp(config, { db: pool, redis: appRedis, clicks: counter });

beforeAll(async () => {
  await waitReady(appRedis);
  await waitFailed(deadRedis);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await app.close();
  await raw.del(prefix, `${prefix}:processing`, `${prefix}:lock`);
  appRedis.disconnect();
  deadRedis.disconnect();
});

function fake() {
  const events: string[] = [];
  const record = vi.fn(async (code: string) => {
    void code;
    await new Promise((r) => setTimeout(r, 80));
    events.push('recorded');
  });
  return {
    events,
    record,
    clicks: {
      record,
      flush: vi.fn(async () => null),
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    },
  };
}

async function fresh(extra: { expiresAt?: Date } = {}) {
  const code = uniqueCode('rk');
  trackKey(cacheKey(code));
  await insertLink(pool, {
    code,
    targetUrl: 'https://example.com/rk',
    ...extra,
  });
  return code;
}

const get = (a: ReturnType<typeof buildApp>, code: string) =>
  a.inject({ method: 'GET', url: `/${code}` });

describe('redirects record clicks', () => {
  it('3 redirects then flush show clickCount 3 in the metadata API', async () => {
    const code = await fresh();
    for (let i = 0; i < 3; i++) {
      expect((await get(app, code)).statusCode).toBe(302);
    }
    await counter.flush();
    const res = await app.inject({ method: 'GET', url: `/api/links/${code}` });
    expect(res.json().clickCount).toBe(3);
  });

  it('records exactly once and awaits it, on cache miss and on cache hit', async () => {
    const f = fake();
    const a = buildApp(config, { db: pool, redis: appRedis, clicks: f.clicks });
    const code = await fresh();
    expect(await raw.exists(cacheKey(code))).toBe(0);
    const miss = await get(a, code);
    expect(miss.statusCode).toBe(302);
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenLastCalledWith(code);
    expect(f.events).toEqual(['recorded']);
    expect(await raw.exists(cacheKey(code))).toBe(1);
    const hit = await get(a, code);
    expect(hit.statusCode).toBe(302);
    expect(f.record).toHaveBeenCalledTimes(2);
    expect(f.events).toEqual(['recorded', 'recorded']);
    await a.close();
  });

  it('does not record 404, 410 or metadata requests', async () => {
    const f = fake();
    const a = buildApp(config, { db: pool, redis: appRedis, clicks: f.clicks });
    const unknown = uniqueCode('nx');
    trackKey(cacheKey(unknown));
    expect((await get(a, unknown)).statusCode).toBe(404);
    expect((await get(a, unknown)).statusCode).toBe(404); // negative cache
    expect((await get(a, 'a.b')).statusCode).toBe(404);
    const expired = await fresh({ expiresAt: new Date(Date.now() - 60_000) });
    expect((await get(a, expired)).statusCode).toBe(410);
    const live = await fresh();
    const meta = await a.inject({ method: 'GET', url: `/api/links/${live}` });
    expect(meta.statusCode).toBe(200);
    expect(f.record).not.toHaveBeenCalled();
    await a.close();
  });

  it('does not record rate-limited (429) redirects', async () => {
    const f = fake();
    const limited = buildApp(
      testConfig({
        BASE_URL: 'http://short.test',
        RATE_LIMIT_ENABLED: 'true',
        RATE_LIMIT_REDIRECT_MAX: '1',
      }),
      { db: pool, clicks: f.clicks },
    );
    const code = await fresh();
    expect((await get(limited, code)).statusCode).toBe(302);
    expect((await get(limited, code)).statusCode).toBe(429);
    expect(f.record).toHaveBeenCalledTimes(1);
    await limited.close();
  });

  it('works without clicks in deps', async () => {
    const a = buildApp(config, { db: pool, redis: appRedis });
    const code = await fresh();
    expect((await get(a, code)).statusCode).toBe(302);
    await a.close();
  });

  it('a dead-redis counter does not slow redirects', async () => {
    const dead = createClickCounter({
      redis: deadRedis,
      db: pool,
      prefix: `${prefix}-dead`,
    });
    const a = buildApp(config, { db: pool, redis: deadRedis, clicks: dead });
    const code = await fresh();
    await get(a, code); // warm pool/connection
    const t = Date.now();
    const res = await get(a, code);
    expect(res.statusCode).toBe(302);
    expect(Date.now() - t).toBeLessThan(150);
    await a.close();
  });
});
