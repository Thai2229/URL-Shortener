import { describe, expect, it } from 'vitest';
import {
  isPooledDatabaseUrl,
  loadConfig,
  migrateDatabaseUrl,
  resolveMigrationUrl,
} from '../src/config.js';

describe('redisUrl fallback', () => {
  it.each([
    [{ REDIS_URL: 'redis://a', KV_URL: 'rediss://b' }, 'redis://a'],
    [{ KV_URL: 'rediss://b' }, 'rediss://b'],
    [{ REDIS_URL: '', KV_URL: 'rediss://b' }, 'rediss://b'],
    [{ REDIS_URL: 'redis://a' }, 'redis://a'],
    [{}, undefined],
    [{ REDIS_URL: '', KV_URL: '' }, undefined],
  ])('%j -> %j', (env, expected) => {
    expect(loadConfig(env).redisUrl).toBe(expected);
  });
});

describe('baseUrl fallback', () => {
  it.each([
    [
      {
        BASE_URL: 'https://x.test',
        VERCEL_PROJECT_PRODUCTION_URL: 'p.vercel.app',
      },
      'https://x.test',
    ],
    [{ VERCEL_PROJECT_PRODUCTION_URL: 'p.vercel.app' }, 'https://p.vercel.app'],
    [
      { BASE_URL: '', VERCEL_PROJECT_PRODUCTION_URL: 'p.vercel.app' },
      'https://p.vercel.app',
    ],
    [
      { VERCEL_PROJECT_PRODUCTION_URL: 'https://p.example.com' },
      'https://p.example.com',
    ],
    [
      { VERCEL_PROJECT_PRODUCTION_URL: 'http://p.example.com' },
      'http://p.example.com',
    ],
    [{ VERCEL_PROJECT_PRODUCTION_URL: '' }, 'http://localhost:3000'],
    [{}, 'http://localhost:3000'],
  ])('%j -> %s', (env, expected) => {
    expect(loadConfig(env).baseUrl).toBe(expected);
  });
});

describe('trustProxy on Vercel', () => {
  it.each([
    [{ VERCEL: '1', VERCEL_ENV: 'production' }, true],
    [{ VERCEL: '1', VERCEL_ENV: 'preview' }, true],
    [{ VERCEL: '1', VERCEL_ENV: 'production', TRUST_PROXY: '' }, true],
    [{ VERCEL: '1' }, false],
    [{ VERCEL: '1', VERCEL_ENV: '' }, false],
    [{ VERCEL_ENV: 'production' }, false],
    [{ VERCEL: '1', VERCEL_ENV: 'production', TRUST_PROXY: 'false' }, false],
    [{ VERCEL: '1', VERCEL_ENV: 'production', TRUST_PROXY: '2' }, 2],
    [
      { VERCEL: '1', VERCEL_ENV: 'production', TRUST_PROXY: '10.0.0.1' },
      ['10.0.0.1'],
    ],
    [{ VERCEL: '1', TRUST_PROXY: 'true' }, true],
    [{ VERCEL: '1', TRUST_PROXY: '3' }, 3],
    [{}, false],
    [{ TRUST_PROXY: '' }, false],
    [{ VERCEL: '' }, false],
    [{ VERCEL: '0' }, false],
  ])('%j -> %j', (env, expected) => {
    expect(loadConfig(env).trustProxy).toEqual(expected);
  });
});

describe('cronSecret', () => {
  it('reads CRON_SECRET', () => {
    expect(loadConfig({ CRON_SECRET: 'c'.repeat(16) }).cronSecret).toBe(
      'c'.repeat(16),
    );
    expect(
      loadConfig({ CRON_SECRET: 'long-enough-cron-secret-1' }).cronSecret,
    ).toBe('long-enough-cron-secret-1');
  });

  it('is undefined when empty or missing', () => {
    expect(loadConfig({ CRON_SECRET: '' }).cronSecret).toBeUndefined();
    expect(loadConfig({}).cronSecret).toBeUndefined();
  });

  it('throws naming CRON_SECRET when shorter than 16 characters', () => {
    expect(() => loadConfig({ CRON_SECRET: 'a'.repeat(15) })).toThrow(
      /CRON_SECRET/,
    );
    expect(() => loadConfig({ CRON_SECRET: 'x' })).toThrow(/CRON_SECRET/);
  });
});

describe('migrateDatabaseUrl', () => {
  it.each([
    [
      {
        MIGRATE_DATABASE_URL: 'postgres://m',
        DATABASE_URL_UNPOOLED: 'postgres://u',
        DATABASE_URL: 'postgres://d',
      },
      'postgres://m',
    ],
    [
      { DATABASE_URL_UNPOOLED: 'postgres://u', DATABASE_URL: 'postgres://d' },
      'postgres://u',
    ],
    [
      {
        MIGRATE_DATABASE_URL: '',
        DATABASE_URL_UNPOOLED: '',
        DATABASE_URL: 'postgres://d',
      },
      'postgres://d',
    ],
    [{ DATABASE_URL: 'postgres://d' }, 'postgres://d'],
    [{ MIGRATE_DATABASE_URL: 'postgres://m' }, 'postgres://m'],
    [
      { MIGRATE_DATABASE_URL: '', DATABASE_URL_UNPOOLED: '', DATABASE_URL: '' },
      undefined,
    ],
    [{}, undefined],
  ])('%j -> %s', (env, expected) => {
    expect(migrateDatabaseUrl(env)).toBe(expected);
  });
});

describe('baseUrl precedence on Vercel', () => {
  const P = 'prod.example.com';
  const V = 'proj-abc123.vercel.app';
  it.each([
    [
      {
        BASE_URL: 'https://x.test',
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: P,
        VERCEL_URL: V,
      },
      'https://x.test',
    ],
    [
      { BASE_URL: 'https://x.test', VERCEL_ENV: 'preview', VERCEL_URL: V },
      'https://x.test',
    ],
    [
      {
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: P,
        VERCEL_URL: V,
      },
      `https://${P}`,
    ],
    [
      {
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: `http://${P}`,
        VERCEL_URL: V,
      },
      `http://${P}`,
    ],
    [
      {
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: P,
        VERCEL_URL: V,
      },
      `https://${V}`,
    ],
    [
      {
        VERCEL_ENV: 'development',
        VERCEL_PROJECT_PRODUCTION_URL: P,
        VERCEL_URL: V,
      },
      `https://${V}`,
    ],
    [{ VERCEL_ENV: 'preview', VERCEL_URL: `https://${V}` }, `https://${V}`],
    [
      { VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: P },
      `https://${P}`,
    ],
    [
      {
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: P,
        VERCEL_URL: '',
      },
      `https://${P}`,
    ],
    [{ VERCEL_ENV: 'preview' }, 'http://localhost:3000'],
    [{ VERCEL_URL: V, VERCEL_PROJECT_PRODUCTION_URL: P }, `https://${V}`],
    [{ VERCEL_ENV: 'production', VERCEL_URL: V }, `https://${V}`],
  ])('%j -> %s', (env, expected) => {
    expect(loadConfig(env).baseUrl).toBe(expected);
  });
});

describe('config.vercel', () => {
  it.each([
    [{ VERCEL: '1' }, true],
    [{ VERCEL: '0' }, false],
    [{ VERCEL: '' }, false],
    [{ VERCEL: 'true' }, false],
    [{}, false],
  ])('%j -> %j', (env, expected) => {
    expect(loadConfig(env).vercel).toBe(expected);
  });
});

describe('metricsEnabled default on Vercel', () => {
  const token = 'metrics-token-0123456789';
  it.each([
    [{}, true],
    [{ METRICS_TOKEN: token }, true],
    [{ VERCEL: '1' }, false],
    [{ VERCEL: '1', METRICS_TOKEN: '' }, false],
    [{ VERCEL: '1', METRICS_TOKEN: token }, true],
    [{ VERCEL: '1', METRICS_ENABLED: 'true' }, true],
    [{ VERCEL: '1', METRICS_ENABLED: '1' }, true],
    [{ VERCEL: '1', METRICS_ENABLED: 'false', METRICS_TOKEN: token }, false],
    [{ METRICS_ENABLED: 'false' }, false],
    [{ VERCEL: '0' }, true],
  ])('%j -> %j', (env, expected) => {
    expect(loadConfig(env).metricsEnabled).toBe(expected);
  });
});

describe('isPooledDatabaseUrl', () => {
  it.each([
    ['postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db', true],
    [
      'postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech:5432/db?sslmode=require',
      true,
    ],
    ['postgresql://ep-a-pooler.neon.tech/db', true],
    ['postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/db', false],
    ['postgres://u:p@localhost:5432/db', false],
    ['postgres://u:p@127.0.0.1/db?host=pooler', false],
    [
      'postgres://u:pooler@ep-cool-123.us-east-2.aws.neon.tech/db-pooler',
      false,
    ],
    ['not a url', false],
    ['', false],
  ])('%s -> %j', (url, expected) => {
    expect(isPooledDatabaseUrl(url)).toBe(expected);
  });
});

describe('resolveMigrationUrl', () => {
  const pooled = 'postgres://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/db';
  const direct = 'postgres://u:p@ep-cool-123.us-east-2.aws.neon.tech/db';
  it.each([
    [{ DATABASE_URL: direct }, { url: direct }],
    [{ DATABASE_URL: pooled, DATABASE_URL_UNPOOLED: direct }, { url: direct }],
    [{ DATABASE_URL: pooled, MIGRATE_DATABASE_URL: pooled }, { url: pooled }],
    [{ DATABASE_URL: pooled, MIGRATE_DATABASE_URL: direct }, { url: direct }],
    [
      { DATABASE_URL: 'postgres://u:p@localhost/db' },
      { url: 'postgres://u:p@localhost/db' },
    ],
  ])('%j -> %j', (env, expected) => {
    expect(resolveMigrationUrl(env)).toEqual(expected);
  });

  it.each([
    [{ DATABASE_URL: pooled }],
    [{ DATABASE_URL: direct, DATABASE_URL_UNPOOLED: pooled }],
    [{ DATABASE_URL: pooled, MIGRATE_DATABASE_URL: '' }],
  ])('errors for pooled %j without an explicit MIGRATE_DATABASE_URL', (env) => {
    const r = resolveMigrationUrl(env);
    expect(r).toHaveProperty('error');
    const { error } = r as { error: string };
    expect(error).toMatch(/MIGRATE_DATABASE_URL/);
    expect(error).toMatch(/DATABASE_URL_UNPOOLED/);
    expect(error).not.toContain('ep-cool-123');
  });

  it.each([[{}], [{ DATABASE_URL: '', MIGRATE_DATABASE_URL: '' }]])(
    'errors when nothing is set: %j',
    (env) => {
      expect(resolveMigrationUrl(env)).toHaveProperty('error');
    },
  );
});
