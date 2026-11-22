import { isIP } from 'node:net';
import fastifyRateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { isReady } from './cache.js';

type Result = { current: number; ttl: number };
type Callback = (err: Error | null, result: Result) => void;

// INCR and set the expiry atomically; also repairs a key that somehow has no TTL.
const INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {current, redis.call('PTTL', KEYS[1])}
`;

const MAX_LOCAL_ENTRIES = 10000;

type Incr = Redis & {
  rateLimitIncr(key: string, windowMs: number): Promise<[number, number]>;
};

// Called directly on the app (not as an encapsulated plugin) so the limits reach every route.
export function registerRateLimit(
  app: FastifyInstance,
  { redis, windowSeconds }: { redis?: Redis; windowSeconds: number },
) {
  // shortcut: per-instance fallback counters, capped at MAX_LOCAL_ENTRIES (oldest evicted first).
  const local = new Map<string, { current: number; resetAt: number }>();

  function sweep() {
    const now = Date.now();
    for (const [k, v] of local) {
      if (v.resetAt <= now) {
        local.delete(k);
      }
    }
  }
  const timer = setInterval(sweep, 1000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  if (redis) {
    redis.defineCommand('rateLimitIncr', {
      numberOfKeys: 1,
      lua: INCR_SCRIPT,
    });
  }

  function incrLocal(key: string, timeWindow: number): Result {
    const now = Date.now();
    let entry = local.get(key);
    if (!entry || entry.resetAt <= now) {
      local.delete(key);
      if (local.size >= MAX_LOCAL_ENTRIES) {
        local.delete(local.keys().next().value as string);
      }
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
      (redis as Incr).rateLimitIncr(`rl:${key}`, timeWindow).then(
        ([current, ttl]) => {
          cb(null, { current, ttl: Math.max(ttl, 1) });
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
    // Route pattern in the key gives each route its own bucket; unmatched routes share one.
    keyGenerator: (request) => {
      let route = request.routeOptions.url;
      if (request.is404) {
        route = '404';
      }
      // An invalid request.ip (garbage X-Forwarded-For) must never reach the key.
      let ip = request.ip;
      if (isIP(ip) === 0) {
        ip = request.socket.remoteAddress ?? 'unknown';
      }
      return `${route}:${normalizeIP(ip, 64)}`;
    },
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error('Too many requests'), {
        statusCode: context.statusCode,
      }),
  });
}
