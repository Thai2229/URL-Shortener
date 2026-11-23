#!/usr/bin/env bash
# Usage: PROFILE=cache|nocache|ratelimit [RATE=2000 DURATION=30s LABEL=x WARM=1] loadtest/run.sh [script...]
# With no PROFILE, runs the suite: cache (smoke redirect mixed spike) then ratelimit (ratelimit).
# Each script gets a fresh server process so /metrics counters cover that run only.
set -euo pipefail

cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL is not set}"
K6="${K6:-k6}"
PORT="${PORT:-3000}"
REDIS="${REDIS_URL:-redis://localhost:6379}"
export BASE_URL="http://localhost:${PORT}"
mkdir -p loadtest/results

# Refuse non-local DATABASE_URL/REDIS_URL before anything is migrated, seeded or deleted.
npx tsx loadtest/guard.ts

SERVER_PID=""
stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}
trap stop_server EXIT

if [ ! -f dist/server.js ] || [ -n "$(find src migrations package.json -newer dist/server.js -type f | head -1)" ]; then
  npm run build
fi
npx tsx src/scripts/migrate.ts
npx tsx loadtest/seed.ts

# Delete only our own key families; never FLUSHALL.
clear_redis() {
  for pattern in "$@"; do
    redis-cli -u "$REDIS" --scan --pattern "$pattern" | xargs -r -n 500 redis-cli -u "$REDIS" DEL >/dev/null
  done
}

start_server() {
  local profile="$1" log="$2"
  local -a env=(PORT="$PORT" LOG_LEVEL=warn RATE_LIMIT_ENABLED=false)
  case "$profile" in
    cache) env+=(REDIS_URL="$REDIS") ;;
    nocache) ;;
    ratelimit) env+=(REDIS_URL="$REDIS" RATE_LIMIT_ENABLED=true) ;;
    *) echo "Unknown PROFILE: $profile" >&2; exit 2 ;;
  esac
  # Unset REDIS_URL unless the profile sets it again below.
  env -u REDIS_URL "${env[@]}" node dist/server.js >"$log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    if curl -fs "$BASE_URL/readyz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Server did not become ready; see $log" >&2
  exit 1
}

fail=0
run_one() {
  local profile="$1" script="$2"
  local label="${LABEL:-${profile}-${script}-${RATE:-default}}"
  local start="cold"
  if [ "$profile" != nocache ]; then
    clear_redis 'rl:*' 'clicks*'
    if [ "${WARM:-0}" = 1 ]; then
      start="warm"
    else
      clear_redis 'link:*'
    fi
  fi
  echo "### ${script} profile=${profile} label=${label} start=${start}"
  start_server "$profile" "loadtest/results/server-${script}-${label}.log"
  local rc=0
  LABEL="$label" "$K6" run --quiet "loadtest/${script}.js" || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail=1
  fi
  sleep 6 # let the click flusher (5s interval) run once
  {
    echo "# profile=${profile} script=${script} start=${start} k6_exit=${rc}"
    curl -fs "$BASE_URL/metrics" | grep -E '^(redirect_cache_total|http_request_duration_seconds_count|click_flush_total|pg_pool_connections|rate_limit_rejected_total|process_cpu_(user|system)_seconds_total|process_resident_memory_bytes|nodejs_heap_size_used_bytes)' || true
  } >"loadtest/results/metrics-${script}-${label}.txt"
  stop_server
}

run_profile() {
  local profile="$1"
  shift
  for script in "$@"; do
    run_one "$profile" "$script"
  done
}

if [ -n "${PROFILE:-}" ]; then
  default="smoke redirect mixed spike"
  if [ "$PROFILE" = ratelimit ]; then
    default="ratelimit"
  fi
  if [ "$#" -gt 0 ]; then
    run_profile "$PROFILE" "$@"
  else
    run_profile "$PROFILE" $default
  fi
else
  run_profile cache smoke redirect mixed spike
  run_profile ratelimit ratelimit
fi
exit "$fail"
