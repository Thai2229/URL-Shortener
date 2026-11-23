import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// ../../migrations works from src/db (tsx/vitest) and dist/db (built).
const DEFAULT_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const LOCK_ID = 727274; // arbitrary app-wide advisory lock key

export async function migrate(
  pool: pg.Pool,
  dir: string = DEFAULT_DIR,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  // Advisory locks are per-session, so hold one dedicated client throughout.
  const client = await pool.connect();
  try {
    // Waiting on the lock and long migrations must not hit the pool's 5s cap.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name as string,
      ),
    );
    for (const name of files) {
      if (done.has(name)) continue;
      const sql = await readFile(`${dir}/${name}`, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          name,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      applied.push(name);
    }
  } finally {
    const unlocked = await client
      .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
      .then(
        () => true,
        () => false,
      );
    // Destroy the client if the unlock failed so no session keeps the lock.
    client.release(!unlocked);
  }
  return applied;
}
