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
import { cacheKey, cacheLink, cacheMissing } from '../src/cache.js';
import { generateCode } from '../src/code.js';
import { testConfig } from './helpers/config.js';
import { insertLink } from '../src/db/links.js';
import { createRedis } from '../src/redis.js';
import { uniqueCode, usePool } from './helpers/db.js';
import {
  testRedisUrl,
  trackKey,
  useRedis,
  waitFailed,
  waitReady,
} from './helpers/redis.js';

vi.mock('../src/code.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/code.js')>();
  return { generateCode: vi.fn(actual.generateCode) };
});

const pool = usePool();
const raw = useRedis();
const appRedis = createRedis(testRedisUrl());
const config = testConfig({ BASE_URL: 'http://short.test' });
const app = buildApp(config, { db: pool, redis: appRedis });
const deadRedis = createRedis('redis://127.0.0.1:1');
const deadApp = buildApp(config, { db: pool, redis: deadRedis });
let realGenerate: typeof generateCode;

beforeAll(async () => {
  await waitReady(appRedis);
  await waitFailed(deadRedis);
  const actual =
    await vi.importActual<typeof import('../src/code.js')>('../src/code.js');
  realGenerate = actual.generateCode;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(generateCode).mockReset();
  vi.mocked(generateCode).mockImplementation(realGenerate);
});
afterAll(async () => {
  await app.close();
  await deadApp.close();
  appRedis.disconnect();
  deadRedis.disconnect();
});

function fresh() {
  const code = uniqueCode('rc');
  trackKey(cacheKey(code));
  return code;
}

function get(code: string, target = app) {
  return target.inject({ method: 'GET', url: `/${code}` });
}

function create(url: string, target = app) {
  return target.inject({ method: 'POST', url: '/api/links', payload: { url } });
}

describe('redirect with cache', () => {
  it('miss falls through to postgres, then populates the cache', async () => {
    const code = fresh();
    await insertLink(pool, { code, targetUrl: 'https://example.com/miss' });
    expect(await raw.exists(cacheKey(code))).toBe(0);
    const res = await get(code);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/miss');
    expect(await raw.exists(cacheKey(code))).toBe(1);
  });

  it('second redirect is served from cache even if the row is deleted', async () => {
    const code = fresh();
    await insertLink(pool, { code, targetUrl: 'https://example.com/warm' });
    expect((await get(code)).statusCode).toBe(302);
    await pool.query('DELETE FROM links WHERE code = $1', [code]);
    const res = await get(code);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/warm');
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('cache hit does not touch postgres', async () => {
    const code = fresh();
    await cacheLink(appRedis, {
      code,
      targetUrl: 'https://example.com/only-cache',
      expiresAt: null,
    });
    const spy = vi.spyOn(pool, 'query');
    const res = await get(code);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/only-cache');
    expect(spy).not.toHaveBeenCalled();
  });

  it('cached link whose expiresAt has passed returns 410 without postgres', async () => {
    const code = fresh();
    await cacheLink(appRedis, {
      code,
      targetUrl: 'https://example.com/soon',
      expiresAt: new Date(Date.now() + 100_000),
    });
    // Move the clock past expiresAt; the redis key itself is still alive.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 200_000);
    const spy = vi.spyOn(pool, 'query');
    const res = await get(code);
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('expired');
    expect(res.headers.location).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('negative marker returns 404 without touching postgres', async () => {
    const code = fresh();
    await cacheMissing(appRedis, code);
    // A real row exists; the marker must win until it expires.
    await insertLink(pool, { code, targetUrl: 'https://example.com/hidden' });
    const spy = vi.spyOn(pool, 'query');
    const res = await get(code);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    expect(spy).not.toHaveBeenCalled();
  });

  it('unknown code returns 404 and caches a negative marker', async () => {
    const code = fresh();
    expect((await get(code)).statusCode).toBe(404);
    expect(await raw.exists(cacheKey(code))).toBe(1);
    const ttl = await raw.ttl(cacheKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    const spy = vi.spyOn(pool, 'query');
    expect((await get(code)).statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('expired link in postgres returns 410 and is not cached', async () => {
    const code = fresh();
    await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/old',
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await get(code)).statusCode).toBe(410);
    expect(await raw.exists(cacheKey(code))).toBe(0);
  });

  it('invalid codes do not create cache entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/a.b' });
    expect(res.statusCode).toBe(404);
    expect(await raw.exists('link:a.b')).toBe(0);
  });
});

describe('POST /api/links write-through', () => {
  it('puts the new link in the cache', async () => {
    const res = await create('https://example.com/wt');
    expect(res.statusCode).toBe(201);
    const code = res.json().code as string;
    trackKey(cacheKey(code));
    expect(await raw.exists(cacheKey(code))).toBe(1);
    const spy = vi.spyOn(pool, 'query');
    const redirect = await get(code);
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/wt');
    expect(spy).not.toHaveBeenCalled();
  });

  it('replaces a negative marker for the same code', async () => {
    const code = fresh();
    await cacheMissing(appRedis, code);
    vi.mocked(generateCode).mockReturnValueOnce(code);
    const res = await create('https://example.com/replace');
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe(code);
    const redirect = await get(code);
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/replace');
  });

  it('caches an expiring link with TTL <= remaining time', async () => {
    const expiresAt = new Date(Date.now() + 100_000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/api/links',
      payload: { url: 'https://example.com/exp', expiresAt },
    });
    const code = res.json().code as string;
    trackKey(cacheKey(code));
    const ttl = await raw.ttl(cacheKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);
  });
});

describe('GET /api/links/:code metadata', () => {
  it('reads postgres, not the cache', async () => {
    const code = fresh();
    await insertLink(pool, { code, targetUrl: 'https://example.com/meta' });
    await get(code); // warm the cache
    await pool.query('UPDATE links SET click_count = 7 WHERE code = $1', [
      code,
    ]);
    const res = await app.inject({ method: 'GET', url: `/api/links/${code}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().clickCount).toBe(7);
  });

  it('does not use a negative marker', async () => {
    const code = fresh();
    await cacheMissing(appRedis, code);
    await insertLink(pool, { code, targetUrl: 'https://example.com/meta2' });
    const res = await app.inject({ method: 'GET', url: `/api/links/${code}` });
    expect(res.statusCode).toBe(200);
  });
});

describe('redis down at request time', () => {
  it('redirect still returns 302 from postgres', async () => {
    const code = fresh();
    await insertLink(pool, { code, targetUrl: 'https://example.com/down' });
    const start = Date.now();
    const res = await get(code, deadApp);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/down');
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('redirect answers 302 in under 150ms once the client has failed', async () => {
    const code = fresh();
    await insertLink(pool, { code, targetUrl: 'https://example.com/fast' });
    const start = Date.now();
    const res = await get(code, deadApp);
    expect(res.statusCode).toBe(302);
    expect(Date.now() - start).toBeLessThan(150);
  });

  it('unknown code still returns 404 quickly', async () => {
    const start = Date.now();
    const res = await get(fresh(), deadApp);
    expect(res.statusCode).toBe(404);
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('create still returns 201', async () => {
    const start = Date.now();
    const res = await create('https://example.com/down-create', deadApp);
    expect(res.statusCode).toBe(201);
    expect(Date.now() - start).toBeLessThan(1500);
    const redirect = await get(res.json().code, deadApp);
    expect(redirect.statusCode).toBe(302);
  });
});

describe('no redis in deps', () => {
  it('behaves like before', async () => {
    const plain = buildApp(config, { db: pool });
    const code = uniqueCode('nr');
    await insertLink(pool, { code, targetUrl: 'https://example.com/plain' });
    expect((await get(code, plain)).statusCode).toBe(302);
    expect((await get(uniqueCode('nr'), plain)).statusCode).toBe(404);
    const created = await create('https://example.com/plain2', plain);
    expect(created.statusCode).toBe(201);
    await plain.close();
  });
});
