#!/usr/bin/env bash
# Local, no-Docker scale-out stack: REPLICAS app processes (ports 3001+), PgBouncer (6432) and nginx (8080)
# with deploy/nginx.conf and deploy/pgbouncer.ini rewritten into a temp dir.
# Usage: DATABASE_URL=postgres://... loadtest/scaleout.sh            # correctness checks, PASS/FAIL each
#        MODE=bench RATE=2000 DURATION=20s REPLICAS=2 loadtest/scaleout.sh   # k6 redirect through nginx
# Bench: NOCACHE=1 drops REDIS_URL so every redirect goes through PgBouncer to Postgres.
# Needs nginx, pgbouncer, k6, redis-cli, psql, curl, jq. Same local-only guard as run.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL is not set}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
REPLICAS="${REPLICAS:-3}"
MODE="${MODE:-check}"
BASE_PORT=3001
NGINX_PORT=8080
PGB_PORT=6432
K6="${K6:-k6}"
EDGE="http://localhost:${NGINX_PORT}"

# Refuse non-local DATABASE_URL/REDIS_URL before anything is migrated or deleted.
npx tsx loadtest/guard.ts

for p in "$NGINX_PORT" "$((NGINX_PORT + 1))" "$PGB_PORT" $(seq "$BASE_PORT" "$((BASE_PORT + REPLICAS - 1))"); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "Port $p is already in use" >&2
    exit 2
  fi
done

T="$(mktemp -d)"
chmod 777 "$T" # nginx and PgBouncer drop privileges when started as root
declare -A PID
EDGE_PIDS=()
PGB_PID=""
cleanup() {
  for i in "${!PID[@]}"; do kill "${PID[$i]}" 2>/dev/null || true; done
  for p in "${EDGE_PIDS[@]}" $PGB_PID; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ -n "$T" ]; then rm -rf -- "$T"; fi
}
trap cleanup EXIT

# Parse DATABASE_URL once: direct host/port, credentials, and the same URL through PgBouncer.
DB_JSON="$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  const pgb = new URL(u);
  pgb.hostname = "127.0.0.1";
  pgb.port = process.argv[1];
  console.log(JSON.stringify({ host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || "5432",
    user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password), pgb: pgb.toString() }));
' "$PGB_PORT")"
DB_HOST="$(jq -r .host <<<"$DB_JSON")"
DB_PORT="$(jq -r .port <<<"$DB_JSON")"
DB_USER="$(jq -r .user <<<"$DB_JSON")"
DB_PASS="$(jq -r .pass <<<"$DB_JSON")"
PGB_URL="$(jq -r .pgb <<<"$DB_JSON")"

if [ "$(id -u)" = 0 ]; then PGB_RUN_AS=(-u "${PGB_USER:-nobody}"); else PGB_RUN_AS=(); fi
printf '"%s" "%s"\n' "$DB_USER" "$DB_PASS" >"$T/userlist.txt"
sed -e "s#host=postgres port=5432#host=${DB_HOST} port=${DB_PORT}#" \
  -e 's#^listen_addr = .*#listen_addr = 127.0.0.1#' \
  -e "s#^listen_port = .*#listen_port = ${PGB_PORT}#" \
  -e "s#^auth_file = .*#auth_file = $T/userlist.txt#" \
  -e "s#^admin_users = .*#admin_users = ${DB_USER}#" \
  -e "s#^stats_users = .*#stats_users = ${DB_USER}#" \
  deploy/pgbouncer.ini >"$T/pgbouncer.ini"
printf 'unix_socket_dir = %s\npidfile = %s/pgb.pid\n' "$T" "$T" >>"$T/pgbouncer.ini"
chmod 644 "$T"/userlist.txt "$T"/pgbouncer.ini

ADMIN_URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${PGB_PORT}/pgbouncer"

if [ ! -f dist/server.js ] || [ -n "$(find src migrations package.json -newer dist/server.js -type f | head -1)" ]; then
  npm run build
fi
# Migrations take a session advisory lock: direct to Postgres, never through PgBouncer.
MIGRATE_DATABASE_URL="$DATABASE_URL" npx tsx src/scripts/migrate.ts

clear_redis() {
  for pattern in "$@"; do
    redis-cli -u "$REDIS_URL" --scan --pattern "$pattern" | xargs -r -n 500 redis-cli -u "$REDIS_URL" DEL >/dev/null
  done
}
clear_redis 'rl:*' 'clicks*' 'link:*'

pgbouncer "${PGB_RUN_AS[@]}" "$T/pgbouncer.ini" >"$T/pgbouncer.out" 2>&1 &
PGB_PID=$!
for _ in $(seq 1 20); do
  if psql "$ADMIN_URL" -qAtc 'SHOW VERSION' >/dev/null 2>&1; then break; fi
  sleep 0.25
done
psql "$ADMIN_URL" -qAtc 'SHOW VERSION' >/dev/null || { echo "PgBouncer did not start; see $T/pgbouncer.out" >&2; exit 1; }

# start_edge NAME PORT [public]: nginx with the replica list filled in. "public" removes the
# loopback entries from the private-range list so this client is treated as an outside one.
start_edge() {
  local name="$1" port="$2" public="${3:-}" servers="" i
  for i in $(seq 1 "$REPLICAS"); do servers+="    server 127.0.0.1:$((BASE_PORT + i - 1));"$'\n'; done
  SERVERS="$servers" awk -v port="$port" -v t="$T" -v name="$name" -v public="$public" '
    /server api:3000;/ { printf "%s", ENVIRON["SERVERS"]; next }
    public != "" && (/127\.0\.0\.0\/8/ || /::1 /) { next }
    /^ *listen 80;/ { sub(/80/, port) }
    /^pid / { $0 = "pid " t "/" name ".pid;" }
    /access_log/ { $0 = "  access_log " t "/" name ".access.log combined buffer=32k flush=1s;" }
    { print }' deploy/nginx.conf >"$T/$name.conf"
  nginx -p "$T" -c "$T/$name.conf" -g 'daemon off;' 2>"$T/$name.err" &
  EDGE_PIDS+=("$!")
  for _ in $(seq 1 40); do
    if curl -fs "http://localhost:$port/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "nginx $name did not start; see $T/$name.err" >&2
  exit 1
}

# start_replica I: app on BASE_PORT+I-1 behind PgBouncer. Env overrides come from $APP_ENV.
start_replica() {
  local i="$1" port=$((BASE_PORT + $1 - 1)) cache=("REDIS_URL=$REDIS_URL")
  if [ -n "${NOCACHE:-}" ]; then cache=(); fi
  # shellcheck disable=SC2086
  env -u REDIS_URL PORT="$port" BASE_URL="$EDGE" LOG_LEVEL=warn DATABASE_URL="$PGB_URL" \
    MIGRATE_DATABASE_URL="$DATABASE_URL" TRUST_PROXY=1 "${cache[@]}" $APP_ENV \
    node dist/server.js >"$T/app$i.log" 2>&1 &
  PID[$i]=$!
  for _ in $(seq 1 60); do
    if curl -fs "http://localhost:$port/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "Replica $i did not become ready; see $T/app$i.log" >&2
  exit 1
}

# stop_replica I SIGNAL: signal, then wait until the process is gone.
stop_replica() {
  kill "-$2" "${PID[$1]}" 2>/dev/null || true
  wait "${PID[$1]}" 2>/dev/null || true
}

if [ "$MODE" = bench ]; then
  # Rate limiting off, like run.sh's cache profile.
  APP_ENV="RATE_LIMIT_ENABLED=false"
  npx tsx loadtest/seed.ts
  for i in $(seq 1 "$REPLICAS"); do start_replica "$i"; done
  start_edge edge "$NGINX_PORT"
  RATE="${RATE:-2000}"
  DURATION="${DURATION:-20s}"
  echo "### bench replicas=$REPLICAS rate=$RATE duration=$DURATION nocache=${NOCACHE:-0}"
  mkdir -p loadtest/results
  BASE_URL="$EDGE" RATE="$RATE" DURATION="$DURATION" LABEL="scaleout-r${REPLICAS}-${RATE}" "$K6" run --quiet loadtest/redirect.js &
  K6_PID=$!
  sleep "${SAMPLE_AT:-8}"
  : >"$T/pools.txt"
  for _ in 1 2 3 4; do
    psql "$ADMIN_URL" -qAtc 'SHOW POOLS' | grep -v '^pgbouncer|' >>"$T/pools.txt" || true
    sleep 1
  done
  # Per-process CPU over one 3 s interval while the load is still running.
  top -b -n 2 -d 3 -w 200 | awk '/^top -/ {n++} n == 2' | grep -E 'node|nginx|pgbouncer|k6|redis|postgres' | head -14 | sed 's/^/top: /'
  wait "$K6_PID" || true
  echo "SHOW POOLS samples (database|user|cl_active|cl_waiting|...|maxwait), app database only:"
  cat "$T/pools.txt"
  echo "SHOW STATS:"
  psql "$ADMIN_URL" -qAtc 'SHOW STATS' | grep -v '^pgbouncer|'
  exit 0
fi

# ---- correctness checks ----
fail=0
report() { # report NAME OK DETAIL
  if [ "$2" = 1 ]; then echo "PASS  $1: $3"; else echo "FAIL  $1: $3"; fail=1; fi
}
served() { # redirects this replica has handled (route /:code), from its own /metrics
  curl -fs "http://localhost:$1/metrics" | awk '/^http_request_duration_seconds_count/ && /route="\/:code"/ { s += $NF } END { print s + 0 }'
}
new_code() { # direct to replica 1 with its own X-Forwarded-For so setup never uses the test client's create bucket
  curl -fs -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 10.9.9.9' \
    -d "{\"url\":\"https://example.com/scaleout-$RANDOM$RANDOM\"}" "http://localhost:$BASE_PORT/api/links" | jq -r .code
}
clicks() { curl -fs "$EDGE/api/links/$1" | jq -r .clickCount; }

# Create bucket of 20 is the point of (b); everything else is effectively unlimited.
APP_ENV="RATE_LIMIT_ENABLED=true RATE_LIMIT_CREATE_MAX=20 RATE_LIMIT_REDIRECT_MAX=100000 RATE_LIMIT_READ_MAX=100000 CLICK_FLUSH_INTERVAL_SECONDS=1"
for i in $(seq 1 "$REPLICAS"); do start_replica "$i"; done
start_edge edge "$NGINX_PORT"
start_edge public "$((NGINX_PORT + 1))" public
echo "### $REPLICAS replicas behind nginx :$NGINX_PORT, PgBouncer :$PGB_PORT (tmp $T)"

# (a) spread
A="$(new_code)"
before=()
for i in $(seq 1 "$REPLICAS"); do before[i]="$(served $((BASE_PORT + i - 1)))"; done
for _ in $(seq 1 90); do curl -s -o /dev/null "$EDGE/$A"; done
ok=1 detail=""
for i in $(seq 1 "$REPLICAS"); do
  n=$(($(served $((BASE_PORT + i - 1))) - before[i]))
  detail+="r$i=$n "
  if [ "$n" -lt 1 ]; then ok=0; fi
done
report "(a) requests spread across all replicas" "$ok" "90 requests, $detail"

# (b) global create limit
codes="$(for _ in $(seq 1 60); do curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
  -d "{\"url\":\"https://example.com/scaleout-$RANDOM$RANDOM\"}" "$EDGE/api/links"; done | sort | uniq -c | tr -s ' ' | tr '\n' ',')"
ok=0
if [ "$codes" = " 20 201, 40 429," ]; then ok=1; fi
report "(b) rate limit is global (limit 20, $REPLICAS replicas)" "$ok" "60 creates via nginx:${codes}"

# (d) spoofed X-Forwarded-For through nginx must not open a new bucket; direct to a replica it does (control)
spoof="$(for v in '1.2.3.4' '1.2.3.4, 5.6.7.8' '10.0.0.1'; do
  curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'content-type: application/json' -H "X-Forwarded-For: $v" \
    -d '{"url":"https://example.com/scaleout-spoof"}' "$EDGE/api/links"; done)"
control="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 1.2.3.4' \
  -d '{"url":"https://example.com/scaleout-spoof"}' "http://localhost:$BASE_PORT/api/links")"
ok=0
if [ "$spoof" = "429 429 429 " ] && [ "$control" = 201 ]; then ok=1; fi
report "(d) spoofed X-Forwarded-For does not change the bucket" "$ok" "via nginx: ${spoof}; control direct to replica (no nginx): $control"

# (e) /metrics and /readyz blocked for outside clients; reachable on a replica; loopback is "private" so :8080 allows them
pub="$(for path in /metrics /readyz //metrics /%6detrics /healthz; do curl -s -o /dev/null -w '%{http_code} ' "http://localhost:$((NGINX_PORT + 1))$path"; done)"
priv="$(curl -s -o /dev/null -w '%{http_code}' "$EDGE/metrics")"
direct="$(curl -s -o /dev/null -w '%{http_code} ' -o /dev/null "http://localhost:$BASE_PORT/metrics" "http://localhost:$BASE_PORT/readyz")"
ok=0
if [ "$pub" = "404 404 404 404 200 " ] && [ "$priv" = 200 ] && [ "$direct" = "200 200 " ]; then ok=1; fi
report "(e) /metrics, /readyz blocked via nginx for outside clients" "$ok" "outside client (/metrics /readyz //metrics /%6detrics /healthz): ${pub}; private client /metrics: $priv; direct replica /metrics /readyz: ${direct}"

# (c) exact click counts across replicas
N=300
C="$(new_code)"
for _ in $(seq 1 "$N"); do curl -s -o /dev/null "$EDGE/$C"; done
for _ in $(seq 1 30); do
  if [ "$(clicks "$C")" = "$N" ]; then break; fi
  sleep 1
done
sleep 4 # all flushers settle (interval 1 s); a double count or late batch would show now
got="$(clicks "$C")"
ok=0
if [ "$got" = "$N" ]; then ok=1; fi
report "(c) click counts exact across replicas" "$ok" "$N redirects, clickCount=$got"

# (f) kill a replica under steady load; nginx must retry GETs on the others
kill_run() { # kill_run SIGNAL
  local sig="$1" k="$2" link out rate="${KILL_RATE:-300}"
  link="$(new_code)"
  TARGET_URL="$EDGE/$link" RATE="$rate" DURATION=12s "$K6" run --quiet --summary-export "$T/kill-$sig.json" loadtest/scaleout-kill.js >/dev/null 2>&1 &
  local k6pid=$!
  sleep 4
  stop_replica "$k" "$sig"
  wait "$k6pid" || true
  total="$(jq -r .metrics.http_reqs.count "$T/kill-$sig.json")"
  failed="$(jq -r '.metrics.checks.fails' "$T/kill-$sig.json")"
  start_replica "$k"
  sleep 12 # nginx fail_timeout (10 s) so the replica is retried before the next run
}
kill_run TERM 2
ok=0
if [ "$failed" = 0 ]; then ok=1; fi
report "(f) SIGTERM one replica mid-run: GET redirects via nginx" "$ok" "$failed failed of $total requests"
kill_run KILL "$REPLICAS"
ok=0
if [ "$failed" -le $((total / 100)) ]; then ok=1; fi
report "(f) SIGKILL one replica mid-run: GET redirects via nginx (PASS = at most 1% failed)" "$ok" "$failed failed of $total requests"

# (g) graceful shutdown flushes pending clicks: flush timer off (interval 1 h), clicks sit in Redis until SIGTERM
for i in $(seq 1 "$REPLICAS"); do stop_replica "$i" TERM; done
APP_ENV="RATE_LIMIT_ENABLED=false CLICK_FLUSH_INTERVAL_SECONDS=3600"
for i in $(seq 1 "$REPLICAS"); do start_replica "$i"; done
G="$(new_code)"
N=200
for _ in $(seq 1 "$N"); do curl -s -o /dev/null "$EDGE/$G"; done
pending="$(redis-cli -u "$REDIS_URL" HGET clicks "$G")"
db_before="$(clicks "$G")"
stop_replica 1 TERM
db_after="$(clicks "$G")"
left="$(redis-cli -u "$REDIS_URL" HGET clicks "$G")"
ok=0
if [ "$pending" = "$N" ] && [ "$db_before" = 0 ] && [ "$db_after" = "$N" ] && [ -z "$left" ]; then ok=1; fi
report "(g) SIGTERM flushes pending clicks" "$ok" "$N redirects: pending in Redis=$pending, clickCount before=$db_before, after SIGTERM=$db_after, left in Redis='${left}'"

psql "$DATABASE_URL" -qc "DELETE FROM links WHERE target_url LIKE 'https://example.com/scaleout-%'" || true
if [ "$fail" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$fail"
