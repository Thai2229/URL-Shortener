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
import { generateCode } from '../src/code.js';
import { testConfig } from './helpers/config.js';
import { findLinkByCode, insertLink } from '../src/db/links.js';
import { uniqueCode, usePool } from './helpers/db.js';

vi.mock('../src/code.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/code.js')>();
  return { generateCode: vi.fn(actual.generateCode) };
});

const pool = usePool();
const BASE = 'http://short.test';
const app = buildApp(testConfig({ BASE_URL: BASE }), { db: pool });
const slashApp = buildApp(testConfig({ BASE_URL: 'http://Short.Test:8080/' }), {
  db: pool,
});
const shoApp = buildApp(testConfig({ BASE_URL: 'https://sho.rt' }), {
  db: pool,
});
const localApp = buildApp(testConfig({ BASE_URL: 'http://localhost:3000' }), {
  db: pool,
});
let realGenerate: typeof generateCode;

beforeAll(async () => {
  const actual =
    await vi.importActual<typeof import('../src/code.js')>('../src/code.js');
  realGenerate = actual.generateCode;
});
afterEach(() => {
  vi.mocked(generateCode).mockReset();
  vi.mocked(generateCode).mockImplementation(realGenerate);
});
afterAll(async () => {
  await app.close();
  await slashApp.close();
  await shoApp.close();
  await localApp.close();
});

function create(body: unknown, target = app) {
  return target.inject({
    method: 'POST',
    url: '/api/links',
    payload: body as object,
  });
}

function expectError(
  res: { statusCode: number; json: () => unknown },
  status: number,
  code: string,
) {
  expect(res.statusCode).toBe(status);
  const body = res.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
}

describe('POST /api/links', () => {
  it('creates a link and stores it', async () => {
    const res = await create({ url: 'https://example.com/a?b=1' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(body.shortUrl).toBe(`${BASE}/${body.code}`);
    expect(body.url).toBe('https://example.com/a?b=1');
    expect(body.expiresAt).toBeNull();
    const row = await findLinkByCode(pool, body.code);
    expect(row?.targetUrl).toBe('https://example.com/a?b=1');
  });

  it('stores and returns expiresAt', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await create({ url: 'https://example.com/e', expiresAt });
    expect(res.statusCode).toBe(201);
    expect(new Date(res.json().expiresAt).getTime()).toBe(
      new Date(expiresAt).getTime(),
    );
    const row = await findLinkByCode(pool, res.json().code);
    expect(row?.expiresAt?.getTime()).toBe(new Date(expiresAt).getTime());
  });

  it('builds shortUrl without a double slash when BASE_URL ends with /', async () => {
    const res = await create({ url: 'https://example.com/s' }, slashApp);
    expect(res.statusCode).toBe(201);
    expect(res.json().shortUrl).toBe(
      `http://Short.Test:8080/${res.json().code}`,
    );
  });

  it('trims surrounding whitespace in url', async () => {
    const res = await create({ url: '  https://example.com/t \n' });
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe('https://example.com/t');
  });

  it('gives different codes for the same url', async () => {
    const a = await create({ url: 'https://example.com/same' });
    const b = await create({ url: 'https://example.com/same' });
    expect(a.json().code).not.toBe(b.json().code);
  });

  it('accepts http and a url of exactly 2048 chars', async () => {
    const url = 'http://example.com/' + 'x'.repeat(2048 - 19);
    expect(url).toHaveLength(2048);
    const res = await create({ url });
    expect(res.statusCode).toBe(201);
  });

  describe('url validation', () => {
    it.each([
      ['not a url', 'not a url'],
      ['empty', ''],
      ['blank', '   '],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<script>1</script>'],
      ['ftp:', 'ftp://example.com/file'],
      ['file:', 'file:///etc/passwd'],
      ['too long', 'https://example.com/' + 'x'.repeat(2049 - 20)],
      ['credentials', 'https://user:pass@example.com/'],
      ['username only', 'https://user@example.com/'],
      ['own host', 'http://short.test/abc'],
      ['own host, other case', 'http://SHORT.test/abc'],
    ])('rejects %s', async (_name, url) => {
      expectError(await create({ url }), 400, 'invalid_url');
    });

    it('rejects own host including port, allows same host on another port', async () => {
      expectError(
        await create({ url: 'http://short.test:8080/x' }, slashApp),
        400,
        'invalid_url',
      );
      expectError(
        await create({ url: 'HTTP://SHORT.TEST:8080/x' }, slashApp),
        400,
        'invalid_url',
      );
      const other = await create({ url: 'http://short.test:9090/x' }, slashApp);
      expect(other.statusCode).toBe(201);
    });

    it.each([
      ['missing url', {}],
      ['null url', { url: null }],
      ['numeric url', { url: 42 }],
      ['array url', { url: ['https://example.com'] }],
      ['object url', { url: { href: 'https://example.com' } }],
    ])('rejects body schema failure: %s', async (_name, body) => {
      expectError(await create(body), 400, 'invalid_url');
    });

    it.each(['text/plain', 'application/xml'])(
      'rejects content type %s with 415 bad_request',
      async (type) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/links',
          headers: { 'content-type': type },
          payload: 'https://example.com',
        });
        expectError(res, 415, 'bad_request');
      },
    );

    it('rejects malformed JSON with 400 bad_request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/links',
        headers: { 'content-type': 'application/json' },
        payload: '{"url":',
      });
      expectError(res, 400, 'bad_request');
    });

    it('rejects an empty body with JSON content type as 400 bad_request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/links',
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      expectError(res, 400, 'bad_request');
    });

    it('rejects a body over 1 MiB with 413 bad_request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/links',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          url: 'https://example.com/' + 'x'.repeat(1_048_576),
        }),
      });
      expectError(res, 413, 'bad_request');
    });

    it('uses a generic message for client errors', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/links',
        headers: { 'content-type': 'application/json' },
        payload: '{"url":',
      });
      const message = res.json().error.message as string;
      expect(message).not.toMatch(/JSON|token|position|FST_/i);
    });

    it('rejects a url that is only too long after normalization', async () => {
      const url = 'https://a.com/' + '\u00e9'.repeat(700);
      expect(url.length).toBeLessThan(2048);
      expect(new URL(url).href.length).toBeGreaterThan(2048);
      expectError(await create({ url }), 400, 'invalid_url');
    });

    it.each([
      ['trailing dot', 'https://sho.rt./x'],
      ['trailing dot, upper case, default port', 'https://SHO.RT.:443/x'],
      ['plain', 'https://sho.rt/x'],
    ])('rejects own host on sho.rt app: %s', async (_name, url) => {
      expectError(await create({ url }, shoApp), 400, 'invalid_url');
    });

    it('rejects own host with trailing dot on localhost app, allows other port', async () => {
      expectError(
        await create({ url: 'http://localhost.:3000/x' }, localApp),
        400,
        'invalid_url',
      );
      const other = await create({ url: 'http://localhost:3001/x' }, localApp);
      expect(other.statusCode).toBe(201);
    });
  });

  describe('expiresAt validation', () => {
    it.each([
      ['garbage', 'tomorrow-ish'],
      ['empty', ''],
      ['past', '2000-01-01T00:00:00Z'],
      ['one second ago', () => new Date(Date.now() - 1000).toISOString()],
      ['number', 12345],
      ['zoneless datetime', '2030-01-01T00:00:00'],
      ['space separated', '2030-01-01 00:00'],
      ['US date', '12/25/2030'],
      ['month name', 'Jan 1 2030'],
      ['year only', '2030'],
      ['over 10 years', '2099-01-01T00:00:00Z'],
      [
        '10 years plus a day',
        () => new Date(Date.now() + 3660 * 86_400_000).toISOString(),
      ],
    ])('rejects %s', async (_name, value) => {
      const expiresAt = typeof value === 'function' ? value() : value;
      expectError(
        await create({ url: 'https://example.com/x', expiresAt }),
        400,
        'invalid_expiry',
      );
    });

    it.each([
      ['2030-01-01T00:00:00Z', '2030-01-01T00:00:00.000Z'],
      ['2030-01-01T00:00:00.000+09:00', '2029-12-31T15:00:00.000Z'],
      ['2030-01-01T00:00-05:30', '2030-01-01T05:30:00.000Z'],
      ['2030-01-01', '2030-01-01T00:00:00.000Z'],
    ])('accepts %s and stores the UTC instant', async (input, iso) => {
      const res = await create({
        url: 'https://example.com/x',
        expiresAt: input,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().expiresAt).toBe(iso);
      const row = await findLinkByCode(pool, res.json().code);
      expect(row?.expiresAt?.toISOString()).toBe(iso);
    });

    it('treats expiresAt null as no expiry', async () => {
      const res = await create({
        url: 'https://example.com/x',
        expiresAt: null,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().expiresAt).toBeNull();
      const row = await findLinkByCode(pool, res.json().code);
      expect(row?.expiresAt).toBeNull();
    });

    it('does not store a link when validation fails', async () => {
      const url = `https://example.com/${uniqueCode('nostore')}`;
      await create({ url, expiresAt: '2000-01-01T00:00:00Z' });
      const { rowCount } = await pool.query(
        'SELECT 1 FROM links WHERE target_url = $1',
        [url],
      );
      expect(rowCount).toBe(0);
    });
  });

  describe('code collisions', () => {
    it('retries when the generated code is taken', async () => {
      const taken = uniqueCode('taken');
      const fresh = uniqueCode('fresh');
      await insertLink(pool, {
        code: taken,
        targetUrl: 'https://example.com/taken',
      });
      vi.mocked(generateCode)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(fresh);
      const res = await create({ url: 'https://example.com/retry' });
      expect(res.statusCode).toBe(201);
      expect(res.json().code).toBe(fresh);
      expect((await findLinkByCode(pool, taken))?.targetUrl).toBe(
        'https://example.com/taken',
      );
    });

    it('succeeds on the 5th attempt', async () => {
      const taken = uniqueCode('taken');
      const fresh = uniqueCode('fresh');
      await insertLink(pool, {
        code: taken,
        targetUrl: 'https://example.com/taken',
      });
      vi.mocked(generateCode)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(fresh);
      const res = await create({ url: 'https://example.com/fifth' });
      expect(res.statusCode).toBe(201);
      expect(res.json().code).toBe(fresh);
    });

    it('returns 500 internal_error after 5 failed attempts', async () => {
      const taken = uniqueCode('taken');
      await insertLink(pool, {
        code: taken,
        targetUrl: 'https://example.com/taken',
      });
      vi.mocked(generateCode).mockReturnValue(taken);
      const res = await create({ url: 'https://example.com/never' });
      expectError(res, 500, 'internal_error');
      expect(generateCode).toHaveBeenCalledTimes(5);
    });
  });
});

describe('GET /:code', () => {
  it('redirects with 302 to the stored url', async () => {
    const code = uniqueCode();
    await insertLink(pool, { code, targetUrl: 'https://example.com/go?x=1' });
    const res = await app.inject({ method: 'GET', url: `/${code}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/go?x=1');
  });

  it('is not cacheable by shared caches', async () => {
    const code = uniqueCode();
    await insertLink(pool, { code, targetUrl: 'https://example.com/nc' });
    const res = await app.inject({ method: 'GET', url: `/${code}` });
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('redirects a link whose expiry is still in the future', async () => {
    const code = uniqueCode();
    await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/future',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const res = await app.inject({ method: 'GET', url: `/${code}` });
    expect(res.statusCode).toBe(302);
  });

  it('works end to end after creating through the API', async () => {
    const created = await create({ url: 'https://example.com/e2e' });
    const res = await app.inject({
      method: 'GET',
      url: `/${created.json().code}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://example.com/e2e');
  });

  it('returns 404 not_found for an unknown code', async () => {
    expectError(
      await app.inject({ method: 'GET', url: `/${uniqueCode('nope')}` }),
      404,
      'not_found',
    );
  });

  it.each([
    ['dot', '/a.b'],
    ['33 chars', '/' + 'a'.repeat(33)],
    ['encoded space', '/a%20b'],
    ['unicode', '/caf%C3%A9'],
  ])('returns 404 not_found for an invalid code (%s)', async (_name, url) => {
    expectError(await app.inject({ method: 'GET', url }), 404, 'not_found');
  });

  it('accepts a 32 char code', async () => {
    const code = 'b'.repeat(32);
    await pool.query('DELETE FROM links WHERE code = $1', [code]);
    await insertLink(pool, { code, targetUrl: 'https://example.com/32' });
    const res = await app.inject({ method: 'GET', url: `/${code}` });
    expect(res.statusCode).toBe(302);
    await pool.query('DELETE FROM links WHERE code = $1', [code]);
  });

  it('returns 410 expired for an expired link', async () => {
    const code = uniqueCode();
    await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/old',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await app.inject({ method: 'GET', url: `/${code}` });
    expectError(res, 410, 'expired');
    expect(res.headers.location).toBeUndefined();
  });

  it('does not let a stored CRLF target inject headers', async () => {
    const url = 'https://example.com/a%0d%0aSet-Cookie:x';
    const created = await create({ url });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({
      method: 'GET',
      url: `/${created.json().code}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(url);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('keeps /healthz working', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /api/links/:code', () => {
  it('returns metadata', async () => {
    const code = uniqueCode();
    const link = await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/meta',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const res = await app.inject({ method: 'GET', url: `/api/links/${code}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      code,
      shortUrl: `${BASE}/${code}`,
      url: 'https://example.com/meta',
      createdAt: link?.createdAt.toISOString(),
      expiresAt: link?.expiresAt?.toISOString(),
      clickCount: 0,
    });
    expect(typeof res.json().clickCount).toBe('number');
  });

  it('returns null expiresAt when none is set', async () => {
    const code = uniqueCode();
    await insertLink(pool, { code, targetUrl: 'https://example.com/none' });
    const res = await app.inject({ method: 'GET', url: `/api/links/${code}` });
    expect(res.json().expiresAt).toBeNull();
  });

  it('still returns 200 for an expired link', async () => {
    const code = uniqueCode();
    await insertLink(pool, {
      code,
      targetUrl: 'https://example.com/old',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await app.inject({ method: 'GET', url: `/api/links/${code}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(code);
  });

  it('returns 404 not_found for an unknown code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/links/${uniqueCode('nope')}`,
    });
    expectError(res, 404, 'not_found');
  });

  it.each(['a.b', 'a'.repeat(33)])(
    'returns 404 not_found for invalid code %s',
    async (code) => {
      expectError(
        await app.inject({ method: 'GET', url: `/api/links/${code}` }),
        404,
        'not_found',
      );
    },
  );
});

describe('unknown routes', () => {
  it.each([
    ['GET', '/api/nothing/here'],
    ['GET', '/a/b/c'],
    ['POST', '/nope'],
  ] as const)('%s %s returns 404 not_found', async (method, url) => {
    expectError(await app.inject({ method, url }), 404, 'not_found');
  });
});
