import { Redis } from 'ioredis';

// Fail fast: commandTimeout bounds queued commands too, so a dead Redis rejects within ~200ms.
export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    commandTimeout: 200,
    connectTimeout: 1000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => {
    console.error(`redis error: ${err.message}`);
  });
  return redis;
}
