import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/metrics.js';
import { usePool } from './helpers/db.js';

const pool = usePool();
const token = 'metrics-token-0123456789';
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) {
    await a.close();
  }
});

function make(env: Record<string, string>) {
  const config = loadConfig({ RATE_LIMIT_ENABLED: 'false', ...env });
  const app = buildApp(config, {
    db: pool,
    metrics: createMetrics({ db: pool }),
  });
  apps.push(app);
  return app;
}
const get = (app: ReturnType<typeof buildApp>, url: string, auth?: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: auth === undefined ? {} : { authorization: auth },
  });

describe('Vercel without METRICS_TOKEN', () => {
  it.each(['/metrics', '/readyz'])('%s is a plain 404', async (url) => {
    const app = make({ VERCEL: '1' });
    for (const auth of [undefined, `Bearer ${token}`]) {
      const res = await get(app, url, auth);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });

  it('/metrics is served with an explicit METRICS_ENABLED=true', async () => {
    const app = make({ VERCEL: '1', METRICS_ENABLED: 'true' });
    expect((await get(app, '/metrics')).statusCode).toBe(200);
    expect((await get(app, '/readyz')).statusCode).toBe(404);
  });

  it('/healthz stays public', async () => {
    expect((await get(make({ VERCEL: '1' }), '/healthz')).statusCode).toBe(200);
  });
});

describe('Vercel with METRICS_TOKEN', () => {
  it.each(['/metrics', '/readyz'])(
    '%s requires the bearer token',
    async (url) => {
      const app = make({ VERCEL: '1', METRICS_TOKEN: token });
      for (const auth of [
        undefined,
        '',
        'Bearer wrong-token-0123456789',
        `Basic ${token}`,
        `Bearer ${token}${token}`,
      ]) {
        const res = await get(app, url, auth);
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
        expect(res.json()).toEqual({
          error: { code: 'unauthorized', message: 'Unauthorized' },
        });
      }
      expect((await get(app, url, `Bearer ${token}`)).statusCode).toBe(200);
    },
  );

  it('/readyz reports checks once authorized and /healthz stays public', async () => {
    const app = make({ VERCEL: '1', METRICS_TOKEN: token });
    const res = await get(app, '/readyz', `Bearer ${token}`);
    expect(res.json().checks.postgres).toBe('ok');
    expect((await get(app, '/healthz')).statusCode).toBe(200);
  });

  it('METRICS_ENABLED=false hides /metrics but keeps authenticated /readyz', async () => {
    const app = make({
      VERCEL: '1',
      METRICS_TOKEN: token,
      METRICS_ENABLED: 'false',
    });
    expect((await get(app, '/metrics', `Bearer ${token}`)).statusCode).toBe(
      404,
    );
    expect((await get(app, '/readyz')).statusCode).toBe(401);
  });
});

describe('off Vercel', () => {
  it('/readyz needs no auth even when METRICS_TOKEN is set', async () => {
    const app = make({ METRICS_TOKEN: token });
    expect((await get(app, '/readyz')).statusCode).toBe(200);
    expect((await get(app, '/metrics')).statusCode).toBe(401);
  });

  it('/metrics and /readyz are open by default', async () => {
    const app = make({});
    expect((await get(app, '/readyz')).statusCode).toBe(200);
    expect((await get(app, '/metrics')).statusCode).toBe(200);
  });
});
