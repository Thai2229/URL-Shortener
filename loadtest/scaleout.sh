#!/usr/bin/env bash
# Local, no-Docker scale-out stack: REPLICAS app processes (ports 3001+), PgBouncer (6432) and nginx (8080)
# with deploy/nginx.conf and deploy/pgbouncer.ini rewritten into a temp dir.
# Usage: DATABASE_URL=postgres://... loadtest/scaleout.sh            # correctness checks, PASS/FAIL each
#        MODE=bench RATE=2000 DURATION=20s REPLICAS=2 loadtest/scaleout.sh   # k6 redirect through nginx
# Bench: NOCACHE=1 drops REDIS_URL so every redirect goes through PgBouncer to Postgres.
# ONLY=f runs just the kill checks (f). Everything listens on 127.0.0.1 only; temp dir mode 700.
# Needs nginx, pgbouncer, k6, redis-cli, psql, curl, jq. Same local-only guard as run.sh.
set -Eeuo pipefail
umask 077
fail=0 passed=0 failed=0
on_err() { # never end silently: line, command, exit code and the verdict so far
  local rc=$?
  echo "ERROR line $1: $2 (exit $rc)" >&2
  echo "VERDICT: ABORTED, $passed passed, $failed failed before the error" >&2
}
trap 'on_err $LINENO "$BASH_COMMAND"' ERR

cd "$(dirname "$0")/.."
: "${DATABASE_URL:?DATABASE_URL is not set}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
REPLICAS="${REPLICAS:-3}"
MODE="${MODE:-check}"
BASE_PORT=3001
NGINX_PORT=8080
PGB_PORT=6432
K6="${K6:-k6}"
EDGE="http://127.0.0.1:${NGINX_PORT}"

# Refuse non-local DATABASE_URL/REDIS_URL before anything is migrated or deleted.
npx tsx loadtest/guard.ts

for p in "$NGINX_PORT" "$((NGINX_PORT + 1))" "$PGB_PORT" $(seq "$BASE_PORT" "$((BASE_PORT + REPLICAS - 1))"); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "Port $p is already in use" >&2
    exit 2
  fi
done

T="$(mktemp -d)" # mode 700, owned by the invoking user
PT="$T" # PgBouncer's own dir; see below
declare -A PID
EDGE_PIDS=()
PGB_PID=""
cleanup() {
  for i in "${!PID[@]}"; do kill "${PID[$i]}" 2>/dev/null || true; done
  for p in "${EDGE_PIDS[@]}" $PGB_PID; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ -n "$T" ]; then rm -rf -- "$T"; fi
  if [ "$PT" != "$T" ]; then rm -rf -- "$PT"; fi
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

# PgBouncer refuses to run as root. As root it runs as PGB_USER (default nobody) and needs its own
# mode 700 dir owned by that user (the main temp dir stays root-only); otherwise it runs as us.
PGB_RUN_AS=()
if [ "$(id -u)" = 0 ]; then
  PGB_RUN_AS=(-u "${PGB_USER:-nobody}")
  PT="$(mktemp -d)"
  chown "${PGB_USER:-nobody}" "$PT"
fi
# The app user is not an admin in Compose. This local config adds a separate admin user with a
# random password (temp dir, loopback only) for SHOW POOLS.
ADMIN_USER=pgbadmin
ADMIN_PASS="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
printf '"%s" "%s"\n"%s" "%s"\n' "$DB_USER" "$DB_PASS" "$ADMIN_USER" "$ADMIN_PASS" >"$PT/userlist.txt"
sed -e "s#host=postgres port=5432#host=${DB_HOST} port=${DB_PORT}#" \
  -e 's#^listen_addr = .*#listen_addr = 127.0.0.1#' \
  -e "s#^listen_port = .*#listen_port = ${PGB_PORT}#" \
  -e "s#^auth_file = .*#auth_file = $PT/userlist.txt#" \
  deploy/pgbouncer.ini >"$PT/pgbouncer.ini"
printf 'admin_users = %s\nunix_socket_dir = %s\npidfile = %s/pgb.pid\n' "$ADMIN_USER" "$PT" "$PT" >>"$PT/pgbouncer.ini"
if [ "$PT" != "$T" ]; then chown "${PGB_USER:-nobody}" "$PT/userlist.txt" "$PT/pgbouncer.ini"; fi

ADMIN_URL="postgres://${ADMIN_USER}:${ADMIN_PASS}@127.0.0.1:${PGB_PORT}/pgbouncer"

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

pgbouncer "${PGB_RUN_AS[@]}" "$PT/pgbouncer.ini" >"$T/pgbouncer.out" 2>&1 &
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
    /^ *listen 80;/ { $0 = "    listen 127.0.0.1:" port ";" }
    /^pid / { $0 = "pid " t "/" name ".pid;" }
    /access_log/ { $0 = "  access_log " t "/" name ".access.log combined buffer=32k flush=1s;" }
    { print }' deploy/nginx.conf >"$T/$name.conf"
  nginx -p "$T" -c "$T/$name.conf" -g 'daemon off;' 2>"$T/$name.err" &
  EDGE_PIDS+=("$!")
  for _ in $(seq 1 40); do
    if curl -fs "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then return 0; fi
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
  env -u REDIS_URL HOST=127.0.0.1 PORT="$port" BASE_URL="$EDGE" LOG_LEVEL=warn DATABASE_URL="$PGB_URL" \
    MIGRATE_DATABASE_URL="$DATABASE_URL" TRUST_PROXY=1 "${cache[@]}" $APP_ENV \
    node dist/server.js >"$T/app$i.log" 2>&1 &
  PID[$i]=$!
  for _ in $(seq 1 60); do
    if curl -fs "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then return 0; fi
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
report() { # report NAME OK DETAIL
  if [ "$2" = 1 ]; then echo "PASS  $1: $3"; passed=$((passed + 1)); else echo "FAIL  $1: $3"; fail=1; failed=$((failed + 1)); fi
}
# The helpers below print ERR (or -1) instead of aborting, so a failed curl/jq becomes a FAIL line.
served() { # redirects this replica has handled (route /:code), from its own /metrics
  local m
  m="$(curl -fs "http://127.0.0.1:$1/metrics")" || { echo -1; return 0; }
  awk '/^http_request_duration_seconds_count/ && /route="\/:code"/ { s += $NF } END { print s + 0 }' <<<"$m"
}
new_code() { # direct to replica 1 with its own X-Forwarded-For so setup never uses the test client's create bucket
  curl -fs -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 10.9.9.9' \
    -d "{\"url\":\"https://example.com/scaleout-$RANDOM$RANDOM\"}" "http://127.0.0.1:$BASE_PORT/api/links" | jq -r .code || echo ERR
}
clicks() { curl -fs "$EDGE/api/links/$1" | jq -r .clickCount || echo ERR; }

# Create bucket of 20 is the point of (b); everything else is effectively unlimited.
APP_ENV="RATE_LIMIT_ENABLED=true RATE_LIMIT_CREATE_MAX=20 RATE_LIMIT_REDIRECT_MAX=100000 RATE_LIMIT_READ_MAX=100000 CLICK_FLUSH_INTERVAL_SECONDS=1"
for i in $(seq 1 "$REPLICAS"); do start_replica "$i"; done
start_edge edge "$NGINX_PORT"
start_edge public "$((NGINX_PORT + 1))" public
echo "### $REPLICAS replicas behind nginx :$NGINX_PORT, PgBouncer :$PGB_PORT (tmp $T)"

if [ "${ONLY:-}" != f ]; then
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
  -d "{\"url\":\"https://example.com/scaleout-$RANDOM$RANDOM\"}" "$EDGE/api/links"; done | sort | uniq -c | tr -s ' ' | tr '\n' ',')" || true
ok=0
if [ "$codes" = " 20 201, 40 429," ]; then ok=1; fi
report "(b) rate limit is global (limit 20, $REPLICAS replicas)" "$ok" "60 creates via nginx:${codes}"

# (d) spoofed X-Forwarded-For through nginx must not open a new bucket; direct to a replica it does (control)
spoof="$(for v in '1.2.3.4' '1.2.3.4, 5.6.7.8' '10.0.0.1'; do
  curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'content-type: application/json' -H "X-Forwarded-For: $v" \
    -d '{"url":"https://example.com/scaleout-spoof"}' "$EDGE/api/links"; done || true)"
control="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 1.2.3.4' \
  -d '{"url":"https://example.com/scaleout-spoof"}' "http://127.0.0.1:$BASE_PORT/api/links" || true)"
ok=0
if [ "$spoof" = "429 429 429 " ] && [ "$control" = 201 ]; then ok=1; fi
report "(d) spoofed X-Forwarded-For does not change the bucket" "$ok" "via nginx: ${spoof}; control direct to replica (no nginx): $control"

# (e) /metrics and /readyz blocked for outside clients; reachable on a replica; loopback is "private" so :8080 allows them
pub="$(for path in /metrics /readyz //metrics /%6detrics /healthz; do curl -s -o /dev/null -w '%{http_code} ' "http://127.0.0.1:$((NGINX_PORT + 1))$path"; done || true)"
priv="$(curl -s -o /dev/null -w '%{http_code}' "$EDGE/metrics" || true)"
direct="$(curl -s -o /dev/null -w '%{http_code} ' -o /dev/null "http://127.0.0.1:$BASE_PORT/metrics" "http://127.0.0.1:$BASE_PORT/readyz" || true)"
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

fi
# (f) kill a replica under steady load; nginx must retry GETs on the others
KILL_DUR=12
kill_run() { # kill_run SIGNAL REPLICA_INDEX; sets total, failed, pre (redirects the victim served before the kill), floor
  local sig="$1" k="$2" link rate="${KILL_RATE:-300}" before
  link="$(new_code)"
  before="$(served $((BASE_PORT + k - 1)))"
  rm -f "$T/kill-$sig.json"
  TARGET_URL="$EDGE/$link" RATE="$rate" DURATION="${KILL_DUR}s" "$K6" run --quiet --summary-export "$T/kill-$sig.json" loadtest/scaleout-kill.js >/dev/null 2>&1 &
  local k6pid=$!
  sleep 4
  pre=$(($(served $((BASE_PORT + k - 1))) - before))
  stop_replica "$k" "$sig"
  wait "$k6pid" || true
  total="$(jq -r '.metrics.http_reqs.count // 0' "$T/kill-$sig.json" 2>/dev/null || echo 0)"
  failed="$(jq -r '.metrics.checks.fails // 0' "$T/kill-$sig.json" 2>/dev/null || echo 0)"
  floor=$((rate * KILL_DUR * 9 / 10)) # 0 sent, or a stalled generator, must not pass
  start_replica "$k"
  sleep 12 # nginx fail_timeout (10 s) so the replica is retried before the next run
}
# kill_ok MAX_FAILED: 1 when enough requests were sent, the victim served traffic before the kill, and failures are within budget
kill_ok() {
  if [ "$total" -ge "$floor" ] && [ "$pre" -gt 0 ] && [ "$failed" -le "$1" ]; then echo 1; else echo 0; fi
}
# SIGTERM is a graceful drain, so the budget is tiny (default 0.05% of requests, TERM_BUDGET_PER_10K=5); SIGKILL may lose 1%.
kill_run TERM 2
ok="$(kill_ok $((total * ${TERM_BUDGET_PER_10K:-5} / 10000)))"
report "(f) SIGTERM one replica mid-run: GET redirects via nginx (PASS = at most ${TERM_BUDGET_PER_10K:-5}/10000 failed)" "$ok" "$failed failed of $total requests (floor $floor, victim served $pre before the kill)"
kill_run KILL "$REPLICAS"
ok="$(kill_ok $((total / 100)))"
report "(f) SIGKILL one replica mid-run: GET redirects via nginx (PASS = at most 1% failed)" "$ok" "$failed failed of $total requests (floor $floor, victim served $pre before the kill)"

if [ "${ONLY:-}" != f ]; then
# (g) graceful shutdown flushes pending clicks: flush timer off (interval 1 h), clicks sit in Redis until SIGTERM
for i in $(seq 1 "$REPLICAS"); do stop_replica "$i" TERM; done
APP_ENV="RATE_LIMIT_ENABLED=false CLICK_FLUSH_INTERVAL_SECONDS=3600"
for i in $(seq 1 "$REPLICAS"); do start_replica "$i"; done
G="$(new_code)"
N=200
for _ in $(seq 1 "$N"); do curl -s -o /dev/null "$EDGE/$G"; done
pending="$(redis-cli -u "$REDIS_URL" HGET clicks "$G" || true)"
db_before="$(clicks "$G")"
stop_replica 1 TERM
db_after="$(clicks "$G")"
left="$(redis-cli -u "$REDIS_URL" HGET clicks "$G" || true)"
ok=0
if [ "$pending" = "$N" ] && [ "$db_before" = 0 ] && [ "$db_after" = "$N" ] && [ -z "$left" ]; then ok=1; fi
report "(g) SIGTERM flushes pending clicks" "$ok" "$N redirects: pending in Redis=$pending, clickCount before=$db_before, after SIGTERM=$db_after, left in Redis='${left}'"

fi
psql "$DATABASE_URL" -qc "DELETE FROM links WHERE target_url LIKE 'https://example.com/scaleout-%'" || true
if [ "$fail" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$fail"
