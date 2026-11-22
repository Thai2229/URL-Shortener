import { migrateDatabaseUrl } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

// Migrations hold a session-level advisory lock, so they need a direct (non-pooled) connection.
const databaseUrl = migrateDatabaseUrl(process.env);
if (!databaseUrl) {
  console.error(
    'MIGRATE_DATABASE_URL, DATABASE_URL_UNPOOLED or DATABASE_URL must be set',
  );
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  const applied = await migrate(pool);
  if (applied.length === 0) {
    console.log('No migrations to apply');
  } else {
    console.log(`Applied: ${applied.join(', ')}`);
  }
} catch (err) {
  console.error('Migration failed', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
