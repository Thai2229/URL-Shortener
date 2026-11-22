# Scaling out

The API is stateless, so it scales by running more replicas behind nginx. Shared state lives in Redis and Postgres. PgBouncer sits in front of Postgres so that many replicas do not each hold many database connections.

```
                      client
                        |
                        v
                +---------------+   X-Forwarded-For overwritten with the client address
                |     nginx     |   /metrics and /readyz: private clients only
                | (one hop)     |   GET retried on the next replica on connect errors/timeouts/503
                +-------+-------+
          round robin   |   keepalive upstream
        +---------------+---------------+
        v               v               v
   +---------+     +---------+     +---------+
   | api #1  |     | api #2  | ... | api #N  |    TRUST_PROXY=1, PG_POOL_MAX each
   +----+----+     +----+----+     +----+----+
        |               |               |
        +-------+-------+---------------+
                |                       |
                v                       v
        +--------------+        +----------------+
        |    Redis     |        |   PgBouncer    |   transaction pooling
        | cache        |        |   :6432        |
        | rate limits  |        +-------+--------+
        | click counts |                |
        | flush lock   |                v
        +--------------+        +----------------+
                                |   PostgreSQL   | <---- migrate (one-shot, direct :5432,
                                +----------------+        MIGRATE_DATABASE_URL)
```

## What scales and what does not

| Part | Scales by adding replicas? | Notes |
| --- | --- | --- |
| Request handling (Node event loop) | Yes | One process uses about one core. |
| Rate limiting | Yes | Counters are Redis keys `rl:{route}:{ip}`, shared by all replicas. Verified by `loadtest/scaleout.sh`: a limit of 20 gives exactly 20 `201`s across 3 replicas. |
| Click counting | Yes | Every replica `HINCRBY`s the same Redis hash. Any replica may flush it; the Redis lock `clicks:lock` (30 s expiry) lets one flusher run at a time, so the others skip that tick. The final flush on shutdown is skipped if another replica holds the lock; the counts stay in Redis and the next flush writes them. |
| Link cache | Shared | One Redis cache for all replicas. Redis is a single node here and is the shared bottleneck and single point of failure for cache, limits and counters. |
| Postgres | No | One primary. Reads that miss the cache and all writes go to it. Scaling it means a bigger box, or read replicas for metadata reads (not built). |
| PgBouncer | Not needed yet | One instance handles thousands of client connections. It is another single point of failure. |
| Redis | No | Single node. Cluster or Sentinel is out of scope. |

More replicas than CPU cores do not add throughput on one machine. See the caveats in [LOADTEST.md](LOADTEST.md#scaling-out).

## PgBouncer in transaction mode

`deploy/pgbouncer.ini` uses `pool_mode = transaction`: a server connection is assigned for the length of one transaction, then returned. Consequences:

- No session state between statements. Do not use session-level advisory locks, `LISTEN`/`NOTIFY`, `SET` outside a transaction (use `SET LOCAL`), `WITH HOLD` cursors or temp tables that outlive a transaction. The app uses none of them.
- The migration runner takes a session-level `pg_advisory_lock`, so it must use a direct connection. Set `MIGRATE_DATABASE_URL` to the Postgres address (not PgBouncer); `src/scripts/migrate.ts` uses it and falls back to `DATABASE_URL`. Through PgBouncer the lock is taken on whichever server connection the statement lands on and is not released when the client disconnects. We saw this: a lock taken through PgBouncer was still held in `pg_locks` after the client exited, and the `test/db/migrate.test.ts` lock tests failed intermittently (see LOADTEST.md).
- `statement_timeout`: `pg` sends it as a startup parameter, which PgBouncer rejects. The config ignores it (`ignore_startup_parameters = statement_timeout`) and sets the same 5 s cap on every new server connection with `connect_query` in `[databases]`. Keep both in step with `src/db/pool.ts`.
- Prepared statements: `pg` only uses unnamed statements for parameterized queries, which work in transaction mode. `max_prepared_statements = 100` lets PgBouncer 1.21+ track named ones if they are added later. The `UNNEST` statement in the click flush runs fine through the pool.
- `LISTEN` does not work. The app does not use it.

### PgBouncer image, admin console and healthcheck

- `image: ${PGBOUNCER_IMAGE:-edoburu/pgbouncer:latest}`. `latest` is only a default so `compose up` works. Set `PGBOUNCER_IMAGE` to an explicit version (1.21 or later, needed for `max_prepared_statements`) and optionally a digest (`name:tag@sha256:...`). No tag was chosen here because Docker Hub was not reachable when this was written.
- The healthcheck runs `pg_isready`, which assumes that binary exists in the image. That is unverified without Docker. If it is missing, use a TCP check instead, for example `['CMD-SHELL', 'nc -z 127.0.0.1 6432']`, or a bash `/dev/tcp` redirect.
- `deploy/pgbouncer.ini` sets no `admin_users` or `stats_users`, so the app user cannot open the admin console and the file hardcodes no user name (the userlist is generated from `POSTGRES_USER`). To get `SHOW POOLS`, add a separate admin user with its own password supplied from the environment. `loadtest/scaleout.sh` does this for its local copy with a random password.

## Tuning knobs

| Knob | Where | Guidance |
| --- | --- | --- |
| `PG_POOL_MAX` | env on each replica (default 10) | Client-side pool per replica. The total across replicas may exceed PgBouncer's pool; excess clients wait in PgBouncer (`cl_waiting`). Keep `replicas x PG_POOL_MAX` below `max_client_conn`. |
| `default_pool_size`, `reserve_pool_size` | `deploy/pgbouncer.ini` | Real connections to Postgres. Rule of thumb: a small multiple of the Postgres cores (here 20 for a small box), not the sum of the replica pools. Raise it only if `SHOW POOLS` shows `cl_waiting` and Postgres still has idle CPU. |
| `max_connections` | Postgres `command:` in Compose | At least `default_pool_size + reserve_pool_size` plus migrate, admin and monitoring headroom. Set to 50 in Compose. |
| `shared_buffers`, `effective_cache_size`, `log_min_duration_statement` | Postgres `command:` | 256MB / 768MB for a roughly 2 GB box; slow statements over 200 ms are logged. `synchronous_commit` stays on. |
| `maxmemory`, eviction | Redis `command:` | 256mb with `allkeys-lru`. Under pressure Redis evicts any key, including counters and rate-limit keys, not just cache entries. Raise `maxmemory` before that happens; watch `evicted_keys`. |
| `appendonly yes`, `appendfsync everysec` | Redis `command:` | The cache can be lost without harm. Pending click counts and rate-limit state live in Redis too, and AOF keeps them across a restart at the cost of up to about a second of writes on a crash. |
| `keepalive`, timeouts, `client_max_body_size` | `deploy/nginx.conf` | `keepalive 64` idle upstream connections per worker; 2 s connect, 10 s read/send timeouts; 8k body limit. |
| `RATE_LIMIT_*` | env on each replica | Same values on every replica; the counters are shared. |
| `CLICK_FLUSH_INTERVAL_SECONDS` | env on each replica | Lag of `clickCount`. Compose default 5. |
| `stop_grace_period` | Compose, `api` | 15 s, above the app's 8 s shutdown bound, so the final click flush is not killed. |

## Failure behavior

| Failure | What happens |
| --- | --- |
| Redis down | Redirects fall back to Postgres (cache off). Rate limits fall back to in-memory counters per replica, so the effective limit becomes about N times higher until Redis returns. Clicks during the outage are not counted. `/readyz` stays `200` with `redis: down`. |
| Postgres down | Redirects of cached links still work for the cache TTL (up to 24 h). Cache misses, creates and metadata fail with errors, and `/readyz` returns `503`. Pending clicks stay in Redis and the flush retries (`click_flush_total{result="error"}`). Not exercised end to end here. |
| One replica down | nginx retries idempotent requests (GET, HEAD) on the other replicas after a connect error, a timeout or a `503` (a replica that is shutting down) and skips the dead one for 10 s (`fail_timeout` default); at most 3 tries within 5 s. Measured with `loadtest/scaleout.sh` (`ONLY=f REPLICAS=2`, 300 req/s for 12 s, replica 2 sent SIGTERM at 4 s), five runs after `http_503` was added: 0 failed of 3601, 3601, 3601, 3601 and 3600 requests, so 0 failed in 5 of 5 runs. The check fails only above a budget of 5 per 10,000 requests (`TERM_BUDGET_PER_10K`), and it also fails if fewer than 90% of the planned requests were sent or the replica had not served traffic before the kill. One run at 2000 req/s: 0 failed of 24000 (SIGTERM) and of 24002 (SIGKILL). A `POST` is never retried once nginx has sent it (nginx's default; checked with a stub upstream that returns `503`: 6 POSTs made 6 upstream requests, no retries, while GETs were retried onto the healthy upstream), so a create that hits a dying replica returns an error to the client. |
| PgBouncer down | Replicas cannot open database connections (5 s connect timeout). Cached redirects keep working; everything that needs Postgres fails and `/readyz` returns `503`. Click flushes fail and retry. Not exercised here. |
| Replica recreated (Compose) | nginx resolves `api` when it starts or reloads. After `--scale api=N` changes or containers are recreated, run `docker compose exec nginx nginx -s reload`. |

## The `TRUST_PROXY=1` and nginx contract

Rate limits are per client IP, so the app must see the real client address.

- nginx sets `X-Forwarded-For` to `$remote_addr`, overwriting any client-supplied value (never `$proxy_add_x_forwarded_for`).
- The replicas run with `TRUST_PROXY=1`: exactly one trusted hop. The client is the last `X-Forwarded-For` entry, which nginx wrote.
- Replicas must not be reachable except through nginx. A client that connects to a replica directly can send its own `X-Forwarded-For` and pick its bucket (the scale-out check shows this as a control). In Compose, `api` only uses `expose`, so no host port exists.
- Do not put another proxy or load balancer in front of nginx without changing this contract: either make nginx use the real-IP module with that proxy's address, or move to `TRUST_PROXY` with explicit addresses.
- `/metrics` and `/readyz` are answered with `404` by nginx unless the client address is in a private range (loopback, `10/8`, `172.16/12`, `192.168/16`, `::1`, `fc00::/7`). `/healthz` and everything else are proxied. The check is only as good as the address nginx sees. If a cloud load balancer or Docker Desktop proxy sits in front, outside clients can appear as private addresses; set `METRICS_TOKEN` as well: it is the second line of defense, and Compose forwards `METRICS_TOKEN` and `METRICS_ENABLED` to the replicas (an empty token means unset). Scrape replicas directly on the internal network where you can.
- The same caveat has a second half. Behind a cloud load balancer, every client reaches nginx from the balancer's address, so nginx writes that one address into `X-Forwarded-For` and all clients share one rate-limit bucket. Fix it by putting the balancer's real client address into the chain: a `set_real_ip_from <balancer address>;` plus `real_ip_header X-Forwarded-For;` (or `proxy_protocol`) block in `deploy/nginx.conf`, with `set_real_ip_from` limited to the balancer's verified address range so clients cannot forge it. Or terminate the public connection at nginx.

A note on the Fastify version in use (5.12): a numeric `trustProxy` is treated as "trust nobody", so `TRUST_PROXY=1` originally had no effect and every client shared nginx's address. `src/app.ts` now turns a hop count into an explicit hop function, with a test in `test/ratelimit.test.ts`.

## Run it

With Docker:

```sh
cp .env.example .env
docker compose up --build --scale api=3
curl localhost:3000/healthz
```

nginx publishes `${HTTP_PORT:-3000}`. Postgres and Redis are not published. For host access (tests, `psql`), copy `docker-compose.override.example.yml` to `docker-compose.override.yml`. The `migrate` service runs once and the replicas wait for it.

The Compose file was only checked with `docker compose config`; the containers have not been started in the environment this was written in.

Without Docker (local Postgres and Redis, plus `nginx`, `pgbouncer`, `k6`, `redis-cli`, `psql`, `jq` on the PATH):

```sh
export DATABASE_URL=postgres://urlshortener:urlshortener@localhost:5432/urlshortener
REPLICAS=3 loadtest/scaleout.sh                                  # correctness checks, PASS/FAIL per check
MODE=bench REPLICAS=2 RATE=2000 DURATION=20s loadtest/scaleout.sh # k6 redirect through nginx + PgBouncer
```

The script starts replicas on ports 3001 and up, PgBouncer on 6432 and nginx on 8080 (plus 8081 for the outside-client check) from temp copies of `deploy/nginx.conf` and `deploy/pgbouncer.ini`, and stops all of them on exit. It uses the same local-only guard as `loadtest/run.sh`. Everything binds to `127.0.0.1`. The temp dir is mode 700 and its files 600. PgBouncer refuses to run as root, so when the script runs as root PgBouncer runs as `nobody` (`PGB_USER` to change) with its own 700 dir owned by that user; otherwise it runs as the invoking user. The script prints an `ERROR line N: command` and an ABORTED verdict if it stops early. `ONLY=f` runs just the kill checks.
