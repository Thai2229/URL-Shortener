import type { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createRedis } from './redis.js';

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
const db = createPool(config.databaseUrl);
let redis: Redis | undefined;
if (config.redisUrl) {
  redis = createRedis(config.redisUrl);
}
const app = buildApp(config, { db, redis });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    app
      .close()
      .then(() => redis?.quit().catch(() => redis?.disconnect()))
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
