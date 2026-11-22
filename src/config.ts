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
  rateLimit: {
    enabled: boolean;
    windowSeconds: number;
    createMax: number;
    redirectMax: number;
    readMax: number;
  };
  trustProxy: boolean | number | string[];
  clickFlushIntervalSeconds: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${env[name]}`);
  }
  return value;
}

function parseEnabled(value: string | undefined) {
  const v = (value ?? '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(v)) {
    return false;
  }
  if (v === '' || ['true', '1', 'on', 'yes'].includes(v)) {
    return true;
  }
  throw new Error(`Invalid RATE_LIMIT_ENABLED: ${value}`);
}

function parseTrustProxy(value: string | undefined) {
  const v = (value ?? '').trim();
  if (v === '' || v === 'false') {
    return false;
  }
  if (v === 'true') {
    return true;
  }
  if (/^\d+$/.test(v)) {
    return Number(v);
  }
  const list = v
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (list.length === 0) {
    throw new Error(`Invalid TRUST_PROXY: ${value}`);
  }
  return list;
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

  const clickFlushIntervalSeconds = Number(
    env.CLICK_FLUSH_INTERVAL_SECONDS || 5,
  );
  if (
    !Number.isInteger(clickFlushIntervalSeconds) ||
    clickFlushIntervalSeconds < 0
  ) {
    throw new Error(
      `Invalid CLICK_FLUSH_INTERVAL_SECONDS: ${env.CLICK_FLUSH_INTERVAL_SECONDS}`,
    );
  }

  return {
    port,
    host: env.HOST || '0.0.0.0',
    logLevel,
    baseUrl,
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || undefined,
    rateLimit: {
      enabled: parseEnabled(env.RATE_LIMIT_ENABLED),
      windowSeconds: positiveInt(env, 'RATE_LIMIT_WINDOW_SECONDS', 60),
      createMax: positiveInt(env, 'RATE_LIMIT_CREATE_MAX', 20),
      redirectMax: positiveInt(env, 'RATE_LIMIT_REDIRECT_MAX', 600),
      readMax: positiveInt(env, 'RATE_LIMIT_READ_MAX', 120),
    },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    clickFlushIntervalSeconds,
  };
}
