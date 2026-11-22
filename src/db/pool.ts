import pg from 'pg';
import { intFromEnv } from '../config.js';

export function createPool(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: intFromEnv(env.PG_POOL_IDLE_MS, {
      min: 1000,
      max: 600_000,
      fallback: 30_000,
    }),
    // Server-side cap so a slow query can't pin a connection.
    statement_timeout: 5_000,
  });
  // An idle client error (e.g. server restart) would otherwise crash the process.
  pool.on('error', (err) => {
    console.error('pg pool idle client error', err);
  });
  return pool;
}
