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
  allowPrivateTargets: boolean;
  vercel: boolean;
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

// True when the host part (not user, path or query) is a Neon-style pooled endpoint.
// Keep in sync with the check in scripts/vercel-build.sh.
export function isPooledDatabaseUrl(url: string) {
  if (!URL.canParse(url)) {
    return false;
  }
  return new URL(url).hostname.includes('-pooler');
}

// An explicit MIGRATE_DATABASE_URL is trusted; otherwise a pooled URL is refused (advisory lock).
export function resolveMigrationUrl(
  env: NodeJS.ProcessEnv,
): { url: string } | { error: string } {
  const url = migrateDatabaseUrl(env);
  if (!url) {
    return {
      error:
        'MIGRATE_DATABASE_URL, DATABASE_URL_UNPOOLED or DATABASE_URL must be set',
    };
  }
  if (!env.MIGRATE_DATABASE_URL && isPooledDatabaseUrl(url)) {
    return {
      error:
        'The database URL is a pooled connection; migrations need a direct one. Set MIGRATE_DATABASE_URL or DATABASE_URL_UNPOOLED to the direct (non-pooled) URL.',
    };
  }
  return { url };
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

  const vercel = env.VERCEL === '1';
  let baseUrl = env.BASE_URL;
  if (!baseUrl) {
    // Production uses the stable domain; previews and development use the per-deployment URL.
    if (env.VERCEL_ENV === 'production') {
      baseUrl = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
    } else {
      baseUrl = env.VERCEL_URL || env.VERCEL_PROJECT_PRODUCTION_URL;
    }
    // Vercel provides the bare domain without a scheme.
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
      baseUrl = `https://${baseUrl}`;
    }
  }
  baseUrl = baseUrl || 'http://localhost:3000';
  if (
    !URL.canParse(baseUrl) ||
    (new URL(baseUrl).protocol !== 'http:' &&
      new URL(baseUrl).protocol !== 'https:')
  ) {
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
  if (vercel && env.VERCEL_ENV && (env.TRUST_PROXY ?? '').trim() === '') {
    trustProxy = true;
  }

  // On Vercel the app is public, so metrics are off unless a token is set (explicit METRICS_ENABLED wins).
  let metricsEnabled = parseEnabled(env.METRICS_ENABLED, 'METRICS_ENABLED');
  if (vercel && (env.METRICS_ENABLED ?? '').trim() === '') {
    metricsEnabled = metricsToken !== undefined;
  }

  return {
    port,
    host: env.HOST || '0.0.0.0',
    logLevel,
    baseUrl,
    allowPrivateTargets: parseEnabled(
      env.ALLOW_PRIVATE_TARGETS || 'false',
      'ALLOW_PRIVATE_TARGETS',
    ),
    vercel,
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
    metricsEnabled,
    metricsToken,
    cronSecret,
  };
}
