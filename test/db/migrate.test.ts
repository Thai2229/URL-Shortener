import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { usePool } from '../helpers/db.js';

describe('migrate', () => {
  const pool = usePool();

  it('applies nothing when run again', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('creates links and schema_migrations tables', async () => {
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [['links', 'schema_migrations']],
    );
    expect(res.rows.map((r) => r.table_name).sort()).toEqual([
      'links',
      'schema_migrations',
    ]);
  });
});

describe('migrate failure and concurrency', () => {
  const pool = usePool();
  const suffix = randomBytes(4).toString('hex');
  const dirs: string[] = [];

  async function tempDir(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(dir, name), sql);
    }
    return dir;
  }

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS mig_conc_${suffix}`);
    await pool.query('DELETE FROM schema_migrations WHERE name LIKE $1', [
      `%${suffix}%`,
    ]);
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  it('rolls back a failing migration and releases the lock', async () => {
    const name = `998_bad_${suffix}.sql`;
    const dir = await tempDir({
      [name]: `CREATE TABLE mig_bad_${suffix} (id int); SELECT 1/0;`,
    });
    await expect(migrate(pool, dir)).rejects.toMatchObject({ code: '22012' });
    const table = await pool.query('SELECT to_regclass($1) AS t', [
      `mig_bad_${suffix}`,
    ]);
    expect(table.rows[0].t).toBeNull();
    const recorded = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [name],
    );
    expect(recorded.rowCount).toBe(0);
    // The advisory lock was released, so another run is not blocked.
    expect(await migrate(pool)).toEqual([]);
  });

  it('applies a migration once when two runs start together', async () => {
    const name = `999_conc_${suffix}.sql`;
    const dir = await tempDir({
      [name]: `CREATE TABLE mig_conc_${suffix} (id int);`,
    });
    const results = await Promise.all([migrate(pool, dir), migrate(pool, dir)]);
    expect(results.flat()).toEqual([name]);
  });
});
