import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { insertLink } from '../src/db/links.js';
import { createMetrics } from '../src/metrics.js';
import { createServerless } from '../src/vercel.js';
import { testConfig } from './helpers/config.js';
import { uniqueCode, testDatabaseUrl, usePool } from './helpers/db.js';
import { parseMetrics, select } from './helpers/metrics.js';

const pool = usePool();
const metrics = createMetrics({ db: pool });
const app = buildApp(testConfig({ BASE_URL: 'http://short.test' }), {
  db: pool,
  metrics,
});
afterAll(() => app.close());

const STATIC = [
  { url: '/', type: 'text/html; charset=utf-8' },
  { url: '/app.js', type: 'text/javascript; charset=utf-8' },
  { url: '/styles.css', type: 'text/css; charset=utf-8' },
  { url: '/favicon.svg', type: 'image/svg+xml' },
];

const CSP_PARTS = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

type Headers = Record<string, string | string[] | number | undefined>;

function expectStaticHeaders(headers: Headers, type: string, url: string) {
  expect(String(headers['content-type'])).toContain(type.split(';')[0]);
  if (type.includes('charset')) {
    expect(String(headers['content-type']).startsWith(type)).toBe(true);
  }
  const csp = String(headers['content-security-policy']);
  for (const part of CSP_PARTS) {
    expect(csp).toContain(part);
  }
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');
  const cache = String(headers['cache-control']);
  expect(cache).toContain('public');
  const maxAge = /max-age=(\d+)/.exec(cache);
  expect(maxAge).not.toBeNull();
  expect(Number(maxAge?.[1])).toBeLessThanOrEqual(3600);
  if (url === '/') {
    expect(cache).not.toContain('immutable');
  }
  expect(typeof headers['x-request-id']).toBe('string');
}

describe('static routes via buildApp', () => {
  it.each(STATIC)('GET $url returns 200 with $type', async ({ url, type }) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expectStaticHeaders(res.headers, type, url);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET / serves the form and same-origin asset references', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('id="shorten-form"');
    expect(res.body).toMatch(/<script[^>]*src="\/app\.js"/);
    expect(res.body).toContain('href="/styles.css"');
  });

  it.each(STATIC)(
    'HEAD $url has same headers and empty body',
    async ({ url, type }) => {
      const get = await app.inject({ method: 'GET', url });
      const head = await app.inject({ method: 'HEAD', url });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expectStaticHeaders(head.headers, type, url);
      expect(head.headers['content-type']).toBe(get.headers['content-type']);
      expect(head.headers['content-security-policy']).toBe(
        get.headers['content-security-policy'],
      );
    },
  );

  it('echoes an incoming x-request-id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-request-id': 'static-req-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('static-req-1');
  });

  it('POST / is the app 404 not_found JSON', async () => {
    const res = await app.inject({ method: 'POST', url: '/', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('GET /index.html is not served (404 not_found JSON)', async () => {
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('static routes do not interfere', () => {
  it('keeps /healthz working', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('still redirects a seeded short code', async () => {
    const code = uniqueCode('h');
    await insertLink(pool, { code, targetUrl: 'https://example.com/home' });
    const res = await app.inject({ method: 'GET', url: `/${code}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/home');
  });

  it('still 404s an unknown code', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope_unknown_zz' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('still creates links via /api/links', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/links',
      payload: { url: 'https://example.com/created' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().shortUrl).toMatch(/^http:\/\/short\.test\//);
  });

  it('treats a code named "app" as a normal short code', async () => {
    await pool.query('DELETE FROM links WHERE code = $1', ['app']);
    const link = await insertLink(pool, {
      code: 'app',
      targetUrl: 'https://example.com/app-code',
    });
    expect(link).not.toBeNull();
    try {
      const res = await app.inject({ method: 'GET', url: '/app' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://example.com/app-code');
    } finally {
      await pool.query('DELETE FROM links WHERE code = $1', ['app']);
    }
  });
});

describe('static routes and metrics', () => {
  it('labels static routes with literal patterns and stays bounded', async () => {
    for (const { url } of STATIC) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    }
    for (let i = 0; i < 30; i++) {
      const path = `/zz${Math.random().toString(36).slice(2)}${i}`;
      await app.inject({ method: 'GET', url: path });
    }
    const scraped = await metrics.register.metrics();
    const samples = parseMetrics(scraped);
    const routes = new Set(
      select(samples, 'http_request_duration_seconds_count').map(
        (s) => s.labels.route,
      ),
    );
    for (const { url } of STATIC) {
      expect(routes).toContain(url);
    }
    expect(routes.size).toBeLessThanOrEqual(10);
  });
});

describe('static routes over real HTTP (createServerless)', () => {
  it.each(STATIC)('serves $url', async ({ url, type }) => {
    const s = createServerless({
      env: { DATABASE_URL: testDatabaseUrl(), RATE_LIMIT_ENABLED: 'false' },
      db: pool,
    });
    const server = http.createServer(s.handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}${url}`);
      expect(res.status).toBe(200);
      const headers: Headers = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      expectStaticHeaders(headers, type, url);
      expect((await res.text()).length).toBeGreaterThan(0);
      const head = await fetch(`${base}${url}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    } finally {
      await new Promise((r) => server.close(r));
      await s.close();
    }
  });
});
