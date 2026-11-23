# URL Shortener

A URL shortener built to scale horizontally: Fastify API, PostgreSQL as the source of truth, Redis for caching. It has an API to create, follow and inspect links, `/healthz` and `/readyz`, Redis caching, click counting, rate limiting and Prometheus metrics. See [docs/PLAN.md](docs/PLAN.md) for the architecture and build steps.

Live demo: https://veryshrt.vercel.app

![Pasting a URL into the deployed app, clicking Shorten and copying the short link](docs/assets/demo.gif)

The clip shows the landing page served at `/`, which creates links through `POST /api/links`.

## Built with

| Area                 | Tools                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| Language and runtime | TypeScript on Node.js 22                                              |
| Web framework        | Fastify 5                                                             |
| Database             | PostgreSQL through node-postgres, with plain SQL migrations           |
| Cache and counters   | Redis through ioredis                                                 |
| Rate limiting        | `@fastify/rate-limit` with a custom Redis store                       |
| Metrics              | `prom-client`, in Prometheus format                                   |
| Front end            | Plain HTML, CSS and JavaScript, with no framework or build step       |
| Testing              | Vitest for unit and integration tests, k6 for load tests              |
| Code quality         | ESLint and Prettier                                                   |
| Containers and edge  | Docker Compose, nginx and PgBouncer                                   |
| Hosting              | Vercel for the function and CDN, Neon for Postgres, Upstash for Redis |
| CI                   | GitHub Actions and Dependabot                                         |

## System design

A URL shortener serves far more redirects than it creates links, so a redirect does as little as it can: it checks Redis, falls back to Postgres on a cache miss, and returns. The same Fastify app runs in two deployments. The live demo runs on Vercel, with Neon for Postgres and Upstash for Redis. The Docker Compose deployment adds nginx and PgBouncer and can run several API replicas.

```mermaid
flowchart LR
    client([Browser or API client])

    subgraph vercel["Vercel deployment (the live demo)"]
        cdn["CDN<br/>landing page files"]
        fn["Serverless function<br/>Fastify app"]
    end

    subgraph docker["Docker Compose deployment"]
        nginx["nginx<br/>edge proxy"]
        api["API replicas<br/>Fastify app, 1 to N"]
        pgb["PgBouncer<br/>connection pooling"]
    end

    redis[("Redis<br/>link cache, rate-limit counters,<br/>pending click counts")]
    pg[("PostgreSQL<br/>links table")]

    client --> cdn
    client --> fn
    client --> nginx
    nginx --> api
    fn --> redis
    fn --> pg
    api --> redis
    api --> pgb
    pgb --> pg
```

A short link redirects like this. A cache hit never touches Postgres; a miss reads one row by its unique code and then fills the cache. Every GET redirect also adds one to a pending click count in Redis.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as Fastify app
    participant R as Redis
    participant P as PostgreSQL

    C->>A: GET /aB3dE9x
    A->>R: count this request for the client IP
    A->>R: GET link:aB3dE9x
    alt cache hit
        R-->>A: target URL
    else cache miss
        A->>P: SELECT by code (unique index)
        P-->>A: link row
        A->>R: SET link:aB3dE9x (about 24 hours)
    end
    A->>R: add 1 to the pending click count
    A-->>C: 302 redirect to the target URL
```

A new link gets a random 7-character code, so replicas have no counter to coordinate. If the insert finds the code already taken, the app picks another.

```mermaid
flowchart TD
    start["POST /api/links"] --> limit{"Under the rate limit?<br/>20 per minute per IP"}
    limit -- no --> e429["429 with Retry-After"]
    limit -- yes --> valid{"Valid URL and expiry?<br/>http or https, public address,<br/>not this site, 2048 characters max"}
    valid -- no --> e400["400 invalid_url or invalid_expiry"]
    valid -- yes --> code["Generate a random<br/>7-character code"]
    code --> insert["INSERT into PostgreSQL<br/>ON CONFLICT DO NOTHING"]
    insert -- "code already taken<br/>(up to 5 attempts in total)" --> code
    insert -- inserted --> cache["Write the link to the Redis cache"]
    cache --> ok["201 with the short URL"]
```

Clicks collect in Redis and a flusher moves them to Postgres in batches, which keeps a database write off the redirect path. A Redis lock stops two replicas flushing at once.

```mermaid
flowchart LR
    redirect["Each GET redirect"] -->|"add 1"| hash[("Redis hash<br/>pending clicks per code")]
    hash -->|"every few seconds, or after a<br/>redirect on Vercel"| flusher["Flusher<br/>holds a Redis lock"]
    flusher -->|"one batched UPDATE"| pg[("PostgreSQL<br/>links.click_count")]
```
