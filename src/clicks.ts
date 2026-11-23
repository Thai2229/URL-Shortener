import { randomBytes } from 'node:crypto';
import { debuglog } from 'node:util';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { isReady } from './cache.js';
import { addClicks } from './db/links.js';
import type { Metrics } from './metrics.js';

const debug = debuglog('clicks');

// Delete the lock only if we still own it.
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

export interface ClickCounter {
  record(code: string): Promise<void>;
  flush(): Promise<{ codes: number; clicks: number } | null>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export function createClickCounter({
  redis,
  db,
  prefix = 'clicks',
  lockSeconds = 30,
  metrics,
}: {
  redis?: Redis | undefined;
  db: pg.Pool;
  prefix?: string;
  lockSeconds?: number;
  metrics?: Metrics;
}): ClickCounter & {
  flushIfDue(
    minIntervalMs: number,
  ): Promise<{ codes: number; clicks: number } | null>;
} {
  const processing = `${prefix}:processing`;
  const lock = `${prefix}:lock`;
  const due = `${prefix}:due`;
  let nextDueAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;

  async function record(code: string) {
    if (!isReady(redis)) {
      return;
    }
    try {
      await redis.hincrby(prefix, code, 1);
      metrics?.clickRecorded();
    } catch (err) {
      debug('record %s failed: %O', code, err);
    }
  }

  async function flushOnce(state: { error: boolean }) {
    if (!isReady(redis)) {
      return null;
    }
    const token = randomBytes(16).toString('hex');
    try {
      if ((await redis.set(lock, token, 'EX', lockSeconds, 'NX')) !== 'OK') {
        return null;
      }
    } catch (err) {
      debug('lock failed: %O', err);
      state.error = true;
      return null;
    }
    try {
      let total = { codes: 0, clicks: 0 };
      // Pass 1 applies a leftover in-flight hash (failed earlier flush) and
      // pass 2 the pending one; without a leftover, one pass is enough.
      for (let pass = 0; pass < 2; pass++) {
        const leftover = (await redis.exists(processing)) === 1;
        if (!leftover) {
          try {
            await redis.rename(prefix, processing);
          } catch (err) {
            if (/no such key/i.test(String((err as Error).message))) {
              return total;
            }
            throw err;
          }
        }
        const raw = await redis.hgetall(processing);
        const counts: Record<string, number> = {};
        let clicks = 0;
        for (const [code, n] of Object.entries(raw)) {
          counts[code] = Number(n);
          clicks += counts[code];
        }
        await addClicks(db, counts);
        // At-least-once: a crash between the write above and this DEL counts
        // the batch twice; a failure before the write loses nothing.
        await redis.del(processing);
        total = {
          codes: total.codes + Object.keys(counts).length,
          clicks: total.clicks + clicks,
        };
        if (!leftover) {
          break;
        }
      }
      return total;
    } catch (err) {
      debug('flush failed: %O', err);
      state.error = true;
      return null;
    } finally {
      try {
        await redis.eval(RELEASE, 1, lock, token);
      } catch (err) {
        debug('unlock failed: %O', err);
      }
    }
  }

  async function flush() {
    const started = performance.now();
    const state = { error: false };
    const result = await flushOnce(state);
    let outcome: 'ok' | 'skipped' | 'error' = 'skipped';
    if (result) {
      outcome = 'ok';
    }
    if (state.error) {
      outcome = 'error';
    }
    metrics?.clickFlush(outcome, (performance.now() - started) / 1000);
    return result;
  }

  // Request-driven flush: one instance-local check, then one cluster-wide marker.
  async function flushIfDue(minIntervalMs: number) {
    if (!isReady(redis) || Date.now() < nextDueAt) {
      return null;
    }
    nextDueAt = Date.now() + minIntervalMs;
    try {
      if ((await redis.set(due, '1', 'PX', minIntervalMs, 'NX')) !== 'OK') {
        return null;
      }
      return await flush();
    } catch (err) {
      debug('flushIfDue failed: %O', err);
      return null;
    }
  }

  function start(intervalMs: number) {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      if (!running) {
        running = flush().finally(() => {
          running = undefined;
        });
      }
    }, intervalMs);
    timer.unref();
  }

  async function stop() {
    clearInterval(timer);
    timer = undefined;
    await running;
    await flush();
  }

  return { record, flush, flushIfDue, start, stop };
}
