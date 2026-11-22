import { resolveMigrationUrl } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

// Migrations hold a session-level advisory lock, so they need a direct (non-pooled) connection.
const resolved = resolveMigrationUrl(process.env);
if ('error' in resolved) {
  console.error(resolved.error);
  process.exit(1);
}
const databaseUrl = resolved.url;

const pool = createPool(databaseUrl);
try {
  const applied = await migrate(pool);
  if (applied.length === 0) {
    console.log('No migrations to apply');
  } else {
    console.log(`Applied: ${applied.join(', ')}`);
  }
} catch (err) {
  // Message only: error objects can embed the connection string.
  console.error(`Migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
