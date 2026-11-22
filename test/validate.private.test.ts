import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { validateUrl } from '../src/validate.js';
import { testConfig } from './helpers/config.js';
import { usePool } from './helpers/db.js';

const BASE = 'https://short.example';

// Third argument of validateUrl: allowPrivateTargets (default false).
const blocked = [
  // IPv4 loopback and spellings the WHATWG parser normalizes
  'http://127.0.0.1:3300/',
  'http://127.255.255.254/',
  'http://0x7f.1:3300/',
  'http://2130706433/',
  'http://017700000001/',
  'http://127.1/',
  // 0.0.0.0/8
  'http://0.0.0.0/',
  'http://0.1.2.3/',
  // private ranges
  'http://10.0.0.1/',
  'http://10.255.255.255/',
  'http://172.16.0.1/',
  'http://172.31.255.255/',
  'http://192.168.0.1/',
  'http://192.168.255.255/',
  // link-local and metadata
  'http://169.254.0.1/',
  'http://169.254.169.254/latest/meta-data/',
  // CGNAT
  'http://100.64.0.1/',
  'http://100.127.255.255/',
  // IPv6
  'http://[::]/',
  'http://[::1]:3300/',
  'http://[fc00::1]/',
  'http://[fd12:3456:789a::1]/',
  'http://[fe80::1]/',
  'http://[febf::1]/',
  // mapped / embedded IPv4
  'http://[::ffff:7f00:1]:3300/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:a00:1]/',
  'http://[::ffff:c0a8:101]/',
  'http://[::ffff:a9fe:a9fe]/',
  'http://[::ffff:6440:1]/',
  'http://[::7f00:1]/',
  // names
  'http://localhost/',
  'http://localhost:8080/x',
  'http://LOCALHOST/',
  'http://localhost./',
  'http://foo.localhost/',
  'http://a.b.localhost./',
  'https://user.localhost:9/x',
];

const allowed = [
  'https://example.com',
  'http://93.184.216.34/',
  'http://[2606:4700:4700::1111]/',
  'http://8.8.8.8:8080/x',
  'http://126.255.255.255/',
  'http://128.0.0.1/',
  'http://11.0.0.1/',
  'http://172.15.255.255/',
  'http://172.32.0.1/',
  'http://192.167.255.255/',
  'http://192.169.0.1/',
  'http://169.253.255.255/',
  'http://169.255.0.1/',
  'http://100.63.255.255/',
  'http://100.128.0.1/',
  'http://[fbff::1]/',
  'http://[fec0::1]/',
  'http://[::ffff:808:808]/',
  'https://127.0.0.1.example.com/',
  'https://localhost.example.com/',
  'https://notlocalhost.com/',
  'https://10.0.0.1.nip.example/',
];

describe('validateUrl private targets', () => {
  it.each(blocked)('rejects %s', (url) => {
    expect(validateUrl(url, BASE)).toBeNull();
  });

  it.each(allowed)('accepts %s', (url) => {
    expect(validateUrl(url, BASE)).not.toBeNull();
  });

  it.each(blocked)('accepts %s when private targets are allowed', (url) => {
    expect(validateUrl(url, BASE, true)).not.toBeNull();
  });

  it.each(blocked)('rejects %s with the flag explicitly false', (url) => {
    expect(validateUrl(url, BASE, false)).toBeNull();
  });

  it('keeps the own-host check when private targets are allowed', () => {
    expect(
      validateUrl('http://localhost:3000/x', 'http://localhost:3000', true),
    ).toBeNull();
    expect(
      validateUrl('http://localhost:3001/x', 'http://localhost:3000', true),
    ).not.toBeNull();
  });
});

describe('POST /api/links private targets', () => {
  const pool = usePool();
  const app = buildApp(testConfig({ BASE_URL: BASE }), { db: pool });
  const open = buildApp(
    testConfig({ BASE_URL: BASE, ALLOW_PRIVATE_TARGETS: 'true' }),
    { db: pool },
  );
  afterAll(async () => {
    await app.close();
    await open.close();
  });
  const post = (a: typeof app, url: string) =>
    a.inject({ method: 'POST', url: '/api/links', payload: { url } });

  it.each([
    'http://127.0.0.1:3300/',
    'http://[::1]:3300/',
    'http://[::ffff:7f00:1]:3300/',
    'http://0x7f.1:3300/',
    'http://169.254.169.254/',
    'http://localhost:3300/',
  ])('answers 400 invalid_url for %s', async (url) => {
    const res = await post(app, url);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_url');
  });

  it('answers 201 for a public address', async () => {
    expect((await post(app, 'http://8.8.8.8:8080/x')).statusCode).toBe(201);
  });

  it.each(['http://127.0.0.1:3300/', 'http://[::1]:3300/', 'http://10.0.0.1/'])(
    'answers 201 for %s with ALLOW_PRIVATE_TARGETS',
    async (url) => {
      const res = await post(open, url);
      expect(res.statusCode).toBe(201);
      expect(res.json().url).toBe(new URL(url).href);
    },
  );

  it('still rejects the own host with ALLOW_PRIVATE_TARGETS', async () => {
    const res = await post(open, `${BASE}/x`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_url');
  });
});
