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
  metricsEnabled: boolean;
  metricsToken: string | undefined;
  cronSecret: string | undefined;
}

// Whole-number env value within [min, max]; anything else (unset, empty, junk) gives the fallback.
export function intFromEnv(
  value: string | undefined,
  { min, max, fallback }: { min: number; max: number; fallback: number },
) {
  const n = Number(value);
  if (!/^\d+$/.test(value ?? '') || n < min || n > max) {
    return fallback;
  }
  return n;
}

// Migrations hold a session-level advisory lock, so prefer a direct (non-pooled) connection.
export function migrateDatabaseUrl(env: NodeJS.ProcessEnv) {
  return (
    env.MIGRATE_DATABASE_URL ||
    env.DATABASE_URL_UNPOOLED ||
    env.DATABASE_URL ||
    undefined
  );
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${env[name]}`);
  }
  return value;
}

function parseEnabled(value: string | undefined, name: string) {
  const v = (value ?? '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(v)) {
    return false;
  }
  if (v === '' || ['true', '1', 'on', 'yes'].includes(v)) {
    return true;
  }
  throw new Error(`Invalid ${name}: ${value}`);
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

  let baseUrl = env.BASE_URL;
  if (!baseUrl && env.VERCEL_PROJECT_PRODUCTION_URL) {
    baseUrl = env.VERCEL_PROJECT_PRODUCTION_URL;
    // Vercel provides the bare domain without a scheme.
    if (!/^https?:\/\//.test(baseUrl)) {
      baseUrl = `https://${baseUrl}`;
    }
  }
  baseUrl = baseUrl || 'http://localhost:3000';
  if (!URL.canParse(baseUrl)) {
    throw new Error(`Invalid BASE_URL: ${baseUrl}`);
  }

  const clickFlushIntervalSeconds = Number(
    env.CLICK_FLUSH_INTERVAL_SECONDS || 5,
  );
  if (
    !Number.isInteger(clickFlushIntervalSeconds) ||
    clickFlushIntervalSeconds < 0 ||
    clickFlushIntervalSeconds > 86400
  ) {
    throw new Error(
      `Invalid CLICK_FLUSH_INTERVAL_SECONDS: ${env.CLICK_FLUSH_INTERVAL_SECONDS} (expected 0 to 86400)`,
    );
  }

  const metricsToken = env.METRICS_TOKEN || undefined;
  if (metricsToken !== undefined && metricsToken.length < 16) {
    throw new Error('Invalid METRICS_TOKEN: must be at least 16 characters');
  }

  const cronSecret = env.CRON_SECRET || undefined;
  if (cronSecret !== undefined && cronSecret.length < 16) {
    throw new Error('Invalid CRON_SECRET: must be at least 16 characters');
  }

  // Vercel overwrites X-Forwarded-For, so trusting it is safe there unless TRUST_PROXY says otherwise.
  let trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (env.VERCEL === '1' && (env.TRUST_PROXY ?? '').trim() === '') {
    trustProxy = true;
  }

  return {
    port,
    host: env.HOST || '0.0.0.0',
    logLevel,
    baseUrl,
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || env.KV_URL || undefined,
    rateLimit: {
      enabled: parseEnabled(env.RATE_LIMIT_ENABLED, 'RATE_LIMIT_ENABLED'),
      windowSeconds: positiveInt(env, 'RATE_LIMIT_WINDOW_SECONDS', 60),
      createMax: positiveInt(env, 'RATE_LIMIT_CREATE_MAX', 20),
      redirectMax: positiveInt(env, 'RATE_LIMIT_REDIRECT_MAX', 600),
      readMax: positiveInt(env, 'RATE_LIMIT_READ_MAX', 120),
    },
    trustProxy,
    clickFlushIntervalSeconds,
    metricsEnabled: parseEnabled(env.METRICS_ENABLED, 'METRICS_ENABLED'),
    metricsToken,
    cronSecret,
  };
}
