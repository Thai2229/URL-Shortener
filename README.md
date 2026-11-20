# URL Shortener

A URL shortener built to scale horizontally: Fastify API, PostgreSQL as the source of truth, Redis for caching. Only the scaffold exists so far (a `/healthz` endpoint). See [docs/PLAN.md](docs/PLAN.md) for the architecture and build steps.

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

## Scripts

- `npm run dev`: start with file watching (tsx)
- `npm run build`: compile to `dist/`
- `npm start`: run the compiled server
- `npm test`: run Vitest
- `npm run lint`: ESLint
- `npm run typecheck`: `tsc --noEmit`
- `npm run format`: Prettier

## Configuration

Environment variables are listed in `.env.example`. `PORT`, `HOST`, `LOG_LEVEL` and `BASE_URL` have defaults. `DATABASE_URL` and `REDIS_URL` are optional until later steps use them. Invalid values stop the server at startup.
