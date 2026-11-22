set -eu

npm run build

# Only production deploys migrate; previews would otherwise change the production database.
if [ "${VERCEL_ENV:-}" = "production" ] && [ -n "${MIGRATE_DATABASE_URL:-}${DATABASE_URL_UNPOOLED:-}${DATABASE_URL:-}" ]; then
  node dist/scripts/migrate.js
else
  echo "Skipping migrations: they run only when VERCEL_ENV=production and MIGRATE_DATABASE_URL, DATABASE_URL_UNPOOLED or DATABASE_URL is set (VERCEL_ENV=${VERCEL_ENV:-unset})."
fi
