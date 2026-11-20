import Fastify from 'fastify';
import type { Config } from './config.js';
import { healthRoutes } from './routes/health.js';

export function buildApp(config: Config) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test' && { level: config.logLevel },
  });
  app.register(healthRoutes);
  return app;
}
