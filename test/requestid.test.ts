import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers/config.js';
import { usePool } from './helpers/db.js';

const pool = usePool();
const apps: ReturnType<typeof buildApp>[] = [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterAll(async () => {
  for (const a of apps) {
    await a.close();
  }
});

function capture() {
  const chunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const app = buildApp(testConfig(), { db: pool, logStream });
  apps.push(app);
  return {
    app,
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('x-request-id', () => {
  const app = buildApp(testConfig(), { db: pool });
  apps.push(app);

  it('generates a UUID-shaped id when none is sent', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('generates a different id per request', async () => {
    const a = await app.inject({ method: 'GET', url: '/healthz' });
    const b = await app.inject({ method: 'GET', url: '/healthz' });
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it.each(['abc123', 'a', 'A.b_c-d.1', 'x'.repeat(64), 'req-2024.11.22_x'])(
    'echoes valid incoming id %j',
    async (id) => {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-request-id': id },
      });
      expect(res.headers['x-request-id']).toBe(id);
    },
  );

  it.each([
    ['too long', 'x'.repeat(65)],
    ['space', 'has space'],
    ['slash', 'a/b'],
    ['semicolon', 'a;b'],
    ['non-ascii', 'idé'],
    ['empty', ''],
  ])('replaces invalid incoming id (%s)', async (_name, id) => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': id },
    });
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('replaces an id containing CRLF', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'abc\r\nSet-Cookie: x=1' },
    });
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is present on 404 and error-format responses too', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/links/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBeTruthy();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/links',
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(bad.statusCode).toBe(415);
    expect(bad.headers['x-request-id']).toBeTruthy();
  });
});

describe('request logging', () => {
  it('uses the echoed x-request-id as request.id in log lines', async () => {
    const { app, lines } = capture();
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'trace-me-123' },
    });
    expect(res.headers['x-request-id']).toBe('trace-me-123');
    expect(lines().some((l) => l.reqId === 'trace-me-123')).toBe(true);
  });

  it('uses the generated id as request.id in log lines', async () => {
    const { app, lines } = capture();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const id = res.headers['x-request-id'];
    expect(id).toMatch(UUID);
    expect(lines().some((l) => l.reqId === id)).toBe(true);
  });

  it('never logs authorization or cookie request headers', async () => {
    const { app, lines, text } = capture();
    const res = await app.inject({
      method: 'GET',
      url: '/api/links/doesnotexist',
      headers: {
        authorization: 'Bearer secret-token-value',
        cookie: 'sid=secret',
      },
    });
    expect(res.statusCode).toBe(404);
    // Guard against a vacuous pass: this request must have produced log lines.
    expect(lines().some((l) => l.reqId === res.headers['x-request-id'])).toBe(
      true,
    );
    expect(text()).not.toContain('secret-token-value');
    expect(text()).not.toContain('sid=secret');
    expect(text().toLowerCase()).not.toContain('"authorization"');
    expect(text().toLowerCase()).not.toContain('"cookie"');
  });
});
