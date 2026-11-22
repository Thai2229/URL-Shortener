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
import type { Metrics } from '../src/metrics.js';
import { createRedis } from '../src/redis.js';
import { testConfig } from './helpers/config.js';
import { uniqueCode, usePool } from './helpers/db.js';
import { parseMetrics, select, valueOf } from './helpers/metrics.js';
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
const apps: ReturnType<typeof buildApp>[] = [];
const prefixes: string[] = [];

beforeAll(async () => {
  await waitReady(appRedis);
  await waitFailed(deadRedis);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  for (const a of apps) {
    await a.close();
  }
  for (const p of prefixes) {
    await raw.del(p, `${p}:processing`, `${p}:lock`);
  }
  appRedis.disconnect();
  deadRedis.disconnect();
});

// Loaded lazily so a missing src/metrics.ts fails only the tests that need it.
async function newMetrics(
  redis: typeof appRedis | undefined,
): Promise<Metrics> {
  const mod = await import('../src/metrics.js');
  return mod.createMetrics({ db: pool, redis });
}

async function make(
  env: Record<string, string> = {},
  opts: {
    redis?: typeof appRedis | undefined;
    clicks?: ReturnType<typeof createClickCounter>;
  } = {},
) {
  const { redis: explicit, ...extra } = opts;
  let redis = appRedis as typeof appRedis | undefined;
  if ('redis' in opts) {
    redis = explicit;
  }
  const metrics = await newMetrics(redis);
  const app = buildApp(testConfig({ BASE_URL: 'http://short.test', ...env }), {
    db: pool,
    redis,
    metrics,
    ...extra,
  });
  apps.push(app);
  return { app, metrics };
}

async function scrape(
  app: ReturnType<typeof buildApp>,
  headers: Record<string, string> = {},
) {
  const res = await app.inject({ method: 'GET', url: '/metrics', headers });
  expect(res.statusCode).toBe(200);
  return parseMetrics(res.body);
}

async function seedLink() {
  const code = uniqueCode('m');
  trackKey(cacheKey(code));
  await insertLink(pool, { code, targetUrl: 'https://example.com/x' });
  return code;
}

describe('GET /metrics', () => {
  it('serves Prometheus text format', async () => {
    const { app } = await make();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(
      /^text\/plain; version=0\.0\.4/,
    );
    expect(res.body).toContain(
      '# TYPE http_request_duration_seconds histogram',
    );
  });

  it('includes default node process metrics in the same registry', async () => {
    const { app } = await make();
    const samples = await scrape(app);
    expect(select(samples, 'process_cpu_user_seconds_total')).toHaveLength(1);
    expect(select(samples, 'nodejs_eventloop_lag_seconds')).toHaveLength(1);
  });

  it('is not shadowed by /:code and other routes still work', async () => {
    const { app } = await make();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).not.toContain('not_found');
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
  });

  it('never rate limits scrapes', async () => {
    const { app } = await make({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_CREATE_MAX: '1',
      RATE_LIMIT_REDIRECT_MAX: '1',
      RATE_LIMIT_READ_MAX: '1',
    });
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('is a 404 when METRICS_ENABLED=false', async () => {
    const config = testConfig({ METRICS_ENABLED: 'false' });
    const metrics = await newMetrics(appRedis);
    const app = buildApp(config, { db: pool, redis: appRedis, metrics });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('is open without METRICS_TOKEN, even if a header is sent', async () => {
    const { app } = await make();
    await scrape(app);
    await scrape(app, { authorization: 'Bearer whatever' });
  });

  describe('with METRICS_TOKEN', () => {
    const token = 'scrape-token-0123456789';

    it('rejects a missing token with 401 in the app error format', async () => {
      const { app } = await make({ METRICS_TOKEN: token });
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.json().error.code).toBe('unauthorized');
      expect(res.body).not.toContain('http_request_duration_seconds');
    });

    it.each([
      ['wrong token', 'Bearer scrape-token-0123456788'],
      ['shorter token', 'Bearer scrape'],
      ['longer token', 'Bearer scrape-token-0123456789x'],
      ['wrong scheme', 'Basic scrape-token-0123456789'],
      ['no scheme', 'scrape-token-0123456789'],
      ['empty', ''],
      ['bearer only', 'Bearer '],
    ])('rejects %s', async (_n, authorization) => {
      const { app } = await make({ METRICS_TOKEN: token });
      const res = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.json().error.code).toBe('unauthorized');
    });

    it('accepts the right token', async () => {
      const { app } = await make({ METRICS_TOKEN: token });
      await scrape(app, { authorization: `Bearer ${token}` });
    });

    it('does not protect other routes', async () => {
      const { app } = await make({ METRICS_TOKEN: token });
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    });
  });
});

describe('http_request_duration_seconds', () => {
  it('records pattern routes with method and status_code', async () => {
    const { app } = await make();
    await app.inject({ url: '/healthz' });
    const code = await seedLink();
    await app.inject({ url: `/${code}` });
    await app.inject({ url: `/api/links/${code}` });
    await app.inject({
      method: 'POST',
      url: '/api/links',
      payload: { url: 'https://example.com/y' },
    });
    const s = await scrape(app);
    const count = (method: string, route: string, status_code: string) =>
      valueOf(s, 'http_request_duration_seconds_count', {
        method,
        route,
        status_code,
      });
    expect(count('GET', '/healthz', '200')).toBe(1);
    expect(count('GET', '/:code', '302')).toBe(1);
    expect(count('GET', '/api/links/:code', '200')).toBe(1);
    expect(count('POST', '/api/links', '201')).toBe(1);
    expect(
      valueOf(s, 'http_request_duration_seconds_sum', {
        route: '/healthz',
      }),
    ).toBeGreaterThan(0);
  });

  it('has fine low-latency buckets', async () => {
    const { app } = await make();
    await app.inject({ url: '/healthz' });
    const s = await scrape(app);
    const les = select(s, 'http_request_duration_seconds_bucket', {
      route: '/healthz',
    }).map((x) => x.labels.le);
    for (const le of ['0.001', '1', '+Inf']) {
      expect(les).toContain(le);
    }
    expect(les.length).toBeGreaterThanOrEqual(8);
  });

  it('labels unknown paths as "unmatched"', async () => {
    const { app } = await make();
    const res = await app.inject({ url: '/a/b/c/nothing-here' });
    expect(res.statusCode).toBe(404);
    const s = await scrape(app);
    expect(
      valueOf(s, 'http_request_duration_seconds_count', {
        method: 'GET',
        route: 'unmatched',
        status_code: '404',
      }),
    ).toBe(1);
  });

  it('keeps route cardinality small with many paths and codes', async () => {
    const { app } = await make();
    const paths: string[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = randomBytes(6).toString('hex');
      paths.push(`/unknown-${id}/deep/${i}`);
      codes.push(`zz${id}`);
    }
    for (const p of paths) {
      await app.inject({ url: p });
    }
    for (const c of codes) {
      await app.inject({ url: `/${c}` });
      await app.inject({ url: `/api/links/${c}` });
    }
    const s = await scrape(app);
    const series = select(s, 'http_request_duration_seconds_count');
    const routes = new Set(series.map((x) => x.labels.route ?? '<missing>'));
    expect(routes.size).toBeLessThanOrEqual(8);
    const allowed = new Set([
      '/:code',
      '/api/links',
      '/api/links/:code',
      '/healthz',
      '/readyz',
      '/metrics',
      'unmatched',
    ]);
    for (const r of routes) {
      expect(allowed.has(r)).toBe(true);
    }
    for (const x of series) {
      for (const v of Object.values(x.labels)) {
        for (const needle of [...paths, ...codes]) {
          expect(v).not.toContain(needle);
        }
        expect(v).not.toContain('unknown-');
      }
    }
    expect(
      valueOf(s, 'http_request_duration_seconds_count', {
        route: 'unmatched',
        status_code: '404',
      }),
    ).toBe(30);
    expect(
      valueOf(s, 'http_request_duration_seconds_count', { route: '/:code' }),
    ).toBe(30);
  });
});

describe('redirect_cache_total', () => {
  it('counts miss, then hit for an existing link', async () => {
    const { app } = await make();
    const code = await seedLink();
    expect((await app.inject({ url: `/${code}` })).statusCode).toBe(302);
    let s = await scrape(app);
    expect(valueOf(s, 'redirect_cache_total', { result: 'miss' })).toBe(1);
    expect(valueOf(s, 'redirect_cache_total', { result: 'hit' })).toBe(0);
    await app.inject({ url: `/${code}` });
    await app.inject({ url: `/${code}` });
    s = await scrape(app);
    expect(valueOf(s, 'redirect_cache_total', { result: 'miss' })).toBe(1);
    expect(valueOf(s, 'redirect_cache_total', { result: 'hit' })).toBe(2);
    expect(valueOf(s, 'redirect_cache_total', { result: 'negative' })).toBe(0);
  });

  it('counts miss, then negative for an unknown code', async () => {
    const { app } = await make();
    const code = uniqueCode('nx');
    trackKey(cacheKey(code));
    await app.inject({ url: `/${code}` });
    await app.inject({ url: `/${code}` });
    const s = await scrape(app);
    expect(valueOf(s, 'redirect_cache_total', { result: 'miss' })).toBe(1);
    expect(valueOf(s, 'redirect_cache_total', { result: 'negative' })).toBe(1);
  });

  it('counts a redirect with no Redis as miss', async () => {
    const { app } = await make({}, { redis: undefined });
    const code = await seedLink();
    await app.inject({ url: `/${code}` });
    await app.inject({ url: `/${code}` });
    const s = await scrape(app);
    expect(valueOf(s, 'redirect_cache_total', { result: 'miss' })).toBe(2);
    expect(valueOf(s, 'redirect_cache_total', { result: 'hit' })).toBe(0);
  });

  it('does not count non-redirect routes', async () => {
    const { app } = await make();
    await app.inject({ url: '/healthz' });
    await app.inject({ url: '/api/links/whatever' });
    const s = await scrape(app);
    expect(select(s, 'redirect_cache_total').every((x) => x.value === 0)).toBe(
      true,
    );
  });

  it('keeps registries per app', async () => {
    const a = await make();
    const b = await make();
    const code = await seedLink();
    await a.app.inject({ url: `/${code}` });
    const sb = await scrape(b.app);
    expect(valueOf(sb, 'redirect_cache_total', { result: 'miss' })).toBe(0);
  });
});

describe('rate_limit_rejected_total', () => {
  const limits = {
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_CREATE_MAX: '1',
    RATE_LIMIT_REDIRECT_MAX: '1',
    RATE_LIMIT_READ_MAX: '1',
  };

  it('counts 429s per route pattern, unmatched for the 404 bucket', async () => {
    // No Redis: the per-instance fallback store, unique per app.
    const { app } = await make(limits, { redis: undefined });
    const code = uniqueCode('rl');
    const get = (url: string) => app.inject({ url });
    expect((await get(`/${code}`)).statusCode).toBe(404);
    expect((await get(`/${code}`)).statusCode).toBe(429);
    expect((await get(`/${code}`)).statusCode).toBe(429);
    expect((await get(`/api/links/${code}`)).statusCode).toBe(404);
    expect((await get(`/api/links/${code}`)).statusCode).toBe(429);
    expect((await get('/no/such/path')).statusCode).toBe(404);
    expect((await get('/no/such/path')).statusCode).toBe(429);
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/links',
        payload: { url: 'https://example.com/z' },
      });
    expect((await post()).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(429);

    const s = await scrape(app);
    expect(valueOf(s, 'rate_limit_rejected_total', { route: '/:code' })).toBe(
      2,
    );
    expect(
      valueOf(s, 'rate_limit_rejected_total', { route: '/api/links/:code' }),
    ).toBe(1);
    expect(
      valueOf(s, 'rate_limit_rejected_total', { route: 'unmatched' }),
    ).toBe(1);
    expect(
      valueOf(s, 'rate_limit_rejected_total', { route: '/api/links' }),
    ).toBe(1);
    for (const x of select(s, 'rate_limit_rejected_total')) {
      expect(x.labels.route).not.toContain(code);
    }
    expect(
      valueOf(s, 'http_request_duration_seconds_count', {
        route: '/:code',
        status_code: '429',
      }),
    ).toBe(2);
  });

  it('does not count requests that were allowed', async () => {
    const { app } = await make(limits, { redis: undefined });
    await app.inject({ url: `/${uniqueCode('ok')}` });
    const s = await scrape(app);
    expect(
      select(s, 'rate_limit_rejected_total').every((x) => x.value === 0),
    ).toBe(true);
  });
});

describe('gauges', () => {
  it('reports pg pool connections by state', async () => {
    const { app } = await make();
    await pool.query('SELECT 1');
    const s = await scrape(app);
    const states = select(s, 'pg_pool_connections').map((x) => x.labels.state);
    expect(states.sort()).toEqual(['idle', 'total', 'waiting']);
    const total = valueOf(s, 'pg_pool_connections', { state: 'total' });
    const idle = valueOf(s, 'pg_pool_connections', { state: 'idle' });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(idle).toBeLessThanOrEqual(total);
  });

  it('reads the pool at scrape time', async () => {
    const { app } = await make();
    vi.spyOn(pool, 'totalCount', 'get').mockReturnValue(42);
    vi.spyOn(pool, 'idleCount', 'get').mockReturnValue(7);
    vi.spyOn(pool, 'waitingCount', 'get').mockReturnValue(3);
    const s = await scrape(app);
    expect(valueOf(s, 'pg_pool_connections', { state: 'total' })).toBe(42);
    expect(valueOf(s, 'pg_pool_connections', { state: 'idle' })).toBe(7);
    expect(valueOf(s, 'pg_pool_connections', { state: 'waiting' })).toBe(3);
  });

  it('redis_ready is 1 for a ready client', async () => {
    const { app } = await make();
    const s = await scrape(app);
    expect(select(s, 'redis_ready')).toHaveLength(1);
    expect(valueOf(s, 'redis_ready')).toBe(1);
  });

  it('redis_ready is 0 for a dead client and with no client', async () => {
    const dead = await make({}, { redis: deadRedis });
    expect(valueOf(await scrape(dead.app), 'redis_ready')).toBe(0);
    const none = await make({}, { redis: undefined });
    const s = await scrape(none.app);
    expect(select(s, 'redis_ready')).toHaveLength(1);
    expect(valueOf(s, 'redis_ready')).toBe(0);
  });

  it('redis_ready follows the client status at scrape time', async () => {
    const { app } = await make();
    expect(valueOf(await scrape(app), 'redis_ready')).toBe(1);
    vi.spyOn(appRedis, 'status', 'get').mockReturnValue('reconnecting');
    expect(valueOf(await scrape(app), 'redis_ready')).toBe(0);
  });
});

describe('createMetrics', () => {
  it('records each method into its own series', async () => {
    const m = await newMetrics(appRedis);
    m.cacheResult('hit');
    m.cacheResult('hit');
    m.cacheResult('negative');
    m.rateLimited('/:code');
    m.clickRecorded();
    m.clickRecorded();
    m.clickRecorded();
    m.clickFlush('ok', 0.02);
    m.clickFlush('error', 0.5);
    m.clickFlush('skipped', 0);
    const s = parseMetrics(await m.register.metrics());
    expect(valueOf(s, 'redirect_cache_total', { result: 'hit' })).toBe(2);
    expect(valueOf(s, 'redirect_cache_total', { result: 'negative' })).toBe(1);
    expect(valueOf(s, 'rate_limit_rejected_total', { route: '/:code' })).toBe(
      1,
    );
    expect(valueOf(s, 'clicks_recorded_total')).toBe(3);
    expect(valueOf(s, 'click_flush_total', { result: 'ok' })).toBe(1);
    expect(valueOf(s, 'click_flush_total', { result: 'error' })).toBe(1);
    expect(valueOf(s, 'click_flush_total', { result: 'skipped' })).toBe(1);
    expect(valueOf(s, 'click_flush_duration_seconds_count')).toBe(3);
    expect(valueOf(s, 'click_flush_duration_seconds_sum')).toBeCloseTo(0.52, 5);
  });

  it('does not share state between instances or the global registry', async () => {
    const a = await newMetrics(appRedis);
    const b = await newMetrics(appRedis);
    expect(a.register).not.toBe(b.register);
    a.clickRecorded();
    const sb = parseMetrics(await b.register.metrics());
    expect(valueOf(sb, 'clicks_recorded_total')).toBe(0);
    const prom = await import('prom-client');
    expect(await prom.register.getSingleMetric('clicks_recorded_total')).toBe(
      undefined,
    );
  });
});

describe('click counter instrumentation', () => {
  function counter(
    redis: typeof appRedis,
    metrics: Pick<Metrics, 'clickRecorded' | 'clickFlush'>,
    db = pool,
  ) {
    const prefix = `test-metrics-${randomBytes(6).toString('hex')}`;
    prefixes.push(prefix);
    return {
      prefix,
      clicks: createClickCounter({
        redis,
        db,
        prefix,
        metrics: metrics as Metrics,
      }),
    };
  }
  const spy = () => ({ clickRecorded: vi.fn(), clickFlush: vi.fn() });

  it('calls clickRecorded once per recorded click', async () => {
    const m = spy();
    const { clicks } = counter(appRedis, m);
    await clicks.record('abc');
    await clicks.record('abc');
    expect(m.clickRecorded).toHaveBeenCalledTimes(2);
  });

  it('does not count a click that could not be recorded', async () => {
    const m = spy();
    const { clicks } = counter(deadRedis, m);
    await clicks.record('abc');
    expect(m.clickRecorded).not.toHaveBeenCalled();
  });

  it('reports ok with a duration when it flushed', async () => {
    const m = spy();
    const code = await seedLink();
    const { clicks } = counter(appRedis, m);
    await clicks.record(code);
    expect(await clicks.flush()).toEqual({ codes: 1, clicks: 1 });
    expect(m.clickFlush).toHaveBeenCalledTimes(1);
    const call = m.clickFlush.mock.calls[0];
    expect(call).toBeDefined();
    const [result, seconds] = call ?? [];
    expect(result).toBe('ok');
    expect(typeof seconds).toBe('number');
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThan(5);
  });

  it('reports ok when nothing was pending', async () => {
    const m = spy();
    const { clicks } = counter(appRedis, m);
    expect(await clicks.flush()).toEqual({ codes: 0, clicks: 0 });
    expect(m.clickFlush).toHaveBeenCalledTimes(1);
    expect(m.clickFlush.mock.calls[0]?.[0]).toBe('ok');
  });

  it('reports skipped when the lock is held', async () => {
    const m = spy();
    const { clicks, prefix } = counter(appRedis, m);
    await raw.set(`${prefix}:lock`, 'someone-else', 'EX', 30);
    expect(await clicks.flush()).toBeNull();
    expect(m.clickFlush).toHaveBeenCalledTimes(1);
    expect(m.clickFlush.mock.calls[0]?.[0]).toBe('skipped');
  });

  it('reports error, not skipped, when taking the lock fails', async () => {
    const m = spy();
    const { clicks, prefix } = counter(appRedis, m);
    const set = vi.spyOn(appRedis, 'set');
    set.mockRejectedValueOnce(new Error('lock boom') as never);
    expect(await clicks.flush()).toBeNull();
    expect(set.mock.calls[0]?.[0]).toBe(`${prefix}:lock`);
    expect(m.clickFlush).toHaveBeenCalledTimes(1);
    expect(m.clickFlush.mock.calls[0]?.[0]).toBe('error');
  });

  it('reports skipped when Redis is unavailable', async () => {
    const m = spy();
    const { clicks } = counter(deadRedis, m);
    expect(await clicks.flush()).toBeNull();
    expect(m.clickFlush).toHaveBeenCalledTimes(1);
    expect(m.clickFlush.mock.calls[0]?.[0]).toBe('skipped');
  });

  it('reports error when the DB write fails', async () => {
    const m = spy();
    const { clicks } = counter(appRedis, m);
    await clicks.record('whatever');
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('db down') as never);
    expect(await clicks.flush()).toBeNull();
    expect(m.clickFlush).toHaveBeenCalledTimes(1);
    expect(m.clickFlush.mock.calls[0]?.[0]).toBe('error');
  });

  it('works without metrics (unchanged behavior)', async () => {
    const prefix = `test-metrics-${randomBytes(6).toString('hex')}`;
    prefixes.push(prefix);
    const clicks = createClickCounter({ redis: appRedis, db: pool, prefix });
    await clicks.record('abc');
    expect(await clicks.flush()).not.toBeNull();
  });

  it('feeds the app registry end to end', async () => {
    const metrics = await newMetrics(appRedis);
    const prefix = `test-metrics-${randomBytes(6).toString('hex')}`;
    prefixes.push(prefix);
    const clicks = createClickCounter({
      redis: appRedis,
      db: pool,
      prefix,
      metrics,
    });
    const app = buildApp(testConfig({ BASE_URL: 'http://short.test' }), {
      db: pool,
      redis: appRedis,
      clicks,
      metrics,
    });
    apps.push(app);
    const code = await seedLink();
    await app.inject({ url: `/${code}` });
    await app.inject({ url: `/${code}` });
    await clicks.flush();
    const s = await scrape(app);
    expect(valueOf(s, 'clicks_recorded_total')).toBe(2);
    expect(valueOf(s, 'click_flush_total', { result: 'ok' })).toBe(1);
    expect(valueOf(s, 'click_flush_duration_seconds_count')).toBe(1);
  });
});
