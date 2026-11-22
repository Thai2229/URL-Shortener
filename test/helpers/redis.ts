import { afterAll } from 'vitest';
import { Redis } from 'ioredis';

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL || 'redis://localhost:6379/15';
}

const tracked = new Set<string>();

// Remember a key so it is deleted (only that key) in afterAll.
export function trackKey(key: string): string {
  tracked.add(key);
  return key;
}

// Connected client for the calling test file; deletes tracked keys and closes in afterAll.
export function useRedis(): Redis {
  const redis = new Redis(testRedisUrl());
  afterAll(async () => {
    if (tracked.size > 0) {
      await redis.del(...tracked);
      tracked.clear();
    }
    await redis.quit();
  });
  return redis;
}
