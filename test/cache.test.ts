import { afterAll, describe, expect, it } from 'vitest';
import {
  LINK_TTL_SECONDS,
  NEGATIVE_TTL_SECONDS,
  cacheKey,
  cacheLink,
  cacheMissing,
  getCachedLink,
} from '../src/cache.js';
import { createRedis } from '../src/redis.js';
import { uniqueCode } from './helpers/db.js';
import { testRedisUrl, trackKey, useRedis } from './helpers/redis.js';

const raw = useRedis();
const cached = createRedis(testRedisUrl());
afterAll(async () => {
  cached.disconnect();
});

function fresh() {
  const code = uniqueCode('c');
  trackKey(cacheKey(code));
  return code;
}

describe('constants and key', () => {
  it('exposes the contract values', () => {
    expect(NEGATIVE_TTL_SECONDS).toBe(60);
    expect(LINK_TTL_SECONDS).toBe(86400);
    expect(cacheKey('abc')).toBe('link:abc');
  });
});

describe('getCachedLink / cacheLink', () => {
  it('returns miss for an unknown code', async () => {
    expect(await getCachedLink(cached, fresh())).toEqual({ kind: 'miss' });
  });

  it('round-trips a link without expiry', async () => {
    const code = fresh();
    await cacheLink(cached, {
      code,
      targetUrl: 'https://example.com/a?b=1&c=é😀',
      expiresAt: null,
    });
    expect(await getCachedLink(cached, code)).toEqual({
      kind: 'hit',
      url: 'https://example.com/a?b=1&c=é😀',
      expiresAt: null,
    });
  });

  it('round-trips expiresAt as a Date', async () => {
    const code = fresh();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await cacheLink(cached, {
      code,
      targetUrl: 'https://example.com/e',
      expiresAt,
    });
    const res = await getCachedLink(cached, code);
    expect(res.kind).toBe('hit');
    if (res.kind === 'hit') {
      expect(res.expiresAt).toBeInstanceOf(Date);
      expect(res.expiresAt?.getTime()).toBe(expiresAt.getTime());
    }
  });

  it('uses a 24h TTL with +-10% jitter', async () => {
    const ttls = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const code = fresh();
      await cacheLink(cached, {
        code,
        targetUrl: 'https://example.com/t',
        expiresAt: null,
      });
      const ttl = await raw.ttl(cacheKey(code));
      expect(ttl).toBeGreaterThanOrEqual(77760);
      expect(ttl).toBeLessThanOrEqual(95040);
      ttls.add(ttl);
    }
    expect(ttls.size).toBeGreaterThan(1);
  });

  it('caps the TTL at the time remaining until expiresAt', async () => {
    const code = fresh();
    await cacheLink(cached, {
      code,
      targetUrl: 'https://example.com/short',
      expiresAt: new Date(Date.now() + 100_000),
    });
    const ttl = await raw.ttl(cacheKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('does not cache an already expired link', async () => {
    const code = fresh();
    await cacheLink(cached, {
      code,
      targetUrl: 'https://example.com/old',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await raw.exists(cacheKey(code))).toBe(0);
    expect(await getCachedLink(cached, code)).toEqual({ kind: 'miss' });
  });

  it('overwrites a previous entry', async () => {
    const code = fresh();
    await cacheLink(cached, {
      code,
      targetUrl: 'https://example.com/1',
      expiresAt: null,
    });
    await cacheLink(cached, {
      code,
      targetUrl: 'https://example.com/2',
      expiresAt: null,
    });
    const res = await getCachedLink(cached, code);
    expect(res).toMatchObject({ kind: 'hit', url: 'https://example.com/2' });
  });
});

describe('cacheMissing', () => {
  it('stores a negative marker with a short TTL', async () => {
    const code = fresh();
    await cacheMissing(cached, code);
    expect(await getCachedLink(cached, code)).toEqual({ kind: 'negative' });
    const ttl = await raw.ttl(cacheKey(code));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('is replaced by cacheLink', async () => {
    const code = fresh();
    await cacheMissing(cached, code);
    await cacheLink(cached, {
      code,
      targetUrl: 'https://example.com/r',
      expiresAt: null,
    });
    expect(await getCachedLink(cached, code)).toMatchObject({ kind: 'hit' });
  });
});

describe('corrupt values', () => {
  it.each([
    ['not json', 'garbage{{{'],
    ['empty string', ''],
    ['json null', 'null'],
    ['json number', '42'],
    ['json object of wrong shape', '{"foo":1}'],
  ])('treats %s as a miss', async (_name, value) => {
    const code = fresh();
    await raw.set(cacheKey(code), value, 'EX', 30);
    expect(await getCachedLink(cached, code)).toEqual({ kind: 'miss' });
  });
});

describe('no redis configured', () => {
  it('returns miss and does not throw', async () => {
    const code = fresh();
    expect(await getCachedLink(undefined, code)).toEqual({ kind: 'miss' });
    await expect(
      cacheLink(undefined, {
        code,
        targetUrl: 'https://example.com/x',
        expiresAt: null,
      }),
    ).resolves.toBeUndefined();
    await expect(cacheMissing(undefined, code)).resolves.toBeUndefined();
    expect(await raw.exists(cacheKey(code))).toBe(0);
  });
});

describe('dead redis', () => {
  it('never throws and resolves quickly', async () => {
    const dead = createRedis('redis://127.0.0.1:1');
    const code = fresh();
    const start = Date.now();
    expect(await getCachedLink(dead, code)).toEqual({ kind: 'miss' });
    await expect(
      cacheLink(dead, {
        code,
        targetUrl: 'https://example.com/x',
        expiresAt: null,
      }),
    ).resolves.toBeUndefined();
    await expect(cacheMissing(dead, code)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1500);
    dead.disconnect();
  });
});

describe('createRedis', () => {
  it('fails fast and does not crash on connection errors', async () => {
    const dead = createRedis('redis://127.0.0.1:1');
    const start = Date.now();
    await expect(dead.get('link:whatever')).rejects.toBeDefined();
    expect(Date.now() - start).toBeLessThan(1500);
    expect(dead.listenerCount('error')).toBeGreaterThan(0);
    dead.disconnect();
  });

  it('works against a live redis', async () => {
    const live = createRedis(testRedisUrl());
    expect(await live.ping()).toBe('PONG');
    live.disconnect();
  });
});
