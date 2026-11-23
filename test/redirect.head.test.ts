import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { insertLink } from '../src/db/links.js';
import { testConfig } from './helpers/config.js';
import { uniqueCode, usePool } from './helpers/db.js';

const pool = usePool();
const config = testConfig({ BASE_URL: 'http://short.test' });
const apps: ReturnType<typeof buildApp>[] = [];
afterAll(async () => {
  for (const a of apps) {
    await a.close();
  }
});

function spy() {
  const record = vi.fn(async (code: string) => {
    void code;
  });
  const clicks = {
    record,
    flush: vi.fn(async () => null),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const app = buildApp(config, { db: pool, clicks });
  apps.push(app);
  return { app, record };
}

async function fresh() {
  const code = uniqueCode('hd');
  await insertLink(pool, { code, targetUrl: 'https://example.com/hd' });
  return code;
}

describe('HEAD /:code', () => {
  it('redirects like GET but records no click', async () => {
    const { app, record } = spy();
    const code = await fresh();
    const get = await app.inject({ method: 'GET', url: `/${code}` });
    expect(get.statusCode).toBe(302);
    expect(record).toHaveBeenCalledTimes(1);
    record.mockClear();
    const head = await app.inject({ method: 'HEAD', url: `/${code}` });
    expect(head.statusCode).toBe(302);
    expect(head.headers.location).toBe(get.headers.location);
    expect(head.headers.location).toBe('https://example.com/hd');
    expect(record).not.toHaveBeenCalled();
  });

  it('does not record on repeated HEAD requests either', async () => {
    const { app, record } = spy();
    const code = await fresh();
    for (let i = 0; i < 3; i++) {
      expect(
        (await app.inject({ method: 'HEAD', url: `/${code}` })).statusCode,
      ).toBe(302);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('GET still records exactly once', async () => {
    const { app, record } = spy();
    const code = await fresh();
    await app.inject({ method: 'GET', url: `/${code}` });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(code);
  });

  it('is still 404 for an unknown code', async () => {
    const { app, record } = spy();
    const res = await app.inject({
      method: 'HEAD',
      url: `/${uniqueCode('nx')}`,
    });
    expect(res.statusCode).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });
});
