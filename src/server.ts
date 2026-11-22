import type { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createClickCounter } from './clicks.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createMetrics } from './metrics.js';
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
const metrics = createMetrics({ db, redis });
const clicks = createClickCounter({ redis, db, metrics });
if (redis && config.clickFlushIntervalSeconds > 0) {
  clicks.start(config.clickFlushIntervalSeconds * 1000);
}
const app = buildApp(config, { db, redis, clicks, metrics });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // A dead database must not stall shutdown past the container kill grace.
    setTimeout(() => process.exit(1), 8000).unref();
    app
      .close()
      .then(() => clicks.stop())
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
