import { writeFile } from 'node:fs/promises';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const count = Number(process.env.SEED_COUNT || 10000);
if (!Number.isInteger(count) || count < 1) {
  console.error(`Invalid SEED_COUNT: ${process.env.SEED_COUNT}`);
  process.exit(1);
}

const pool = createPool(databaseUrl);
try {
  await migrate(pool);
  await pool.query("DELETE FROM links WHERE code LIKE 'lt%'");
  // The subquery references g.n so random() runs per row, not once.
  const { rows } = await pool.query(
    `INSERT INTO links (code, target_url)
     SELECT 'lt' || (
              SELECT string_agg(
                       substr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                              1 + floor(random() * 62)::int, 1), '')
              FROM generate_series(1, 7) WHERE g.n > 0),
            'https://example.com/page/' || g.n
     FROM generate_series(1, $1::int) AS g(n)
     ON CONFLICT (code) DO NOTHING
     RETURNING code`,
    [count],
  );
  const codes = rows.map((r) => r.code as string);
  await writeFile(
    new URL('./codes.json', import.meta.url),
    JSON.stringify(codes),
  );
  console.log(`Seeded ${codes.length} links into loadtest/codes.json`);
} catch (err) {
  console.error('Seed failed', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
