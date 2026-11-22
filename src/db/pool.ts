import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Server-side cap so a slow query can't pin a connection.
    statement_timeout: 5_000,
  });
  // An idle client error (e.g. server restart) would otherwise crash the process.
  pool.on('error', (err) => {
    console.error('pg pool idle client error', err);
  });
  return pool;
}
