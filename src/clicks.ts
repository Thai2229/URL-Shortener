import { randomBytes } from 'node:crypto';
import { debuglog } from 'node:util';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { isReady } from './cache.js';
import { addClicks } from './db/links.js';

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
}: {
  redis: Redis | undefined;
  db: pg.Pool;
  prefix?: string;
  lockSeconds?: number;
}): ClickCounter {
  const processing = `${prefix}:processing`;
  const lock = `${prefix}:lock`;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;

  async function record(code: string) {
    if (!isReady(redis)) {
      return;
    }
    try {
      await redis.hincrby(prefix, code, 1);
    } catch (err) {
      debug('record %s failed: %O', code, err);
    }
  }

  async function flush() {
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
      return null;
    }
    try {
      // A leftover in-flight hash (failed earlier flush) goes first.
      if ((await redis.exists(processing)) === 0) {
        try {
          await redis.rename(prefix, processing);
        } catch (err) {
          if (/no such key/i.test(String((err as Error).message))) {
            return { codes: 0, clicks: 0 };
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
      await redis.del(processing);
      return { codes: Object.keys(counts).length, clicks };
    } catch (err) {
      debug('flush failed: %O', err);
      return null;
    } finally {
      try {
        await redis.eval(RELEASE, 1, lock, token);
      } catch (err) {
        debug('unlock failed: %O', err);
      }
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

  return { record, flush, start, stop };
}
