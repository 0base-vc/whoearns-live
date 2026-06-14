#!/bin/sh
#
# All-in-one entrypoint: initialises a local PostgreSQL if needed, starts
# it, runs migrations, then supervises API + Worker in the same container.
#
# Supervision: api.js and worker.js run as direct background children of
# this shell, so they INHERIT the container's stdout/stderr — their pino
# JSON logs flow straight to `kubectl logs`. A poll loop restarts any child
# that exits (the 2026-06 incident was a worker that died under memory
# pressure while the old `wait -n` never noticed, freezing the epoch
# pipeline while the API kept serving) and recycles a child that exceeds
# its RSS ceiling (a graceful stand-in for the hard cgroup OOM-kill removed
# from the Helm limits).
#
# Why not a stdout-capturing supervisor (e.g. pm2): this app logs BEFORE it
# listens, and a process manager that pipes child stdout but doesn't drain
# it fast enough deadlocks that first write — the API never binds its port.
# Inheriting the container's (kubelet-drained) stdout, as below, avoids it.
# The `/livez` freshness probe remains the backstop for a child that is
# alive-but-wedged (which neither this loop nor pm2 can detect).
#
# The container is expected to run as the `postgres` user (uid/gid 70) so
# that no su-exec or chown calls are needed. Kubernetes handles volume
# ownership via `fsGroup: 70`; Docker named volumes inherit ownership
# from the image-built `/var/lib/postgresql` directory.
#
# On SIGTERM: forwards to both children, waits up to 25s, then stops
# postgres with `pg_ctl stop -m fast` for a clean shutdown.

set -eu

POSTGRES_USER="${POSTGRES_USER:-indexer}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-indexer}"
POSTGRES_DB="${POSTGRES_DB:-indexer}"
PGDATA="${PGDATA:-/var/lib/postgresql/data/pgdata}"

# Supervision tunables. The memory ceilings are a graceful runaway-backstop,
# NOT a tight budget: the node has ~125 GiB and normal RSS is well under
# 1 GiB, so these sit far above the ~3 GiB historical leak peak. A child
# over its ceiling is SIGTERM'd and restarted on the next poll — replacing
# the removed hard 3 GiB cgroup OOM-kill (which never auto-recovered) with a
# clean recycle.
POLL_INTERVAL="${SUPERVISOR_POLL_INTERVAL:-10}"
RESTART_DELAY="${CHILD_RESTART_DELAY:-3}"
API_MAX_RSS_MB="${API_MAX_RSS_MB:-1024}"
WORKER_MAX_RSS_MB="${WORKER_MAX_RSS_MB:-4096}"

SHUTTING_DOWN=0
API_PID=""
WORKER_PID=""

log() { echo "[entrypoint] $*"; }

init_postgres_if_needed() {
  mkdir -p "$PGDATA"

  if [ -s "$PGDATA/PG_VERSION" ]; then
    log "existing postgres data dir detected at $PGDATA"
    return 0
  fi

  log "initializing fresh data dir at $PGDATA"
  initdb -D "$PGDATA" \
    --username="$POSTGRES_USER" \
    --encoding=UTF8 \
    --auth-local=trust \
    --auth-host=md5 \
    >/dev/null

  # Seed the role password and app database on a short-lived local-only
  # postmaster so we never expose an unauthenticated surface on TCP.
  pg_ctl -D "$PGDATA" -o "-c listen_addresses=" -w start >/dev/null
  psql -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname=postgres <<SQL >/dev/null
ALTER USER "$POSTGRES_USER" WITH PASSWORD '$POSTGRES_PASSWORD';
CREATE DATABASE "$POSTGRES_DB" OWNER "$POSTGRES_USER";
SQL
  pg_ctl -D "$PGDATA" -w stop >/dev/null
  log "data dir initialized"
}

start_postgres() {
  log "starting postgres on 127.0.0.1:5432"
  postgres -D "$PGDATA" \
    -c listen_addresses=127.0.0.1 \
    -c port=5432 \
    -c shared_buffers=128MB \
    -c max_connections=50 &
  PG_PID=$!

  log "waiting for postgres to accept connections"
  for _ in $(seq 1 30); do
    if pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      log "postgres ready"
      export POSTGRES_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:5432/$POSTGRES_DB"
      return 0
    fi
    sleep 1
  done
  log "ERROR: postgres did not become ready within 30s"
  exit 1
}

stop_postgres() {
  if [ -n "${PG_PID:-}" ] && kill -0 "$PG_PID" 2>/dev/null; then
    log "stopping postgres (fast shutdown)"
    pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
}

# Resident set size in MB of a pid; sets RSS_MB (0 when the pid is gone or
# /proc is unavailable, so the ceiling check simply never fires there).
rss_mb() {
  RSS_MB=0
  [ -n "${1:-}" ] || return 0
  _kb=$(awk '/^VmRSS:/{print $2}' "/proc/$1/status" 2>/dev/null || true)
  [ -n "${_kb:-}" ] && RSS_MB=$(( _kb / 1024 ))
  return 0
}

start_api() {
  node dist/entrypoints/api.js &
  API_PID=$!
  log "api started (pid $API_PID)"
}

start_worker() {
  node dist/entrypoints/worker.js &
  WORKER_PID=$!
  log "worker started (pid $WORKER_PID)"
}

shutdown() {
  SHUTTING_DOWN=1
  log "received termination signal — stopping children"
  [ -n "$WORKER_PID" ] && kill -TERM "$WORKER_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill -TERM "$API_PID" 2>/dev/null || true
  deadline=$(( $(date +%s) + 25 ))
  while { [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; } \
     || { [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; }; do
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 1
  done
  stop_postgres
  exit 0
}

trap shutdown TERM INT

init_postgres_if_needed
start_postgres

log "running migrations"
node dist/scripts/migrate.js up

log "starting api + worker (supervised)"
start_api
start_worker

# Supervision loop. `set +e` so a transient nonzero from kill/wait never
# aborts it. Each tick: restart a child that exited, then recycle a child
# over its RSS ceiling (the next tick restarts it).
set +e
while [ "$SHUTTING_DOWN" = 0 ]; do
  sleep "$POLL_INTERVAL"
  [ "$SHUTTING_DOWN" = 1 ] && break

  if ! kill -0 "$API_PID" 2>/dev/null; then
    wait "$API_PID" 2>/dev/null
    code=$?
    log "api exited (code $code) — restarting in ${RESTART_DELAY}s"
    sleep "$RESTART_DELAY"
    [ "$SHUTTING_DOWN" = 1 ] && break
    start_api
  fi

  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    wait "$WORKER_PID" 2>/dev/null
    code=$?
    log "worker exited (code $code) — restarting in ${RESTART_DELAY}s"
    sleep "$RESTART_DELAY"
    [ "$SHUTTING_DOWN" = 1 ] && break
    start_worker
  fi

  rss_mb "$API_PID"
  if [ "$RSS_MB" -gt "$API_MAX_RSS_MB" ]; then
    log "api RSS ${RSS_MB}MB exceeds ${API_MAX_RSS_MB}MB ceiling — recycling"
    kill -TERM "$API_PID" 2>/dev/null
  fi

  rss_mb "$WORKER_PID"
  if [ "$RSS_MB" -gt "$WORKER_MAX_RSS_MB" ]; then
    log "worker RSS ${RSS_MB}MB exceeds ${WORKER_MAX_RSS_MB}MB ceiling — recycling"
    kill -TERM "$WORKER_PID" 2>/dev/null
  fi
done
