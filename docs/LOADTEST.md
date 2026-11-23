# Load testing

k6 scenarios, a seed script and a runner for the redirect, create and rate-limit paths. Results from one run on a shared 4-core machine are at the bottom.

## Prerequisites

- Node 22, `npm install`, k6 (any recent version; tested with 1.8.3), `redis-cli`, `curl`.
- Postgres and Redis reachable (for example `docker compose up -d postgres redis` with `docker-compose.override.yml` copied from the example so the ports are published).
- `DATABASE_URL` set (see `.env.example`). `REDIS_URL` defaults to `redis://localhost:6379` in `run.sh`.
- Safety guard: `run.sh` and `seed.ts` refuse to run unless the host of `DATABASE_URL` and `REDIS_URL` (if set) is `localhost`, `127.0.0.1` or `::1`, and they exit before touching anything. Set `LOADTEST_ALLOW_REMOTE=1` to override. A missing `REDIS_URL` is fine (`PROFILE=nocache`). The run deletes every `lt%` link and the `link:*`, `rl:*` and `clicks*` Redis keys, so never point it at data you care about.
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

`run.sh` builds if `dist/` is stale, runs migrations and the seed, then for each script starts a fresh server, waits for `/readyz`, runs k6, saves selected `/metrics` lines and stops the server (trap on exit). Output goes to `loadtest/results/` (gitignored): `<script>-<label>.json` (k6 summary), `metrics-<script>-<label>.txt`, `server-<script>-<label>.log`. Exit code is non-zero if any k6 run crossed a threshold. The saved results use this naming too (the files were renamed after the run).

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
| `redirect.js`  | `constant-arrival-rate` of `GET /:code`. 80% of requests pick from the first 20% of the codes (hot set, 2000 codes) and the other 20% pick uniformly from all codes, so the hot set receives about 84% of requests (0.8 + 0.2 x 0.2) and the other 8000 codes share about 16%; 2% use an unknown code (404 expected). The main read test.                                      | Unexpected-status rate < 1% (302 and 404 count as expected), p95 < 50 ms, p99 < 150 ms, checks > 99%. 50 ms is tight enough to show queuing. |
| `mixed.js`     | Arrival rate with 95% redirects and 5% `POST /api/links` (unique URLs), tagged `name:redirect` / `name:create`.                                                                                                            | Redirect as above; create p95 < 150 ms; error rate < 1% per group.                                                                                                          |
| `spike.js`     | `ramping-arrival-rate`: `RATE/4` for 10 s, ramp to 3x `RATE`, hold 10 s, back to `RATE/4`, 10 s. Looks at queuing and recovery.                                                                                            | p95 < 200 ms, errors < 2%, checks > 98%. Looser because the ramp is meant to stress.                                                                                        |
| `ratelimit.js` | One IP posts 100 creates/s for 15 s against a limit of 20/min. Needs `RATE_LIMIT_ENABLED=true`.                                                                                                                            | Mix of 201 and 429, every 429 has `Retry-After`, 5xx rate exactly 0.                                                                                                        |

A run where k6 reports `dropped_iterations` did not offer the target rate. That means either the server was too slow (VUs all busy) or k6 itself could not keep up; check CPU of both before reading the latency numbers.

## Results

Run on 2026-11-22. Each scenario was run once; there are no repeats, so differences of a few ms are noise.

Machine: 4 vCPU, 16 GB RAM, Linux 6.18 (Firecracker VM), Node v22.23.5, k6 1.8.3, Postgres 16.15 and Redis 7 on localhost with default settings (no persistence for Redis), `PG_POOL_MAX=10` (the app default), 10,000 seeded links. k6, the Node server, Postgres and Redis all share the 4 cores. During a 4000 req/s run `top` showed k6 at about 125% CPU, node at 55-75%, Redis at about 16%, Postgres processes at a few percent each.

Caveats: single machine with shared CPU, no network between components, a tiny dataset that fits in Postgres' cache, one Node process (one core for the event loop). The generator competes with the system under test, so absolute numbers are indicative only. At 4000 req/s and above k6 dropped iterations while node was not at 100% CPU, so those rows are partly limited by the load generator; the knee below is only a lower bound on server capacity.

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
| 10000        | 36.3   | 162.3  | 265.0  | 0%                | 16772   | 92.5%     | p95, p99 fail |

Knee with cache: between 6000 and 8000 req/s. The 6000 run passes its thresholds but dropped 3115 iterations (it delivered about 97% of the arrival rate) and has a 1.3 s maximum. Both 8000 and 10000 fail p95 and p99, so the climb stopped there.

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

## Scaling out

Run on 2026-11-22 on the same 4-core VM as above, with `loadtest/scaleout.sh` in `MODE=bench`: k6 `redirect.js` (cold cache start, 10,000 seeded links, 20 s, rate limiting off, `LOG_LEVEL=warn`, `REDIS_URL` set) goes through nginx (4 workers, `deploy/nginx.conf`) to N replicas, which use PgBouncer (transaction mode, pool 20) to the local Postgres. The "direct" rows are `run.sh PROFILE=cache` re-run in the same session (one Node process, no nginx, no PgBouncer). Each cell is a single run; differences of a few ms or a few hundred dropped iterations are within noise.

Replica CPU is `top` over a 3 s window about 8 s into the run (100% = one core). k6 was at 82-85% (2000 req/s) and 110-120% (4000 req/s) in every row.

| Setup | Rate | p50 ms | p95 ms | p99 ms | Dropped | CPU per replica | nginx workers (total) | Redis |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| direct, 1 process | 2000 | 0.47 | 1.44 | 9.45 | 0 | not sampled | none | not sampled |
| nginx + PgBouncer, 1 replica | 2000 | 0.64 | 2.22 | 34.4 | 9 | 44% | 21% | 11% |
| nginx + PgBouncer, 2 replicas | 2000 | 0.64 | 2.22 | 9.81 | 105 | 29%, 29% | 21% | 11% |
| nginx + PgBouncer, 4 replicas | 2000 | 0.68 | 3.74 | 17.5 | 246 | 17-19% each | 21% | 13% |
| direct, 1 process | 4000 | 0.52 | 5.62 | 49.0 | 369 | not sampled | none | not sampled |
| nginx + PgBouncer, 1 replica | 4000 | 0.71 | 8.80 | 116.0 | 845 | 61% | 30% | 16% |
| nginx + PgBouncer, 2 replicas | 4000 | 0.68 | 7.00 | 51.4 | 333 | 39%, 39% | 34% | 17% |
| nginx + PgBouncer, 4 replicas | 4000 | 0.76 | 10.49 | 73.8 | 537 | 23-24% each | 30% | 18% |

Earlier single-process cache run from the Results section above for reference: 2000 req/s p50 0.47, p95 1.7, p99 7.9 ms, 0 dropped; 4000 req/s p50 0.57, p95 8.1, p99 46.0 ms, 555 dropped.

No row had failed requests or 5xx. All thresholds passed. (The redirect thresholds are p95 < 50 ms, p99 < 150 ms.)

PgBouncer under these runs: with the cache on, redirects rarely reach Postgres, so the pool was idle: `SHOW POOLS` showed `cl_waiting` 0 and `maxwait` 0, and PgBouncer used about 2% CPU. To see it work, two extra runs used `NOCACHE=1` (no `REDIS_URL`, so every redirect is a Postgres lookup through PgBouncer) at 4000 req/s:

| Setup | p50 ms | p95 ms | p99 ms | Dropped | Replica CPU | PgBouncer CPU | `SHOW POOLS` (4 samples) | `SHOW STATS` total wait |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 replica, no cache | 0.96 | 14.08 | 75.2 | 460 | 48% | 14% | `cl_active` 10, `cl_waiting` 0, `maxwait` 0, `sv_active` 0-2 of 10 | 55 ms over 79.5k transactions |
| 2 replicas, no cache | 1.01 | 8.31 | 45.5 | 279 | 36%, 34% | 15% | `cl_active` 20, `cl_waiting` 0, `maxwait` 0, `sv_active` 0-5 of 20 | 216 ms over 79.7k transactions |

PgBouncer never queued a client in these runs and used 14-15% of one core at 4000 queries/s. These nocache numbers are better than the nocache 4000 row in the Results section (p95 37.6 ms, 10 pool connections saturated). That does not show PgBouncer is faster: that run was a different session, one run each, and its Postgres pool was the app's own pool of 10 with no pooler. The new rows show only that the pooler was not the limit at this rate.

### What these numbers do and do not show

- Everything shares 4 cores: k6 (over one core at 4000 req/s), nginx, PgBouncer, Redis, Postgres and the replicas. Adding replicas moves the same work onto more processes, so these runs cannot demonstrate throughput scaling. Dropped iterations do not fall steadily with the replica count, and k6 itself was the busiest process, so treat them as load-generator-limited.
- Per-replica CPU falls as replicas are added (61% with 1, 39% with 2, 23% with 4 at 4000 req/s) while the sum rises (61, 78, 93). Part of that is the cost of more processes and context switches on a saturated box. It is consistent with the work being spread evenly, which `scaleout.sh` check (a) also confirms with counts. It also shows the cost of running more replicas than there are free cores.
- nginx plus PgBouncer overhead: at 2000 req/s the median goes from 0.47 ms (direct) to 0.64-0.68 ms and p95 from 1.44 to 2.2-3.7 ms, which is the extra proxy hop. nginx workers used about 20-34% of one core in total. At 4000 req/s the table does not separate the setups from noise: direct p99 was 49.0 ms against 116, 51.4 and 73.8 ms with nginx + PgBouncer (1, 2 and 4 replicas). Each is a single run and k6 was saturated, so no conclusion about proxy overhead at that rate can be drawn.
- Not measured: a capacity number for the stack, behaviour with the generator on another machine, replicas on separate hosts, a remote or loaded Postgres, longer runs, or Docker networking.

### Scale-out correctness checks

`REPLICAS=3 loadtest/scaleout.sh` starts 3 replicas, PgBouncer and nginx and prints PASS or FAIL for each check. Results of the last run:

```
PASS  (a) requests spread across all replicas: 90 requests, r1=31 r2=31 r3=28
PASS  (b) rate limit is global (limit 20, 3 replicas): 60 creates via nginx: 20 201, 40 429
PASS  (d) spoofed X-Forwarded-For does not change the bucket: via nginx: 429 429 429 ; control direct to replica (no nginx): 201
PASS  (e) /metrics, /readyz blocked via nginx for outside clients: 404 404 404 404 200 (/metrics /readyz //metrics /%6detrics /healthz); private client /metrics: 200; direct replica /metrics /readyz: 200 200
PASS  (c) click counts exact across replicas: 300 redirects, clickCount=300
PASS  (f) SIGTERM one replica mid-run: GET redirects via nginx (PASS = at most 5/10000 failed): 0 failed of 3601 requests (floor 3240, victim served 396 before the kill)
PASS  (f) SIGKILL one replica mid-run: GET redirects via nginx (PASS = at most 1% failed): 0 failed of 3601 requests (floor 3240, victim served 398 before the kill)
PASS  (g) SIGTERM flushes pending clicks: 200 redirects: pending in Redis=200, clickCount before=0, after SIGTERM=200, left in Redis=''
```

After `http_503` was added to `proxy_next_upstream` the SIGTERM check was repeated five times (`ONLY=f REPLICAS=2`, 300 req/s, 12 s): 0 failed of 3601, 3601, 3601, 3601 and 3600, so 0 failed in 5 of 5 runs. A run at `KILL_RATE=2000` gave 0 failed of 24000 (SIGTERM) and 0 failed of 24002 (SIGKILL). The full script also completed with all checks passing in 3 of 3 runs at `REPLICAS=2` and 1 of 1 at `REPLICAS=3`. The kill checks fail unless at least 90% of rate x duration was sent and the killed replica had served traffic before the kill, so "0 failed of 0" cannot pass. The SIGTERM budget is 5 failures per 10,000 requests (`TERM_BUDGET_PER_10K`), so one failure in a run of about 3600 passes; none was seen. The kill test is GET-only: a `POST` in flight on a killed replica is not retried by nginx and was not measured. The client in these checks is on loopback, so the "outside client" check runs a second nginx on port 8081 with the loopback entries removed from the private-range list.

PgBouncer and the test suite: `npx vitest run` with `TEST_DATABASE_URL` pointed at PgBouncer (transaction mode). Of 357 tests, 355 to 357 passed across three runs; only the two lock tests in `test/db/migrate.test.ts` failed, intermittently (run 1: both failed, with an advisory lock left held; run 2: none; run 3: one failed, one lock left held). Everything else, including the click flush `UNNEST` statement, `/readyz` and the shutdown tests, passed through the pooler. That is the reason migrations use `MIGRATE_DATABASE_URL`. Those tests exercise the lock itself, so they are meant to run on a direct connection.

## Findings and next steps

1. Cache vs no cache: up to 2000 req/s the differences are within noise. At 4000 req/s the cache run was faster (p95 8.1 ms, p99 46.0 ms vs 37.6 ms and 68.4 ms without), but both runs dropped iterations (555 and 875) because k6 was saturated and each scenario ran once, so treat it as indicative. The clearer signal is Postgres pool saturation without the cache at 6000 req/s (finding 4). Postgres is local, the dataset fits in memory and the lookup is a unique-index read; the cache should pay off more when Postgres is remote, busier or larger, which this setup cannot show. Re-run against separate hosts with repeats before drawing firm conclusions.
2. The cache path costs Node CPU too: per hit there is a Redis read plus a click counter write (`HINCRBY`). It is not a bug, but if the single event loop is the limit, running several instances (the design's scaling path) matters more than the cache.
3. The design target of about 5k redirects/s and 100 creates/s is met on this box in the steady cache runs up to 6000 req/s, which passed its thresholds but delivered about 97% of the arrival rate (iterations were dropped from 4000 req/s), and the mixed run covers the creates target. Because k6 is a bottleneck above 4000, confirm with a generator on another machine.
4. The default pool of 10 connections is the first limit without the cache: 15 waiting requests were seen at 6000 req/s. If the cache is down in production, redirects fall back to Postgres and this is what will queue. Consider an alert on `pg_pool_connections{state="waiting"} > 0`.
5. Unknown codes in `redirect.js` are random each time, so they always count as `miss` and never `negative`; the hit ratio therefore tops out near 98%. Real scanners that repeat codes would hit the negative cache.
6. Cold start is visible: at 1000 req/s the first 20 s had 25% misses. Run with `WARM=1` for a steady-state view.
7. Not done: longer soak runs, a larger dataset, a Postgres-slower scenario, a generator on a separate host. Multiple instances behind nginx are covered in Scaling out above, with the caveats there.
