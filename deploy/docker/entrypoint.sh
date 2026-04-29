#!/bin/sh
#
# All-in-one entrypoint: initialises a local PostgreSQL if needed, starts
# it, runs migrations, then runs API and Worker in the same container.
#
# The container is expected to run as the `postgres` user (uid/gid 70) so
# that no su-exec or chown calls are needed. Kubernetes handles volume
# ownership via `fsGroup: 70`; Docker named volumes inherit ownership
# from the image-built `/var/lib/postgresql` directory.
#
# On SIGTERM: forwards to all children, waits up to 20s, then stops
# postgres with `pg_ctl stop -m fast` for a clean shutdown.

set -eu

POSTGRES_USER="${POSTGRES_USER:-indexer}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-indexer}"
POSTGRES_DB="${POSTGRES_DB:-indexer}"
PGDATA="${PGDATA:-/var/lib/postgresql/data/pgdata}"

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

shutdown() {
  log "received termination signal — stopping children"
  [ -n "${WORKER_PID:-}" ] && kill -TERM "$WORKER_PID" 2>/dev/null || true
  [ -n "${API_PID:-}" ] && kill -TERM "$API_PID" 2>/dev/null || true
  deadline=$(( $(date +%s) + 20 ))
  while { [ -n "${API_PID:-}" ] && kill -0 "$API_PID" 2>/dev/null; } \
     || { [ -n "${WORKER_PID:-}" ] && kill -0 "$WORKER_PID" 2>/dev/null; }; do
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

log "starting api"
node dist/entrypoints/api.js &
API_PID=$!

log "starting worker"
node dist/entrypoints/worker.js &
WORKER_PID=$!

set +e
wait -n "$API_PID" "$WORKER_PID"
EXIT_CODE=$?
log "child exited with code $EXIT_CODE — shutting down the rest"
shutdown
