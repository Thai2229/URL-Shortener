import { Redis } from 'ioredis';
import { intFromEnv } from './config.js';

// Fail fast: commandTimeout bounds queued commands too, so a dead Redis rejects within ~200ms.
export function createRedis(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Redis {
  let connectDefault = 1000;
  // TLS handshakes to hosted Redis (e.g. Upstash) need longer.
  if (url.startsWith('rediss:')) {
    connectDefault = 5000;
  }
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    commandTimeout: intFromEnv(env.REDIS_COMMAND_TIMEOUT_MS, {
      min: 1,
      max: 10000,
      fallback: 200,
    }),
    connectTimeout: intFromEnv(env.REDIS_CONNECT_TIMEOUT_MS, {
      min: 1,
      max: 10000,
      fallback: connectDefault,
    }),
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => {
    console.error(`redis error: ${err.message}`);
  });
  return redis;
}
