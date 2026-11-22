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
import { createClickCounter } from '../src/clicks.js';
import { findLinkByCode, insertLink } from '../src/db/links.js';
import { createRedis } from '../src/redis.js';
import { testConfig } from './helpers/config.js';
import { uniqueCode, usePool } from './helpers/db.js';
import { testRedisUrl, waitReady } from './helpers/redis.js';

const pool = usePool();
const redis = createRedis(testRedisUrl());
const SECRET = 'cron-secret-0123456789';
const apps: ReturnType<typeof buildApp>[] = [];
let prefixes: string[] = [];

beforeAll(() => waitReady(redis));
afterAll(() => redis.quit());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) {
    await a.close();
  }
  for (const p of prefixes) {
    await redis.del(p, `${p}:processing`, `${p}:lock`, `${p}:due`);
  }
  prefixes = [];
});

function make(env: Record<string, string> = {}, withClicks = true) {
  const prefix = `test-cron-${randomBytes(6).toString('hex')}`;
  prefixes.push(prefix);
  const clicks = createClickCounter({ redis, db: pool, prefix });
  const app = buildApp(testConfig({ CRON_SECRET: SECRET, ...env }), {
    db: pool,
    redis,
    clicks: withClicks ? clicks : undefined,
  });
  apps.push(app);
  return { app, clicks, prefix };
}
const get = (app: ReturnType<typeof buildApp>, authorization?: string) =>
  app.inject({
    method: 'GET',
    url: '/api/cron/flush',
    headers: authorization === undefined ? {} : { authorization },
  });

describe('GET /api/cron/flush', () => {
  it('is a plain 404 when CRON_SECRET is not set', async () => {
    const app = buildApp(testConfig(), { db: pool, redis });
    apps.push(app);
    const res = await get(app, `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'Bearer wrong-secret-0123456789'],
    ['short', 'Bearer x'],
    ['long', `Bearer ${SECRET}${SECRET}`],
    ['prefix of secret', `Bearer ${SECRET.slice(0, -1)}`],
    ['wrong scheme', `Basic ${SECRET}`],
    ['no scheme', SECRET],
    ['empty', ''],
  ])('rejects %s token with 401 and flushes nothing', async (_n, header) => {
    const { app, clicks } = make();
    const flush = vi.spyOn(clicks, 'flush');
    const res = await get(app, header);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushes pending clicks and reports the result', async () => {
    const { app, clicks } = make();
    const code = uniqueCode('cr');
    await insertLink(pool, { code, targetUrl: 'https://example.com/cr' });
    await clicks.record(code);
    await clicks.record(code);
    const res = await get(app, `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flushed: { codes: 1, clicks: 2 } });
    expect((await findLinkByCode(pool, code))?.clickCount).toBe(2);
  });

  it('calls clicks.flush() once', async () => {
    const { app, clicks } = make();
    const flush = vi.spyOn(clicks, 'flush');
    await get(app, `Bearer ${SECRET}`);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('returns flushed: null without a click counter', async () => {
    const { app } = make({}, false);
    const res = await get(app, `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flushed: null });
  });

  it('returns flushed: null when the flush was skipped', async () => {
    const { app, prefix } = make();
    await redis.set(`${prefix}:lock`, 'held', 'EX', 30);
    const res = await get(app, `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ flushed: null });
  });

  it('is not rate limited and not shadowed by /:code', async () => {
    const { app } = make({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_CREATE_MAX: '1',
      RATE_LIMIT_REDIRECT_MAX: '1',
      RATE_LIMIT_READ_MAX: '1',
    });
    for (let i = 0; i < 4; i++) {
      const res = await get(app, `Bearer ${SECRET}`);
      expect(res.statusCode).toBe(200);
    }
  });

  it.each(['POST', 'PUT', 'DELETE'] as const)(
    '%s returns the app 404',
    async (method) => {
      const { app } = make();
      const res = await app.inject({
        method,
        url: '/api/cron/flush',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    },
  );
});
