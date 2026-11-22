import { describe, expect, it } from 'vitest';
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
