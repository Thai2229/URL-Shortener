import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
const db = createPool(config.databaseUrl);
const app = buildApp(config, { db });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    app
      .close()
      .then(() => db.end())
      .then(
        () => process.exit(0),
        (err) => {
          app.log.error(err);
          process.exit(1);
        },
      );
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
