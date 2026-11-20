# URL shortener build plan

A URL shortener built to scale out horizontally. Redirects far outnumber new links, so a redirect checks Redis, falls back to Postgres on a miss, and does no other work.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime / HTTP | Node 22, TypeScript, Fastify 5 | One of the fastest Node HTTP frameworks; built-in JSON-schema validation and pino logging |
| Database | PostgreSQL 17 via `pg` (node-postgres) | Source of truth for links; unique index on `code` is the hot lookup |
| Cache | Redis 7 via `ioredis` | Cache-aside for `code → url`, plus shared state for rate limiting and click counters |
| Rate limiting | @fastify/rate-limit with the Redis store | Limits are shared across all API replicas, not per process |
| Load testing | k6 (run from the `grafana/k6` Docker image) | Scriptable scenarios with pass/fail thresholds on p95 latency and error rate |
| Tests | Vitest + Fastify `inject`, against real Postgres and Redis | Catches SQL and cache bugs that mocks hide |
| Lint / format | ESLint (typescript-eslint) + Prettier | |
| Migrations | Plain SQL files + a small runner script | No ORM on the hot path |
| Metrics | `fastify-metrics` (Prometheus format) | Cache hit ratio, latency histograms, pool stats |
| Local infra | Docker Compose | Postgres, Redis, API, later nginx + PgBouncer |
| CI | GitHub Actions with Postgres and Redis service containers | |

## Architecture

```
client ──► nginx (step 9) ──► API replicas (Fastify, stateless)
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
          Redis: cache     Redis: rate limit   Redis: click counters
                 │ miss                            │ batch flush
                 ▼                                 ▼
          PostgreSQL (via PgBouncer in step 9) ◄───┘
```

### Key decisions

- Short codes. 7 random base62 characters from `crypto.randomBytes` (62^7 ≈ 3.5 trillion). Insert with `ON CONFLICT (code) DO NOTHING` and retry on the rare collision. There is no central counter to coordinate, and codes can't be enumerated.
- Redirect status. `302` by default. Browsers cache a `301` permanently, which would hide clicks and break expiry and deletion.
- Caching. Cache-aside with key `link:{code}`, a 24h TTL with jitter, capped at the link's `expires_at`. Misses are cached briefly (60s) so lookups for unknown codes can't hammer Postgres. If Redis is down, the API falls back to Postgres rather than failing.
- Rate limiting. Per-IP, stored in Redis: strict on `POST /api/links`, loose on redirects. Returns `429` with `Retry-After`. Fails open if Redis is unreachable.
- Click counting. `INCR` in Redis on each redirect, flushed to Postgres in batches every few seconds. This keeps a database write off every redirect.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/links` | Create a short link: `{ "url": "https://…", "expiresAt"?: ISO date }` → `201 { code, shortUrl, url, expiresAt }` |
| `GET` | `/:code` | Redirect (302); 404 if unknown, 410 if expired |
| `GET` | `/api/links/:code` | Link metadata, including click count |
| `GET` | `/healthz`, `/readyz` | Liveness; readiness checks Postgres and Redis |
| `GET` | `/metrics` | Prometheus metrics |

URL validation: `http`/`https` only, max 2048 characters, and the target can't be the shortener's own domain (no redirect loops).

## Steps, owners, and review points

Each step lands as its own commit on the PR branch. Every step stops for your review before the next one starts.

| # | Step | Agents | What you review |
|---|---|---|---|
| 1 | Scaffold: Fastify + TS app factory, config from env, `/healthz`, ESLint/Prettier, Vitest, Dockerfile, Compose (Postgres + Redis), CI workflow | backend-developer → code-reviewer | Project layout, scripts, Compose file |
| 2 | Postgres layer: `links` schema, indexes, migration runner, repository functions, pool config | postgres-pro (schema) → tdd-guide (tests) → backend-developer → code-reviewer | Schema and indexes |
| 3 | Core API: create, redirect, metadata endpoints; code generation; URL validation; error format | tdd-guide → backend-developer → code-reviewer → security-reviewer | Endpoint behavior, validation rules |
| 4 | Redis caching: cache-aside on redirects, negative caching, TTL rules, Redis-down fallback, `/readyz` checks | tdd-guide → backend-developer → code-reviewer | Cache keys, TTLs, failure behavior |
| 5 | Rate limiting: `@fastify/rate-limit` + Redis store, per-route limits, `trustProxy` setup, 429 responses | tdd-guide → backend-developer → code-reviewer → security-reviewer | Limit values, IP handling behind a proxy |
| 6 | Click analytics: Redis counters, batched flush to Postgres, flush on shutdown | postgres-pro → tdd-guide → backend-developer → code-reviewer | Flush interval, accuracy trade-off |
| 7 | Observability: Prometheus metrics (latency, cache hit ratio, pool usage), structured logs | backend-developer → code-reviewer | Metric names |
| 8 | Load testing: k6 scenarios (smoke, steady load, spike, cache-off baseline), seed script, thresholds, results doc | backend-developer → code-reviewer | Baseline numbers, threshold targets |
| 9 | Scale-out and tuning: N API replicas behind nginx, PgBouncer, Postgres and Redis tuning (`maxmemory-policy allkeys-lru`), re-run k6 and compare | postgres-pro → backend-developer → code-reviewer | Before/after results |
| 10 | Hardening and docs: full security pass, README, k6 smoke test in CI | security-reviewer → code-reviewer | Final PR |

`humanizer` runs on every README, doc, and PR description before it's finished.

## Open questions (assumptions in brackets)

1. Target load? [Design for ~5k redirects/sec and ~100 creates/sec on one machine; step 8 measures what we actually get.]
2. Who can create links? [Anyone, anonymously, protected by rate limiting. API keys could be added later.]
3. Custom aliases (`/my-brand`)? [Not in scope yet. The schema allows them, so adding them later needs no migration.]
4. Short domain? [Configured via `BASE_URL`; defaults to `http://localhost:3000`.]
