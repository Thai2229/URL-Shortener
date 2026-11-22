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
import type { Redis } from 'ioredis';
import { createClickCounter } from '../src/clicks.js';
import { findLinkByCode, insertLink } from '../src/db/links.js';
import { createPool } from '../src/db/pool.js';
import { createRedis } from '../src/redis.js';
import { testDatabaseUrl, uniqueCode, usePool } from './helpers/db.js';
import { testRedisUrl, waitFailed, waitReady } from './helpers/redis.js';

const pool = usePool();
const redis = createRedis(testRedisUrl());
const deadRedis = createRedis('redis://127.0.0.1:1');

beforeAll(async () => {
  await waitReady(redis);
  await waitFailed(deadRedis);
});
afterAll(async () => {
  await redis.quit();
  deadRedis.disconnect();
});

let prefixes: string[] = [];
let counters: Array<{ stop(): Promise<void> }> = [];

function newPrefix() {
  const p = `test-clicks-${randomBytes(6).toString('hex')}`;
  prefixes.push(p);
  return p;
}

function make(
  prefix: string,
  extra: {
    db?: typeof pool;
    redis?: Redis | undefined;
    lockSeconds?: number;
  } = {},
) {
  const counter = createClickCounter({
    redis: 'redis' in extra ? extra.redis : redis,
    db: extra.db ?? pool,
    prefix,
    lockSeconds: extra.lockSeconds,
  });
  counters.push(counter);
  return counter;
}

async function link() {
  const code = uniqueCode('ck');
  await insertLink(pool, { code, targetUrl: 'https://example.com/ck' });
  return code;
}

async function clicks(code: string) {
  return (await findLinkByCode(pool, code))?.clickCount;
}

async function until(fn: () => Promise<boolean>, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of counters) {
    await c.stop();
  }
  counters = [];
  for (const p of prefixes) {
    await redis.del(p, `${p}:processing`, `${p}:lock`);
  }
  prefixes = [];
});

describe('record and flush', () => {
  it('record twice + flush adds 2 to postgres and removes the pending hash', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    await c.record(code);
    await c.record(code);
    expect(await redis.hget(prefix, code)).toBe('2');
    expect(await c.flush()).toEqual({ codes: 1, clicks: 2 });
    expect(await clicks(code)).toBe(2);
    expect(await redis.exists(prefix)).toBe(0);
    expect(await redis.exists(`${prefix}:processing`)).toBe(0);
  });

  it('flushes 3 codes in a single pool.query call', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const codes = [await link(), await link(), await link()];
    await c.record(codes[0]!);
    await c.record(codes[1]!);
    await c.record(codes[1]!);
    await c.record(codes[2]!);
    const spy = vi.spyOn(pool, 'query');
    expect(await c.flush()).toEqual({ codes: 3, clicks: 4 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await clicks(codes[0]!)).toBe(1);
    expect(await clicks(codes[1]!)).toBe(2);
    expect(await clicks(codes[2]!)).toBe(1);
  });

  it('flush with nothing pending returns zeros', async () => {
    const c = make(newPrefix());
    expect(await c.flush()).toEqual({ codes: 0, clicks: 0 });
  });

  it('record after a flush starts a fresh pending hash', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    await c.record(code);
    await c.flush();
    expect(await redis.exists(prefix)).toBe(0);
    await c.record(code);
    expect(await redis.hget(prefix, code)).toBe('1');
    await c.flush();
    expect(await clicks(code)).toBe(2);
  });

  it('uses the default prefix "clicks" when none is given', async () => {
    // Only checks naming through a pending key; cleans only what it created.
    const c = createClickCounter({ redis, db: pool });
    const code = await link();
    const before = await redis.hget('clicks', code);
    expect(before).toBeNull();
    await c.record(code);
    expect(await redis.hget('clicks', code)).toBe('1');
    await redis.hdel('clicks', code);
  });

  it('two counters flushing concurrently never double count', async () => {
    const prefix = newPrefix();
    const a = make(prefix);
    const b = make(prefix);
    const code = await link();
    for (let i = 0; i < 50; i++) {
      await a.record(code);
    }
    const results = await Promise.all([a.flush(), b.flush()]);
    for (const r of results) {
      expect(r === null || typeof r.clicks === 'number').toBe(true);
    }
    expect(results.some((r) => r !== null && r.clicks === 50)).toBe(true);
    expect(await clicks(code)).toBe(50);
    // A later flush must not re-apply anything.
    await a.flush();
    await b.flush();
    expect(await clicks(code)).toBe(50);
  });
});

describe('failure handling', () => {
  it('db rejection: flush returns null, counts are kept, next flush applies them once', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    await c.record(code);
    await c.record(code);
    await c.record(code);
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db down'));
    expect(await c.flush()).toBeNull();
    expect(await redis.hget(`${prefix}:processing`, code)).toBe('3');
    expect(await redis.exists(`${prefix}:lock`)).toBe(0);
    expect(await clicks(code)).toBe(0);
    expect(await c.flush()).toEqual({ codes: 1, clicks: 3 });
    expect(await clicks(code)).toBe(3);
    expect(await redis.exists(`${prefix}:processing`)).toBe(0);
    await c.flush();
    expect(await clicks(code)).toBe(3);
  });

  it('closed pool: flush returns null without throwing and keeps counts', async () => {
    const prefix = newPrefix();
    const closed = createPool(testDatabaseUrl());
    await closed.end();
    const c = make(prefix, { db: closed });
    const code = await link();
    await c.record(code);
    expect(await c.flush()).toBeNull();
    expect(await redis.hget(`${prefix}:processing`, code)).toBe('1');
    const good = make(prefix);
    expect(await good.flush()).toEqual({ codes: 1, clicks: 1 });
    expect(await clicks(code)).toBe(1);
  });

  it('one flush applies a leftover processing hash and then the pending hash', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const old = await link();
    const fresh = await link();
    await redis.hset(`${prefix}:processing`, old, 7);
    await c.record(fresh);
    const spy = vi.spyOn(pool, 'query');
    expect(await c.flush()).toEqual({ codes: 2, clicks: 8 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await clicks(old)).toBe(7);
    expect(await clicks(fresh)).toBe(1);
    expect(await redis.exists(prefix)).toBe(0);
    expect(await redis.exists(`${prefix}:processing`)).toBe(0);
    expect(await c.flush()).toEqual({ codes: 0, clicks: 0 });
    expect(await clicks(old)).toBe(7);
    expect(await clicks(fresh)).toBe(1);
  });

  it('stop with a leftover present leaves nothing pending in redis', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const old = await link();
    const fresh = await link();
    await redis.hset(`${prefix}:processing`, old, 4);
    await c.record(fresh);
    await c.stop();
    expect(await clicks(old)).toBe(4);
    expect(await clicks(fresh)).toBe(1);
    expect(await redis.exists(prefix)).toBe(0);
    expect(await redis.exists(`${prefix}:processing`)).toBe(0);
  });

  it('db failure on the second pass returns null, keeps only the second batch and never re-applies the first', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const old = await link();
    const fresh = await link();
    await redis.hset(`${prefix}:processing`, old, 7);
    await c.record(fresh);
    const real = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 2) {
        return Promise.reject(new Error('db down'));
      }
      return real(...args);
    }) as never);
    expect(await c.flush()).toBeNull();
    expect(await clicks(old)).toBe(7);
    expect(await clicks(fresh)).toBe(0);
    expect(await redis.hget(`${prefix}:processing`, fresh)).toBe('1');
    expect(await redis.hget(`${prefix}:processing`, old)).toBeNull();
    expect(await redis.exists(prefix)).toBe(0);
    vi.restoreAllMocks();
    expect(await c.flush()).toEqual({ codes: 1, clicks: 1 });
    expect(await clicks(old)).toBe(7);
    expect(await clicks(fresh)).toBe(1);
  });

  it('returns null and touches nothing when the lock is held by another token', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    await c.record(code);
    await redis.set(`${prefix}:lock`, 'someone-else', 'EX', 60);
    expect(await c.flush()).toBeNull();
    expect(await redis.hget(prefix, code)).toBe('1');
    expect(await redis.exists(`${prefix}:processing`)).toBe(0);
    expect(await redis.get(`${prefix}:lock`)).toBe('someone-else');
    expect(await clicks(code)).toBe(0);
  });

  it('takes the lock with an expiry (default 30s, configurable)', async () => {
    const prefix = newPrefix();
    const c = make(prefix, { lockSeconds: 7 });
    const code = await link();
    await c.record(code);
    let ttl = -2;
    vi.spyOn(pool, 'query').mockImplementationOnce((async () => {
      ttl = await redis.ttl(`${prefix}:lock`);
      return { rows: [], rowCount: 1 };
    }) as never);
    await c.flush();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(7);
  });

  it('releases the lock after a normal flush', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    await c.record(await link());
    await c.flush();
    expect(await redis.exists(`${prefix}:lock`)).toBe(0);
  });

  it('does not release a lock that expired and was taken by someone else', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    await c.record(await link());
    vi.spyOn(pool, 'query').mockImplementationOnce((async () => {
      await redis.set(`${prefix}:lock`, 'new-owner', 'EX', 60);
      return { rows: [], rowCount: 1 };
    }) as never);
    await c.flush();
    expect(await redis.get(`${prefix}:lock`)).toBe('new-owner');
  });
});

describe('redis unavailable', () => {
  it('redis undefined: record is a no-op, flush returns null', async () => {
    const c = make(newPrefix(), { redis: undefined });
    await expect(c.record('abc')).resolves.toBeUndefined();
    expect(await c.flush()).toBeNull();
  });

  it('dead redis: record and flush return quickly without throwing', async () => {
    const hincr = vi.spyOn(deadRedis, 'hincrby');
    const c = make(newPrefix(), { redis: deadRedis });
    let t = Date.now();
    await expect(c.record('abc')).resolves.toBeUndefined();
    expect(Date.now() - t).toBeLessThan(50);
    expect(hincr).not.toHaveBeenCalled();
    t = Date.now();
    expect(await c.flush()).toBeNull();
    expect(Date.now() - t).toBeLessThan(150);
  });

  it('record never throws when a command fails', async () => {
    const c = make(newPrefix());
    vi.spyOn(redis, 'hincrby').mockRejectedValueOnce(new Error('boom'));
    await expect(c.record('abc')).resolves.toBeUndefined();
  });

  it('flush never throws when redis commands fail', async () => {
    const c = make(newPrefix());
    vi.spyOn(redis, 'set').mockRejectedValueOnce(new Error('boom'));
    expect(await c.flush()).toBeNull();
  });
});

describe('start and stop', () => {
  it('flushes periodically without manual flush', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    c.start(50);
    await c.record(code);
    await c.record(code);
    expect(await until(async () => (await clicks(code)) === 2, 1000)).toBe(
      true,
    );
    await c.stop();
  });

  it('stop performs a final flush', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    c.start(60_000);
    await c.record(code);
    await c.record(code);
    await c.record(code);
    await c.stop();
    expect(await clicks(code)).toBe(3);
    expect(await redis.exists(prefix)).toBe(0);
  });

  it('stop clears the timer: nothing flushes afterwards', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    c.start(50);
    await c.stop();
    await c.record(code);
    await new Promise((r) => setTimeout(r, 250));
    expect(await clicks(code)).toBe(0);
    expect(await redis.hget(prefix, code)).toBe('1');
  });

  it('calling start twice does not create two timers', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const lockAttempts = vi.spyOn(redis, 'set');
    c.start(100);
    c.start(100);
    await new Promise((r) => setTimeout(r, 450));
    const n = lockAttempts.mock.calls.filter(
      (args) => args[0] === `${prefix}:lock`,
    ).length;
    // One timer ticks ~4 times in 450ms; two timers would tick ~8.
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(6);
  });

  it('stop without start still flushes and is safe to call twice', async () => {
    const prefix = newPrefix();
    const c = make(prefix);
    const code = await link();
    await c.record(code);
    await c.stop();
    await c.stop();
    expect(await clicks(code)).toBe(1);
  });
});
