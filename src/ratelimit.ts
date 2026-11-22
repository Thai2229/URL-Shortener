import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { isReady } from './cache.js';

type Result = { current: number; ttl: number };
type Callback = (err: Error | null, result: Result) => void;

// INCR and set the expiry atomically on the first hit, so a key can never be left without a TTL.
const INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {current, redis.call('PTTL', KEYS[1])}
`;

// Called directly on the app (not as an encapsulated plugin) so the limits reach every route.
export function registerRateLimit(
  app: FastifyInstance,
  { redis, windowSeconds }: { redis?: Redis; windowSeconds: number },
) {
  // shortcut: per-instance fallback counters; swept when large, fine for an outage window.
  const local = new Map<string, { current: number; resetAt: number }>();

  function incrLocal(key: string, timeWindow: number): Result {
    const now = Date.now();
    if (local.size > 10000) {
      for (const [k, v] of local) {
        if (v.resetAt <= now) {
          local.delete(k);
        }
      }
    }
    let entry = local.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { current: 0, resetAt: now + timeWindow };
      local.set(key, entry);
    }
    entry.current++;
    return { current: entry.current, ttl: entry.resetAt - now };
  }

  class Store {
    incr(key: string, cb: Callback, timeWindow: number) {
      // Skip Redis while it is not ready so nothing piles up in the offline queue.
      if (!isReady(redis)) {
        return cb(null, incrLocal(key, timeWindow));
      }
      redis.eval(INCR_SCRIPT, 1, `rl:${key}`, timeWindow).then(
        (res) => {
          const [current, ttl] = res as [number, number];
          cb(null, { current, ttl });
        },
        () => cb(null, incrLocal(key, timeWindow)),
      );
    }
    child() {
      return this;
    }
  }

  app.register(fastifyRateLimit, {
    global: false,
    timeWindow: windowSeconds * 1000,
    nameSpace: 'rl:',
    store: Store,
    // Route pattern in the key gives each route its own bucket.
    keyGenerator: (request) => `${request.routeOptions.url}:${request.ip}`,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error('Too many requests'), {
        statusCode: context.statusCode,
      }),
  });
}
