import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { testDatabaseUrl } from './helpers/db.js';

export default async function setup(): Promise<void> {
  const pool = createPool(testDatabaseUrl());
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
