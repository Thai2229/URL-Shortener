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
import { createClickCounter } from '../src/clicks.js';
import { findLinkByCode, insertLink } from '../src/db/links.js';
import { createMetrics } from '../src/metrics.js';
import { createRedis } from '../src/redis.js';
import { uniqueCode, usePool } from './helpers/db.js';
import { parseMetrics, valueOf } from './helpers/metrics.js';
import { testRedisUrl, waitFailed, waitReady } from './helpers/redis.js';

const pool = usePool();
const redis = createRedis(testRedisUrl());
const deadRedis = createRedis('redis://127.0.0.1:1');
let prefixes: string[] = [];

beforeAll(async () => {
  await waitReady(redis);
  await waitFailed(deadRedis);
});
afterAll(async () => {
  await redis.quit();
  deadRedis.disconnect();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of prefixes) {
    await redis.del(p, `${p}:processing`, `${p}:lock`, `${p}:due`);
  }
  prefixes = [];
});

function newPrefix() {
  const p = `test-fid-${randomBytes(6).toString('hex')}`;
  prefixes.push(p);
  return p;
}
async function link() {
  const code = uniqueCode('fd');
  await insertLink(pool, { code, targetUrl: 'https://example.com/fd' });
  return code;
}
async function count(code: string) {
  return (await findLinkByCode(pool, code))?.clickCount;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('flushIfDue', () => {
  it('flushes pending clicks on the first call', async () => {
    const prefix = newPrefix();
    const c = createClickCounter({ redis, db: pool, prefix });
    const code = await link();
    await c.record(code);
    await c.record(code);
    expect(await c.flushIfDue(5000)).toEqual({ codes: 1, clicks: 2 });
    expect(await count(code)).toBe(2);
    expect(await redis.exists(`${prefix}:due`)).toBe(1);
  });

  it('returns null without any Redis command when called again on the same instance', async () => {
    const prefix = newPrefix();
    const c = createClickCounter({ redis, db: pool, prefix });
    const code = await link();
    await c.record(code);
    await c.flushIfDue(5000);
    await c.record(code);
    const set = vi.spyOn(redis, 'set');
    const other = vi.spyOn(redis, 'hgetall');
    expect(await c.flushIfDue(5000)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(await count(code)).toBe(1);
  });

  it('takes the marker with SET <prefix>:due 1 PX <ms> NX', async () => {
    const prefix = newPrefix();
    const c = createClickCounter({ redis, db: pool, prefix });
    const set = vi.spyOn(redis, 'set');
    await c.flushIfDue(4000);
    expect(set).toHaveBeenCalledWith(`${prefix}:due`, '1', 'PX', 4000, 'NX');
  });

  it('lets exactly one of two counters flush', async () => {
    const prefix = newPrefix();
    const a = createClickCounter({ redis, db: pool, prefix });
    const b = createClickCounter({ redis, db: pool, prefix });
    const code = await link();
    for (let i = 0; i < 3; i++) {
      await a.record(code);
    }
    const results = await Promise.all([a.flushIfDue(5000), b.flushIfDue(5000)]);
    expect(results.filter((r) => r !== null)).toEqual([
      { codes: 1, clicks: 3 },
    ]);
    expect(await count(code)).toBe(3);
  });

  it('flushes again once minIntervalMs has elapsed', async () => {
    const prefix = newPrefix();
    const c = createClickCounter({ redis, db: pool, prefix });
    const code = await link();
    await c.record(code);
    expect(await c.flushIfDue(50)).toEqual({ codes: 1, clicks: 1 });
    await sleep(120);
    await c.record(code);
    await c.record(code);
    expect(await c.flushIfDue(50)).toEqual({ codes: 1, clicks: 2 });
    expect(await count(code)).toBe(3);
  });

  it('returns null quickly when Redis is not ready or undefined', async () => {
    for (const r of [deadRedis, undefined]) {
      const c = createClickCounter({ redis: r, db: pool, prefix: newPrefix() });
      const start = Date.now();
      expect(await c.flushIfDue(50)).toBeNull();
      expect(Date.now() - start).toBeLessThan(500);
    }
  });

  it('returns null on a failing DB write and applies the counts exactly once later', async () => {
    const prefix = newPrefix();
    const c = createClickCounter({ redis, db: pool, prefix });
    const code = await link();
    await c.record(code);
    await c.record(code);
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('db down'));
    await expect(c.flushIfDue(50)).resolves.toBeNull();
    expect(await count(code)).toBe(0);
    await sleep(120);
    expect(await c.flushIfDue(50)).toEqual({ codes: 1, clicks: 2 });
    expect(await count(code)).toBe(2);
    await sleep(120);
    expect(await c.flushIfDue(50)).toEqual({ codes: 0, clicks: 0 });
    expect(await count(code)).toBe(2);
  });

  it('never throws when Redis rejects', async () => {
    const c = createClickCounter({ redis, db: pool, prefix: newPrefix() });
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('boom'));
    await expect(c.flushIfDue(50)).resolves.toBeNull();
  });

  it('counts click_flush_total only when flush() was actually called', async () => {
    const prefix = newPrefix();
    const metrics = createMetrics({ db: pool, redis });
    const other = createMetrics({ db: pool, redis });
    const c = createClickCounter({ redis, db: pool, prefix, metrics });
    const d = createClickCounter({ redis, db: pool, prefix, metrics: other });
    const code = await link();
    await c.record(code);
    const total = async (m: typeof metrics) =>
      valueOf(parseMetrics(await m.register.metrics()), 'click_flush_total', {
        result: 'ok',
      });
    await c.flushIfDue(5000);
    expect(await total(metrics)).toBe(1);
    await c.flushIfDue(5000); // instance-throttled
    await d.flushIfDue(5000); // cluster-throttled
    expect(await total(metrics)).toBe(1);
    const all = parseMetrics(await other.register.metrics());
    expect(all.filter((s) => s.name === 'click_flush_total')).toEqual([]);
  });
});
