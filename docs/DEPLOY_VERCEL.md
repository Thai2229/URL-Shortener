# Deploying to Vercel

This runs the whole app as one Vercel function (Fluid compute), with Neon for Postgres and Upstash for Redis. Nothing here has been deployed from the environment where it was written; see [Not verified](#not-verified).

## Steps

1. Prerequisites: the repository is on GitHub, and you have a Vercel account (the Hobby plan is enough).
2. In Vercel choose Add New, then Project, and import the repository. Set Framework Preset to Other. Leave the build and output settings alone; `vercel.json` sets the build command (`npm run vercel-build`).
3. Before the first deploy, open the project's Storage tab and add Neon (Postgres) and Upstash (Redis) from the Marketplace. Connect both to the Production environment only (see [Preview deployments](#preview-deployments)). They inject:
   - Neon: `DATABASE_URL` (pooled, PgBouncer transaction mode) and `DATABASE_URL_UNPOOLED` (direct).
   - Upstash: `KV_URL` (a `rediss://` URL). The app reads `REDIS_URL` first, then `KV_URL`.
4. Under Settings, Environment Variables, add the variables below.
5. Deploy. Production deploys run migrations during the build (see below).
6. Run the verification checklist.

## Environment variables

| Variable                       | Value                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `PG_POOL_MAX`                  | `5`. Instances share 1,024 file descriptors; this is also the default on Vercel.                 |
| `PG_POOL_IDLE_MS`              | `10000`. Idle connections are released sooner than the default 30000.                            |
| `REDIS_COMMAND_TIMEOUT_MS`     | `500`. The default 200 is tight for a remote Redis. Range 1 to 10000.                            |
| `REDIS_CONNECT_TIMEOUT_MS`     | Optional. Default 5000 for `rediss://` URLs, 1000 otherwise.                                     |
| `RATE_LIMIT_ENABLED`           | `true` (default). See the quota warning below.                                                   |
| `RATE_LIMIT_WINDOW_SECONDS`, `RATE_LIMIT_CREATE_MAX`, `RATE_LIMIT_REDIRECT_MAX`, `RATE_LIMIT_READ_MAX` | Optional. Defaults 60, 20, 600, 120.     |
| `CLICK_FLUSH_INTERVAL_SECONDS` | `10`. Minimum time between request-driven flushes. `0` turns them off.                           |
| `CRON_SECRET`                  | Random string of 32 or more characters (`openssl rand -hex 32`). Enables `/api/cron/flush`. Vercel sends it as `Authorization: Bearer <value>`. |
| `METRICS_TOKEN`                | Random string of 16 or more characters (`openssl rand -hex 32`). On Vercel, `/metrics` and `/readyz` are off unless this is set, and then both require `Authorization: Bearer <value>`. |
| `BASE_URL`                     | Optional. Production defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL`, previews to `https://$VERCEL_URL`. Set it for a custom domain; it overrides both. |
| `TRUST_PROXY`                  | Leave unset. When `VERCEL=1` and `VERCEL_ENV` is non-empty it defaults to `true`, because Vercel overwrites `X-Forwarded-For`. |

Do not set `REDIS_URL` unless you want to override `KV_URL`.

Vercel sets `VERCEL=1` and `VERCEL_ENV` itself. Never set them anywhere else: together they make the app trust `X-Forwarded-For`, so a client could forge its address and dodge the rate limiter.

On Vercel `/metrics` and `/readyz` are off unless `METRICS_TOKEN` is set. With a token, both need the bearer token. `/healthz` is always public. `METRICS_ENABLED` overrides the default for `/metrics` only.

Store `CRON_SECRET`, `METRICS_TOKEN` and the database and Redis URLs as Sensitive environment variables. Generate both secrets with `openssl rand -hex 32`.

## Preview deployments

Connect Neon and Upstash to Production only. Give Preview its own Neon branch or database and its own Redis, added as Preview environment variables. Two reasons:

- Preview builds run the branch's code with whatever credentials they receive. Anyone who can push a branch could read or change production data through them.
- Preview code runs against the schema it finds. Previews skip migrations, so a branch that expects a newer schema breaks against production, and an older one can break production's.

Keep "Require approval for fork PR deployments" enabled so fork pull requests cannot run code with your secrets.

Short links built on a preview use `https://$VERCEL_URL`, the per-deployment domain. Set `BASE_URL` to override it.

## Migrations

`scripts/vercel-build.sh` builds, then runs `node dist/scripts/migrate.js` only when `VERCEL_ENV` is `production` and a database URL is set. The migration URL is the first of `MIGRATE_DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `DATABASE_URL`. Migrations take a session advisory lock, so they need Neon's direct URL, not the pooled one. On production deploys, if `MIGRATE_DATABASE_URL` is not set and the first of `DATABASE_URL_UNPOOLED`, `DATABASE_URL` has a `-pooler` host, the build fails before compiling and the error names `MIGRATE_DATABASE_URL` and `DATABASE_URL_UNPOOLED`. An explicit `MIGRATE_DATABASE_URL` is used as given. Preview deploys skip migrations and print why.

To migrate by hand instead: `vercel env pull .env.production.local`, export `DATABASE_URL_UNPOOLED` from it, and run `npm run db:migrate`. Do not commit the pulled file.

## Verify

Replace `$URL` with your deployment URL, and `$CRON_SECRET` and `$METRICS_TOKEN` with the values you set.

```sh
# create
curl -s -X POST $URL/api/links -H 'content-type: application/json' -d '{"url":"https://example.com"}'
# redirect: expect 302 and a Location header
curl -i $URL/<code>
# metadata: a read can trigger a flush; see Click count freshness
curl -s $URL/api/links/<code>
# health
curl -s $URL/healthz
# with METRICS_TOKEN set: 401 without the token, 200 with it (404 for both if it is unset)
curl -i -H "Authorization: Bearer $METRICS_TOKEN" $URL/readyz
# cron endpoint: 401 without the token, 200 {"flushed":...} with it
curl -i $URL/api/cron/flush
curl -i -H "Authorization: Bearer $CRON_SECRET" $URL/api/cron/flush
# a spoofed X-Forwarded-For must not dodge the limiter: send more than RATE_LIMIT_CREATE_MAX
# creates in one window, each with a different forged header, and expect a 429.
for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code} ' -X POST $URL/api/links \
  -H 'content-type: application/json' -H "X-Forwarded-For: 10.0.0.$i" -d '{"url":"https://example.com"}'; done
```

## Click count freshness

A redirect or a metadata read (`GET /api/links/:code`) triggers a flush at most once per `CLICK_FLUSH_INTERVAL_SECONDS` across all instances. If traffic stops, clicks recorded after the last flush wait for the next redirect, the next metadata read or the daily cron. On the Hobby plan a count can therefore be up to about a day behind. The read that triggers the flush returns the older number; the next read is fresh.

## Upstash free-tier quota

A redirect costs about 3 Redis commands: the cache read, the click counter and the rate-limit counter. The free tier allows 500,000 commands per month, so roughly 160,000 redirects. Do not run the k6 suite against the deployed URL; it would use the quota in minutes.

To use fewer commands:

- `RATE_LIMIT_ENABLED=false` removes the rate-limit counter. You lose abuse protection; nothing limits creation or scanning.
- `CLICK_FLUSH_INTERVAL_SECONDS=0` stops request-driven flushes. Counts then reach Postgres only from the daily cron, so `clickCount` is up to a day behind. The counter command per redirect remains.

## Differences from the Docker deployment

- `/` and the static assets (`app.js`, `styles.css`, `favicon.svg`) are served by the Vercel CDN straight from `public/`, before the rewrite to the function. The function bundle also contains `public/` (`includeFiles` in `vercel.json`), because the home route reads those files at startup; without it the function would fail to start.
- No nginx and no PgBouncer. Vercel is the edge, and Neon's pooled URL replaces PgBouncer.
- No interval flusher. After a redirect, the function calls `flushIfDue` through `waitUntil`: at most one flush per instance per interval, and one cluster-wide through a `<prefix>:due` marker in Redis. A daily cron (`17 4 * * *`) is the backstop. Metadata reads also schedule a flush. Clicks after the last flush wait for the next redirect, the next metadata read or the cron.
- `/metrics` is off by default and per instance, so scrapes see whichever instance answers.
- The Postgres pool defaults to 5 connections.
- The Redis client is not registered with `attachDatabasePool`: the installed `@vercel/functions` throws for ioredis clients. Only the pg pool is registered.

## Troubleshooting

- 404 on every route: the rewrite or framework setting is not applied. Check that Framework Preset is Other and that `vercel.json` is at the repository root.
- 500 on every request after a deploy: `DATABASE_URL` is missing for that environment. Check the Neon connection covers it.
- Everyone shares one rate-limit bucket: `TRUST_PROXY` is set to something other than `true`, or `VERCEL` is not `1`.
- Cron returns 401: `CRON_SECRET` changed. Redeploy so Vercel sends the new value.
- Redis errors in the logs and no caching: check `KV_URL` and try a larger `REDIS_COMMAND_TIMEOUT_MS`.

## Not verified

Nothing here has been deployed to Vercel from this environment. It was exercised locally by running the built handler (`dist/vercel.js`) behind `http.createServer` against local Postgres and Redis. Assumptions that need a real deploy to confirm:

- `framework: null` with a function in `api/` and a catch-all rewrite to `/api` routes every path to the function.
- The static ESM import from `api/index.js` to `../dist/vercel.js` is traced into the function bundle, so `includeFiles` is not set.
- Hobby cron cadence: the Cron Jobs page and the Schedules beta page disagree on what Hobby allows. Daily is assumed to be accepted; check that the deploy is not rejected.
- Upstash over TCP under concurrent instances: connection counts and latency with `rediss://` have not been measured.
- `waitUntil` keeps the function alive long enough for a flush after the redirect is sent.
