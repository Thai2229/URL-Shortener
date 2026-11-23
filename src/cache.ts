import { debuglog } from 'node:util';
import type { Redis } from 'ioredis';

const debug = debuglog('cache');

export const NEGATIVE_TTL_SECONDS = 60;
export const LINK_TTL_SECONDS = 86400;

const NEGATIVE = '{"n":1}';

export type CachedLink =
  | { kind: 'hit'; url: string; expiresAt: Date | null }
  | { kind: 'negative' }
  | { kind: 'miss' };

export function cacheKey(code: string) {
  return `link:${code}`;
}

// Skip Redis while disconnected so nothing piles up in the offline queue.
export function isReady(redis: Redis | undefined): redis is Redis {
  return redis !== undefined && redis.status === 'ready';
}

export async function getCachedLink(
  redis: Redis | undefined,
  code: string,
): Promise<CachedLink> {
  if (!isReady(redis)) {
    return { kind: 'miss' };
  }
  try {
    const raw = await redis.get(cacheKey(code));
    if (raw === null) {
      return { kind: 'miss' };
    }
    const v = JSON.parse(raw) as { n?: unknown; u?: unknown; e?: unknown };
    if (v?.n === 1) {
      return { kind: 'negative' };
    }
    if (
      typeof v?.u === 'string' &&
      (v.e === null ||
        (typeof v.e === 'number' &&
          Number.isFinite(v.e) &&
          Math.abs(v.e) <= 8.64e15))
    ) {
      let expiresAt: Date | null = null;
      if (v.e !== null) {
        expiresAt = new Date(v.e as number);
      }
      return { kind: 'hit', url: v.u, expiresAt };
    }
  } catch (err) {
    debug('get %s failed: %O', code, err);
  }
  return { kind: 'miss' };
}

export async function cacheLink(
  redis: Redis | undefined,
  link: { code: string; targetUrl: string; expiresAt: Date | null },
): Promise<void> {
  if (!isReady(redis)) {
    return;
  }
  let ttl = Math.round(LINK_TTL_SECONDS * (0.9 + Math.random() * 0.2));
  if (link.expiresAt) {
    const remaining = Math.ceil((link.expiresAt.getTime() - Date.now()) / 1000);
    if (remaining <= 0) {
      return;
    }
    ttl = Math.min(ttl, remaining);
  }
  const value = JSON.stringify({
    u: link.targetUrl,
    e: link.expiresAt?.getTime() ?? null,
  });
  try {
    await redis.set(cacheKey(link.code), value, 'EX', ttl);
  } catch (err) {
    debug('set %s failed: %O', link.code, err);
  }
}

export async function cacheMissing(
  redis: Redis | undefined,
  code: string,
): Promise<void> {
  if (!isReady(redis)) {
    return;
  }
  try {
    // NX: never overwrite a positive entry.
    await redis.set(cacheKey(code), NEGATIVE, 'EX', NEGATIVE_TTL_SECONDS, 'NX');
  } catch (err) {
    debug('set %s failed: %O', code, err);
  }
}
