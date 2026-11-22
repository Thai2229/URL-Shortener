# URL Shortener

A URL shortener built to scale horizontally: Fastify API, PostgreSQL as the source of truth, Redis for caching. So far it has the core API (create, redirect, metadata) `/healthz`, `/readyz` and Redis caching; rate limiting and click counting come later. See [docs/PLAN.md](docs/PLAN.md) for the architecture and build steps.

## Quickstart

With Docker (API, Postgres and Redis):

```sh
cp .env.example .env
docker compose up --build
curl localhost:3000/healthz
```

Without Docker for the API (needs Node 22):

```sh
npm install
npm run dev
```

## API

Create a link. `expiresAt` is optional and must be a future ISO date. Only `http` and `https` URLs up to 2048 characters are accepted, without credentials and not pointing at `BASE_URL`'s own host. Returns `201` with `code`, `shortUrl`, `url` and `expiresAt`.

```sh
curl -X POST localhost:3000/api/links \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/page","expiresAt":"2030-01-01T00:00:00Z"}'
```

Follow a short link. Returns `302` to the target, `404` for an unknown code and `410` once the link has expired.

```sh
curl -i localhost:3000/aB3dE9x
```

Read link metadata (`code`, `shortUrl`, `url`, `createdAt`, `expiresAt`, `clickCount`). It still works for expired links.

```sh
curl localhost:3000/api/links/aB3dE9x
```

Errors have the form `{ "error": { "code", "message" } }`, with codes `invalid_url`, `invalid_expiry`, `not_found`, `expired` and `internal_error`.

## Caching

Redirects are cache-aside in Redis under the key `link:{code}`. The value is a small JSON blob with the target URL and expiry. A link is cached for 24 hours (plus or minus 10% jitter), never past its `expiresAt`, and expired links are not cached. Creating a link writes it to the cache. Unknown codes get a negative marker for 60 seconds, so repeated lookups don't reach Postgres; creating a link with that code replaces the marker. Metadata (`GET /api/links/:code`) always reads Postgres.

If `REDIS_URL` is unset or Redis is down, cache errors are swallowed and redirects fall back to Postgres. Redis calls time out after about 200 ms.

`GET /readyz` returns `200` with `{ status, checks: { postgres, redis } }`. Postgres must be `ok`, otherwise it returns `503`. Redis is `ok`, `down` (still `200`) or `disabled`. `GET /healthz` stays a plain liveness check.

## Rate limiting

Limits are per client IP, in fixed windows of `RATE_LIMIT_WINDOW_SECONDS` (default 60). Each route has its own bucket:

| Route                  | Variable                  | Default |
| ---------------------- | ------------------------- | ------- |
| `POST /api/links`      | `RATE_LIMIT_CREATE_MAX`   | 20      |
| `GET /:code`           | `RATE_LIMIT_REDIRECT_MAX` | 600     |
| `GET /api/links/:code` | `RATE_LIMIT_READ_MAX`     | 120     |

`/healthz` and `/readyz` are never limited. Set `RATE_LIMIT_ENABLED=false` to turn limiting off. Over the limit, the API returns `429` with `{ "error": { "code": "rate_limited", ... } }` and a `Retry-After` header; successful responses carry `X-RateLimit-*` headers.

Counters live in Redis under `rl:{route}:{ip}`, so all replicas share them. If Redis is unset or down, each instance counts in memory instead. Limits then apply per instance, and the counters start from zero when Redis comes back.

Warning: behind a proxy or load balancer, set `TRUST_PROXY` (`true`, a hop count such as `1`, or a comma-separated list of proxy IPs/CIDRs) so the real client IP is used; otherwise every client shares the proxy's IP. Leave it unset when clients connect directly. Trusting `X-Forwarded-For` from a source you don't control lets clients pick their own IP and dodge the limits.

## Scripts

- `npm run dev`: start with file watching (tsx)
- `npm run build`: compile to `dist/`
- `npm start`: run the compiled server
- `npm test`: run Vitest. It needs a `urlshortener_test` database (`TEST_DATABASE_URL`); create it once with `docker compose exec postgres createdb -U urlshortener urlshortener_test`.
- `npm run lint`: ESLint
- `npm run typecheck`: `tsc --noEmit`
- `npm run format`: Prettier

## Configuration

Environment variables are listed in `.env.example`. `PORT`, `HOST`, `LOG_LEVEL` and `BASE_URL` have defaults. `DATABASE_URL` is required to start the server; `REDIS_URL` is optional (without it, caching is off). Tests use db 15 of `TEST_REDIS_URL` (default `redis://localhost:6379/15`). Invalid values stop the server at startup.
