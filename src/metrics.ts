import type { Redis } from 'ioredis';
import type pg from 'pg';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { isReady } from './cache.js';

export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics({ db, redis }: { db: pg.Pool; redis?: Redis }) {
  // Per-app registry: several apps (tests) can live in one process.
  const register = new Registry();
  collectDefaultMetrics({ register });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  });
  const cache = new Counter({
    name: 'redirect_cache_total',
    help: 'Redirect lookups by cache result',
    labelNames: ['result'],
    registers: [register],
  });
  const rateLimit = new Counter({
    name: 'rate_limit_rejected_total',
    help: 'Requests rejected with 429, by route pattern',
    labelNames: ['route'],
    registers: [register],
  });
  const clicks = new Counter({
    name: 'clicks_recorded_total',
    help: 'Clicks recorded in Redis',
    registers: [register],
  });
  const flushes = new Counter({
    name: 'click_flush_total',
    help: 'Click flushes by result',
    labelNames: ['result'],
    registers: [register],
  });
  const flushDuration = new Histogram({
    name: 'click_flush_duration_seconds',
    help: 'Click flush duration in seconds',
    registers: [register],
  });
  new Gauge({
    name: 'pg_pool_connections',
    help: 'Postgres pool connections by state',
    labelNames: ['state'],
    registers: [register],
    collect() {
      this.set({ state: 'total' }, db.totalCount);
      this.set({ state: 'idle' }, db.idleCount);
      this.set({ state: 'waiting' }, db.waitingCount);
    },
  });
  new Gauge({
    name: 'redis_ready',
    help: '1 when the Redis client is ready, else 0',
    registers: [register],
    collect() {
      let ready = 0;
      if (isReady(redis)) {
        ready = 1;
      }
      this.set(ready);
    },
  });

  return {
    register,
    observeRequest(
      method: string,
      route: string,
      statusCode: number,
      seconds: number,
    ) {
      httpDuration.observe(
        { method, route, status_code: String(statusCode) },
        seconds,
      );
    },
    cacheResult(result: 'hit' | 'miss' | 'negative') {
      cache.inc({ result });
    },
    rateLimited(route: string) {
      rateLimit.inc({ route });
    },
    clickRecorded() {
      clicks.inc();
    },
    clickFlush(result: 'ok' | 'skipped' | 'error', seconds: number) {
      flushes.inc({ result });
      flushDuration.observe(seconds);
    },
  };
}
