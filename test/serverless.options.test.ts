import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { createRedis } from '../src/redis.js';

const NAMES = [
  'REDIS_COMMAND_TIMEOUT_MS',
  'REDIS_CONNECT_TIMEOUT_MS',
  'PG_POOL_IDLE_MS',
  'PG_POOL_MAX',
] as const;
const saved: Record<string, string | undefined> = {};
for (const n of NAMES) {
  saved[n] = process.env[n];
}
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) {
      delete process.env[n];
    } else {
      process.env[n] = saved[n];
    }
  }
});

function redisOptions(url: string) {
  const redis = createRedis(url);
  const { commandTimeout, connectTimeout } = redis.options;
  redis.disconnect();
  return { commandTimeout, connectTimeout };
}

describe('createRedis timeouts', () => {
  it('defaults: 200ms command, 1000ms connect (5000 for rediss)', () => {
    delete process.env.REDIS_COMMAND_TIMEOUT_MS;
    delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    expect(redisOptions('redis://127.0.0.1:1')).toEqual({
      commandTimeout: 200,
      connectTimeout: 1000,
    });
    expect(redisOptions('rediss://127.0.0.1:1')).toEqual({
      commandTimeout: 200,
      connectTimeout: 5000,
    });
  });

  it('reads valid overrides', () => {
    process.env.REDIS_COMMAND_TIMEOUT_MS = '750';
    process.env.REDIS_CONNECT_TIMEOUT_MS = '2500';
    expect(redisOptions('redis://127.0.0.1:1')).toEqual({
      commandTimeout: 750,
      connectTimeout: 2500,
    });
    expect(redisOptions('rediss://127.0.0.1:1').connectTimeout).toBe(2500);
  });

  it.each([
    ['1', 1],
    ['10000', 10000],
  ])('accepts boundary %s', (v, n) => {
    process.env.REDIS_COMMAND_TIMEOUT_MS = v;
    process.env.REDIS_CONNECT_TIMEOUT_MS = v;
    expect(redisOptions('redis://127.0.0.1:1')).toEqual({
      commandTimeout: n,
      connectTimeout: n,
    });
  });

  it.each(['0', '-5', '10001', '1.5', 'abc', '', '1e3x', 'NaN'])(
    'falls back to defaults on invalid %j',
    (v) => {
      process.env.REDIS_COMMAND_TIMEOUT_MS = v;
      process.env.REDIS_CONNECT_TIMEOUT_MS = v;
      expect(redisOptions('redis://127.0.0.1:1')).toEqual({
        commandTimeout: 200,
        connectTimeout: 1000,
      });
      expect(redisOptions('rediss://127.0.0.1:1').connectTimeout).toBe(5000);
    },
  );
});

describe('createPool options', () => {
  const url = 'postgres://u:p@127.0.0.1:1/db';

  it('defaults to idle 30000 and max 10', async () => {
    delete process.env.PG_POOL_IDLE_MS;
    delete process.env.PG_POOL_MAX;
    const pool = createPool(url);
    expect(pool.options.idleTimeoutMillis).toBe(30000);
    expect(pool.options.max).toBe(10);
    await pool.end();
  });

  it('reads PG_POOL_MAX and PG_POOL_IDLE_MS', async () => {
    process.env.PG_POOL_MAX = '3';
    process.env.PG_POOL_IDLE_MS = '5000';
    const pool = createPool(url);
    expect(pool.options.max).toBe(3);
    expect(pool.options.idleTimeoutMillis).toBe(5000);
    await pool.end();
  });

  it.each([
    ['1000', 1000],
    ['600000', 600000],
  ])('accepts boundary %s', async (v, n) => {
    process.env.PG_POOL_IDLE_MS = v;
    const pool = createPool(url);
    expect(pool.options.idleTimeoutMillis).toBe(n);
    await pool.end();
  });

  it.each(['999', '600001', '0', '-1', '1.5', 'abc', ''])(
    'falls back to 30000 on invalid PG_POOL_IDLE_MS %j',
    async (v) => {
      process.env.PG_POOL_IDLE_MS = v;
      const pool = createPool(url);
      expect(pool.options.idleTimeoutMillis).toBe(30000);
      await pool.end();
    },
  );
});
