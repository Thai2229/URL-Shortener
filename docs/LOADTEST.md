# Load testing

k6 scenarios, a seed script and a runner for the redirect, create and rate-limit paths. Results from one run on a shared 4-core machine are at the bottom.

## Prerequisites

- Node 22, `npm install`, k6 (any recent version; tested with 1.8.3), `redis-cli`, `curl`.
- Postgres and Redis reachable (for example `docker compose up -d postgres redis`).
- `DATABASE_URL` set (see `.env.example`). `REDIS_URL` defaults to `redis://localhost:6379` in `run.sh`.
- Port 3000 free: `run.sh` starts its own `node dist/server.js` (change with `PORT`).

## Running

```sh
export DATABASE_URL=postgres://urlshortener:urlshortener@localhost:5432/urlshortener

npm run loadtest:seed                      # migrate, insert SEED_COUNT (default 10000) links, write loadtest/codes.json
npm run loadtest                           # full suite: cache profile (smoke, redirect, mixed, spike), then ratelimit

PROFILE=cache RATE=4000 DURATION=20s LABEL=cache-4000 loadtest/run.sh redirect
PROFILE=nocache RATE=4000 DURATION=20s LABEL=nocache-4000 loadtest/run.sh redirect
PROFILE=ratelimit loadtest/run.sh ratelimit
```

`npm run loadtest:smoke|redirect|mixed|spike|ratelimit` run one script with k6 against an already running server (`BASE_URL`, default `http://localhost:3000`). Set `K6` to use another k6 binary. The server must have the matching settings (rate limiting off for everything except `ratelimit`, `LOG_LEVEL=warn`).

`run.sh` builds if `dist/` is stale, runs migrations and the seed, then for each script starts a fresh server, waits for `/readyz`, runs k6, saves selected `/metrics` lines and stops the server (trap on exit). Output goes to `loadtest/results/` (gitignored): `<script>-<label>.json` (k6 summary), `metrics-<label>.txt`, `server-<label>.log`. Exit code is non-zero if any k6 run crossed a threshold.

| Variable           | Default                 | Used by                                                             |
| ------------------ | ----------------------- | ------------------------------------------------------------------- |
| `BASE_URL`         | `http://localhost:3000` | k6 scripts                                                          |
| `RATE`, `DURATION` | `2000`, `30s`           | redirect, mixed, spike (peak is 3x `RATE`); ratelimit (`100`, `15s`) |
| `LABEL`            | `local` / generated     | result file names                                                   |
| `PROFILE`          | unset = suite           | `run.sh`: `cache`, `nocache`, `ratelimit`                           |
| `WARM`             | `0`                     | `run.sh`: `1` keeps `link:*` keys (warm cache start)                |
| `SEED_COUNT`       | `10000`                 | seed                                                                |
| `K6`, `PORT`       | `k6`, `3000`            | npm scripts / `run.sh`                                              |

Profiles: `cache` = `REDIS_URL` set, `RATE_LIMIT_ENABLED=false`, `LOG_LEVEL=warn`. `nocache` = same without `REDIS_URL`. `ratelimit` = `REDIS_URL` set, rate limiting on with default limits. Before each run `run.sh` deletes only `rl:*`, `clicks*` and (unless `WARM=1`) `link:*` keys, so cache runs start cold. It never uses FLUSHALL.

The seed deletes every link whose code starts with `lt` before inserting, so do not run it against a database holding real `lt...` codes.

## Scenarios

All requests use `redirects: 0`; k6 never follows the 302 to example.com.

| Script         | What it does                                                                                                                                                                                                               | Thresholds                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.js`     | 1 VU, 20 iterations: create, redirect (302 and Location), metadata, unknown code (404), `/healthz`, `/readyz`. Correctness check, not load.                                                                              | No failed requests, all checks pass, p95 < 200 ms.                                                                                                                          |
| `redirect.js`  | `constant-arrival-rate` of `GET /:code`. 80% of requests go to the first 20% of the codes (hot set), the rest are uniform; 2% use an unknown code (404 expected). The main read test.                                      | Unexpected-status rate < 1% (302 and 404 count as expected), p95 < 50 ms, p99 < 150 ms, checks > 99%. 50 ms is far under any user-visible redirect budget and tight enough to show queuing. |
| `mixed.js`     | Arrival rate with 95% redirects and 5% `POST /api/links` (unique URLs), tagged `name:redirect` / `name:create`.                                                                                                            | Redirect as above; create p95 < 150 ms; error rate < 1% per group.                                                                                                          |
| `spike.js`     | `ramping-arrival-rate`: `RATE/4` for 10 s, ramp to 3x `RATE`, hold 10 s, back to `RATE/4`, 10 s. Looks at queuing and recovery.                                                                                            | p95 < 200 ms, errors < 2%, checks > 98%. Looser because the ramp is meant to stress.                                                                                        |
| `ratelimit.js` | One IP posts 100 creates/s for 15 s against a limit of 20/min. Needs `RATE_LIMIT_ENABLED=true`.                                                                                                                            | Mix of 201 and 429, every 429 has `Retry-After`, 5xx rate exactly 0.                                                                                                        |

A run where k6 reports `dropped_iterations` did not offer the target rate. That means either the server was too slow (VUs all busy) or k6 itself could not keep up; check CPU of both before reading the latency numbers.

## Results

Run on 2026-11-22. Each scenario was run once; there are no repeats, so differences of a few ms are noise.

**Machine:** 4 vCPU, 16 GB RAM, Linux 6.18 (Firecracker VM), Node v22.23.5, k6 1.8.3, Postgres 16.15 and Redis 7 on localhost with default settings (no persistence for Redis), `PG_POOL_MAX=10` (the app default), 10,000 seeded links. k6, the Node server, Postgres and Redis all share the 4 cores. During a 4000 req/s run `top` showed k6 at about 125% CPU, node at 55-75%, Redis at about 16%, Postgres processes at a few percent each.

**Caveats.** Single machine with shared CPU, no network between components, a tiny dataset that fits in Postgres' cache, one Node process (one core for the event loop). The generator competes with the system under test, so absolute numbers are indicative only. At 4000 req/s and above k6 dropped iterations while node was not at 100% CPU, so those rows are partly limited by the load generator; the knee below is a lower bound on server capacity, not a measurement of it.

### Smoke

20 iterations, 120 requests: 0 failures, all checks pass, p95 2.3 ms.

### Redirect, cache profile (Redis, cold start every run, 20 s)

Hit ratio = `hit / (hit + miss + negative)` from `redirect_cache_total`. A cold start inflates misses: with 10,000 codes the first request to each code is a miss.

| Rate (req/s) | p50 ms | p95 ms | p99 ms | Unexpected status | Dropped | Hit ratio | Thresholds |
| ------------ | ------ | ------ | ------ | ----------------- | ------- | --------- | ---------- |
| 1000         | 0.56   | 1.6    | 7.8    | 0%                | 0       | 75.1%     | pass       |
| 2000         | 0.47   | 1.7    | 7.9    | 0%                | 0       | 82.1%     | pass       |
| 4000         | 0.57   | 8.1    | 46.0   | 0%                | 555     | 87.4%     | pass       |
| 6000         | 0.88   | 37.5   | 108.6  | 0%                | 3115    | 89.9%     | pass       |
| 8000         | 4.7    | 101.5  | 347.2  | 0%                | 6421    | 91.5%     | p95, p99 fail |
| 10000        | 36.3   | 162.3  | 265.0  | 0%                | 16772   | 92.5%     | p95 fail   |

Knee with cache: between 6000 and 8000 req/s. The 6000 run passes but delivered about 97% of the target and has a 1.3 s maximum; 8000 fails twice (8000, 10000), so the climb stopped there.

### Redirect, nocache profile (no `REDIS_URL`, every redirect is a Postgres lookup, 20 s)

| Rate (req/s) | p50 ms | p95 ms | p99 ms | Unexpected status | Dropped | Thresholds |
| ------------ | ------ | ------ | ------ | ----------------- | ------- | ---------- |
| 1000         | 0.68   | 1.1    | 3.1    | 0%                | 0       | pass       |
| 2000         | 0.60   | 1.6    | 8.6    | 0%                | 8       | pass       |
| 4000         | 0.59   | 37.6   | 68.4   | 0%                | 875     | pass       |
| 6000         | 1.1    | 68.6   | 146.9  | 0%                | 3063    | p95 fails  |
| 8000         | 87.1   | 217.2  | 387.9  | 0%                | 13224   | p95, p99 fail |

Knee without cache: between 4000 and 6000 req/s. Sampling `/metrics` during a 6000 req/s run showed all 10 pool connections busy and up to 15 requests waiting for a connection (`pg_pool_connections{state="waiting"}`). The post-run snapshots always show 0 waiting because they are taken after the load stops. The nocache run at 8000 also hit k6's VU cap ("Insufficient VUs", 1600), and server RSS rose to 201 MB while requests queued (cache profile: 131 MB).

### Mixed (cache, 2000 req/s, 30 s, 95% redirect / 5% create)

| Group    | p50 ms | p95 ms | p99 ms | Errors | Notes                                   |
| -------- | ------ | ------ | ------ | ------ | --------------------------------------- |
| redirect | 0.51   | 1.7    | 13.3   | 0%     | hit ratio 85.0%, cold start             |
| create   | 1.60   | 3.6    | 17.8   | 0%     | about 100 creates/s, the design target  |

1 dropped iteration out of 60,000. All thresholds passed.

### Spike (cache, `RATE/4` to 3x `RATE`, 50 s)

| `RATE` | Peak req/s | p50 ms | p95 ms | p99 ms | Errors | Dropped | Hit ratio | Thresholds |
| ------ | ---------- | ------ | ------ | ------ | ------ | ------- | --------- | ---------- |
| 1500   | 4500       | 0.44   | 1.6    | 6.2    | 0%     | 0       | 89.2%     | pass       |
| 2500   | 7500       | 0.68   | 12.7   | 26.0   | 0%     | 0       | 92.3%     | pass       |

The peak is held for only 10 s, so these runs tolerate a rate that the 20 s steady runs do not.

### Rate limit (profile `ratelimit`, default limits, one IP, 15 s)

1501 requests: 20 returned 201 (the create limit), 1481 returned 429 (`rate_limit_rejected_total{route="/api/links"}` = 1481). Every 429 carried `Retry-After`, 0 responses were 5xx. All thresholds passed.

### Other observations

- No 5xx in any run (checked the status-code histogram in every metrics snapshot). Server logs at `warn` were empty.
- RSS stayed at 95-140 MB in all cache runs. Click flushes ran every 5 s with `result="ok"` only.
- Process CPU for the whole server lifetime: cache 4000 run used about 13 s CPU (9.1 user, 4.0 system) for 80k requests; nocache 4000 used about 11.8 s.

## Findings and next steps

1. On this machine, Redis does not help latency: p50/p95 are within noise up to 4000 req/s, and the capacity gain is modest (knee between 6000 and 8000 vs 4000 and 6000). Postgres is local, the dataset fits in memory and the lookup is a unique-index read. The cache should pay off when Postgres is remote, busier or larger; this setup cannot show it. Re-run against separate hosts before drawing conclusions about the cache.
2. The cache path costs Node CPU too: per hit there is a Redis read plus a click counter write (`HINCRBY`). It is not a bug, but if the single event loop is the limit, running several instances (the design's scaling path) matters more than the cache.
3. The design target of about 5k redirects/s and 100 creates/s is met on this box in the steady cache runs up to 6000 req/s (with dropped iterations from 4000), and the mixed run covers the creates target. Because k6 is a bottleneck above 4000, confirm with a generator on another machine.
4. The default pool of 10 connections is the first limit without the cache: 15 waiting requests were seen at 6000 req/s. If the cache is down in production, redirects fall back to Postgres and this is what will queue. Consider an alert on `pg_pool_connections{state="waiting"} > 0`.
5. Unknown codes in `redirect.js` are random each time, so they always count as `miss` and never `negative`; the hit ratio therefore tops out near 98%. Real scanners that repeat codes would hit the negative cache.
6. Cold start is visible: at 1000 req/s the first 20 s had 25% misses. Run with `WARM=1` for a steady-state view.
7. Not done: longer soak runs, a larger dataset, a Postgres-slower scenario, a generator on a separate host, multiple app instances behind a load balancer.
