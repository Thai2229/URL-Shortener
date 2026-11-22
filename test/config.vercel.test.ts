import { describe, expect, it } from 'vitest';
import { loadConfig, migrateDatabaseUrl } from '../src/config.js';

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
    [{ VERCEL: '1' }, true],
    [{ VERCEL: '1', TRUST_PROXY: '' }, true],
    [{ VERCEL: '1', TRUST_PROXY: 'false' }, false],
    [{ VERCEL: '1', TRUST_PROXY: '2' }, 2],
    [{ VERCEL: '1', TRUST_PROXY: '10.0.0.1' }, ['10.0.0.1']],
    [{ VERCEL: '1', TRUST_PROXY: 'true' }, true],
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
