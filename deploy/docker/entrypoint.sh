#!/bin/sh
#
# All-in-one entrypoint: initialises a local PostgreSQL if needed, starts
# it, runs migrations, then supervises API + Worker with pm2-runtime in
# the same container.
#
# Supervision: api.js and worker.js run under pm2-runtime — NOT a bare
# `node ... & wait -n`. pm2 restarts either process IN PLACE if it crashes
# or exceeds its memory ceiling. The 2026-06 incident was a worker that
# died under memory pressure while `wait -n` failed to notice, freezing the
# epoch pipeline for days while the API kept serving. PostgreSQL is started
# and owned here (not by pm2): it has its own process model and a clean
# shutdown via `pg_ctl`. See deploy/docker/ecosystem.config.cjs.
#
# The container is expected to run as the `postgres` user (uid/gid 70) so
# that no su-exec or chown calls are needed. Kubernetes handles volume
# ownership via `fsGroup: 70`; Docker named volumes inherit ownership
# from the image-built `/var/lib/postgresql` directory.
#
# On SIGTERM: forwards to pm2 (which drains api + worker), then stops
# postgres with `pg_ctl stop -m fast` for a clean shutdown.

set -eu

POSTGRES_USER="${POSTGRES_USER:-indexer}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-indexer}"
POSTGRES_DB="${POSTGRES_DB:-indexer}"
PGDATA="${PGDATA:-/var/lib/postgresql/data/pgdata}"
ECOSYSTEM_CONFIG="${ECOSYSTEM_CONFIG:-/usr/local/bin/ecosystem.config.cjs}"

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
  log "received termination signal — stopping pm2 (drains api + worker)"
  if [ -n "${PM2_PID:-}" ] && kill -0 "$PM2_PID" 2>/dev/null; then
    # pm2-runtime forwards SIGTERM to its apps and waits each app's
    # kill_timeout (see ecosystem.config.cjs) before SIGKILL. Give it 25s,
    # comfortably under the pod's 30s terminationGracePeriodSeconds while
    # still leaving room for the postgres stop below.
    kill -TERM "$PM2_PID" 2>/dev/null || true
    deadline=$(( $(date +%s) + 25 ))
    while kill -0 "$PM2_PID" 2>/dev/null; do
      [ "$(date +%s)" -ge "$deadline" ] && break
      sleep 1
    done
  fi
  stop_postgres
  exit 0
}

trap shutdown TERM INT

init_postgres_if_needed
start_postgres

log "running migrations"
node dist/scripts/migrate.js up

log "starting api + worker under pm2-runtime ($ECOSYSTEM_CONFIG)"
# pm2-runtime is the foreground supervisor. `--raw` passes each app's
# stdout through unmodified so the pino JSON log lines stay parseable
# (no pm2 name/timestamp prefix) — log-based debugging relies on this.
# Backgrounded + `wait`ed (rather than `exec`) so this shell keeps its
# SIGTERM trap and can stop postgres after pm2 exits.
pm2-runtime start "$ECOSYSTEM_CONFIG" --raw &
PM2_PID=$!

set +e
wait "$PM2_PID"
EXIT_CODE=$?
# Reached only if pm2-runtime exits on its own (every app gave up past
# max_restarts). Stop postgres and propagate the code so the container
# exits and Kubernetes restarts the pod. A SIGTERM instead runs the
# `shutdown` trap above, which exits 0.
log "pm2-runtime exited with code $EXIT_CODE — stopping postgres"
stop_postgres
exit "$EXIT_CODE"
