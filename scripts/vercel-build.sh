set -eu

# Fail fast, before building: production migrations need a direct (non-pooled) URL.
# Keep in sync with isPooledDatabaseUrl/resolveMigrationUrl in src/config.ts.
if [ "${VERCEL_ENV:-}" = "production" ] && [ -z "${MIGRATE_DATABASE_URL:-}" ]; then
  url="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"
  host="${url#*://}"
  host="${host%%/*}"
  host="${host##*@}"
  case "$host" in
    *-pooler*)
      echo "Error: the database URL is a pooled connection; migrations need a direct one. Set MIGRATE_DATABASE_URL or DATABASE_URL_UNPOOLED to the direct (non-pooled) URL." >&2
      exit 1
      ;;
  esac
fi

npm run build

# Only production deploys migrate; previews would otherwise change the production database.
if [ "${VERCEL_ENV:-}" = "production" ] && [ -n "${MIGRATE_DATABASE_URL:-}${DATABASE_URL_UNPOOLED:-}${DATABASE_URL:-}" ]; then
  node dist/scripts/migrate.js
else
  echo "Skipping migrations: they run only when VERCEL_ENV=production and MIGRATE_DATABASE_URL, DATABASE_URL_UNPOOLED or DATABASE_URL is set (VERCEL_ENV=${VERCEL_ENV:-unset})."
fi
