# URL Shortener

A URL shortener built to scale horizontally: Fastify API, PostgreSQL as the source of truth, Redis for caching. So far it has the core API (create, redirect, metadata) and `/healthz`; caching, rate limiting and click counting come later. See [docs/PLAN.md](docs/PLAN.md) for the architecture and build steps.

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

## Scripts

- `npm run dev`: start with file watching (tsx)
- `npm run build`: compile to `dist/`
- `npm start`: run the compiled server
- `npm test`: run Vitest. It needs a `urlshortener_test` database (`TEST_DATABASE_URL`); create it once with `docker compose exec postgres createdb -U urlshortener urlshortener_test`.
- `npm run lint`: ESLint
- `npm run typecheck`: `tsc --noEmit`
- `npm run format`: Prettier

## Configuration

Environment variables are listed in `.env.example`. `PORT`, `HOST`, `LOG_LEVEL` and `BASE_URL` have defaults. `DATABASE_URL` and `REDIS_URL` are optional until later steps use them. Invalid values stop the server at startup.
