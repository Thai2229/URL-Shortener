import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { CachedLink } from '../cache.js';
import { cacheLink, cacheMissing, getCachedLink } from '../cache.js';
import { generateCode } from '../code.js';
import type { Config } from '../config.js';
import { findLinkByCode, insertLink } from '../db/links.js';
import type { Link } from '../db/links.js';
import { validateExpiry, validateUrl } from '../validate.js';

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_ATTEMPTS = 5;

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}

export const linksRoutes: FastifyPluginAsync<{
  config: Config;
  db: pg.Pool;
  redis?: Redis;
}> = async (app, { config, db, redis }) => {
  const shortBase = config.baseUrl.replace(/\/+$/, '');
  const shortUrl = (code: string) => `${shortBase}/${code}`;

  app.post(
    '/api/links',
    { config: { rateLimit: { max: config.rateLimit.createMax } } },
    async (request, reply) => {
      const body = request.body as {
        url?: unknown;
        expiresAt?: unknown;
      } | null;
      const targetUrl =
        typeof body?.url === 'string' && validateUrl(body.url, config.baseUrl);
      if (!targetUrl) {
        return fail(
          reply,
          400,
          'invalid_url',
          'url must be an http(s) URL of at most 2048 characters, without credentials, and not point at this service',
        );
      }
      let expiresAt: Date | null = null;
      if (body?.expiresAt !== undefined && body.expiresAt !== null) {
        expiresAt = validateExpiry(body.expiresAt);
        if (!expiresAt) {
          return fail(
            reply,
            400,
            'invalid_expiry',
            'expiresAt must be an ISO 8601 date (YYYY-MM-DD) or datetime with Z or ±HH:MM offset (YYYY-MM-DDTHH:mm[:ss[.fff]]), in the future and within 10 years',
          );
        }
      }
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const link = await insertLink(db, {
          code: generateCode(),
          targetUrl,
          expiresAt,
        });
        if (link) {
          await cacheLink(redis, link);
          return reply.code(201).send({
            code: link.code,
            shortUrl: shortUrl(link.code),
            url: link.targetUrl,
            expiresAt: link.expiresAt?.toISOString() ?? null,
          });
        }
      }
      throw new Error('could not generate a unique code');
    },
  );

  async function lookup(code: string, reply: FastifyReply) {
    let link: Link | null = null;
    if (CODE_PATTERN.test(code)) {
      link = await findLinkByCode(db, code);
    }
    if (!link) {
      fail(reply, 404, 'not_found', 'Link not found');
    }
    return link;
  }

  app.get<{ Params: { code: string } }>(
    '/api/links/:code',
    { config: { rateLimit: { max: config.rateLimit.readMax } } },
    async (request, reply) => {
      const link = await lookup(request.params.code, reply);
      if (!link) {
        return reply;
      }
      return {
        code: link.code,
        shortUrl: shortUrl(link.code),
        url: link.targetUrl,
        createdAt: link.createdAt.toISOString(),
        expiresAt: link.expiresAt?.toISOString() ?? null,
        clickCount: link.clickCount,
      };
    },
  );

  app.get<{ Params: { code: string } }>(
    '/:code',
    { config: { rateLimit: { max: config.rateLimit.redirectMax } } },
    async (request, reply) => {
      const { code } = request.params;
      let url: string;
      let expiresAt: Date | null;
      const valid = CODE_PATTERN.test(code);
      let cached: CachedLink = { kind: 'miss' };
      if (valid) {
        cached = await getCachedLink(redis, code);
      }
      if (cached.kind === 'negative') {
        return fail(reply, 404, 'not_found', 'Link not found');
      }
      if (cached.kind === 'hit') {
        url = cached.url;
        expiresAt = cached.expiresAt;
      } else {
        const link = await lookup(code, reply);
        if (!link) {
          if (valid) {
            await cacheMissing(redis, code);
          }
          return reply;
        }
        url = link.targetUrl;
        expiresAt = link.expiresAt;
        if (!expiresAt || expiresAt.getTime() > Date.now()) {
          await cacheLink(redis, link);
        }
      }
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        return fail(reply, 410, 'expired', 'Link has expired');
      }
      return reply.header('Cache-Control', 'no-store').redirect(url, 302);
    },
  );
};
