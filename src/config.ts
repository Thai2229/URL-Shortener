const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  baseUrl: string;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL: ${logLevel} (expected one of ${LOG_LEVELS.join(', ')})`,
    );
  }

  const baseUrl = env.BASE_URL || 'http://localhost:3000';
  if (!URL.canParse(baseUrl)) {
    throw new Error(`Invalid BASE_URL: ${baseUrl}`);
  }

  return {
    port,
    host: env.HOST || '0.0.0.0',
    logLevel,
    baseUrl,
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || undefined,
  };
}
