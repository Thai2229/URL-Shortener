import { afterAll, beforeAll } from 'vitest';
import { Redis } from 'ioredis';

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL || 'redis://localhost:6379/15';
}

// Resolves once the client is connected and ready (no command is issued).
export function waitReady(redis: Redis, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redis.status === 'ready') {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error(`redis not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    function onReady() {
      clearTimeout(timer);
      resolve();
    }
    redis.once('ready', onReady);
  });
}

// Resolves once a client pointed at a dead server has failed its first connect.
export async function waitFailed(redis: Redis, timeoutMs = 2000) {
  const start = Date.now();
  while (redis.status === 'connecting' || redis.status === 'wait') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`redis still ${redis.status} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function offlineQueueLength(redis: Redis): number {
  return (redis as unknown as { offlineQueue: { length: number } }).offlineQueue
    .length;
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
  beforeAll(async () => {
    await waitReady(redis);
  });
  afterAll(async () => {
    if (tracked.size > 0) {
      await redis.del(...tracked);
      tracked.clear();
    }
    await redis.quit();
  });
  return redis;
}
