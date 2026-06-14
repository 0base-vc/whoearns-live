// pm2-runtime process manifest for the all-in-one container.
//
// Supervises the two long-lived Node processes — api.js and worker.js —
// restarting either IN PLACE if it crashes or exceeds its memory ceiling.
// PostgreSQL is started and owned by entrypoint.sh (it has its own process
// model and a clean-shutdown path via pg_ctl), so it is intentionally NOT
// managed here.
//
// Why this exists: in the 2026-06 incident the worker died under memory
// pressure while the entrypoint's `wait -n` failed to notice, so the epoch
// pipeline froze for days while the API kept serving `/healthz` 200. pm2
// restarts a crashed/OOMing child in place; if pm2 itself exits, the
// container exits and Kubernetes restarts the pod. The `/livez` freshness
// liveness probe is the backstop for a worker that is alive-but-wedged.
//
// Memory ceilings are a GRACEFUL runaway-backstop, not a tight budget. The
// node has ~125 GiB and normal combined RSS is well under 1 GiB, so these
// sit far above the ~3 GiB historical leak peak: pm2 restarts the process
// cleanly (SIGTERM → graceful drain → relaunch) only if it crosses the
// ceiling. This REPLACES the old hard 3 GiB cgroup OOM-kill (which did not
// auto-recover) with a self-healing graceful restart. Override per
// deployment via WORKER_MAX_MEMORY_RESTART / API_MAX_MEMORY_RESTART.
const workerMaxMemory = process.env.WORKER_MAX_MEMORY_RESTART || '4G';
const apiMaxMemory = process.env.API_MAX_MEMORY_RESTART || '1G';

module.exports = {
  apps: [
    {
      name: 'api',
      script: 'dist/entrypoints/api.js',
      cwd: '/app',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Generous; a genuine crash-loop still eventually surfaces (the
      // process keeps restarting, /livez stays up only while the worker
      // heartbeat is fresh). restart_delay backs off so a tight crash
      // loop does not busy-spin the CPU.
      max_restarts: 50,
      restart_delay: 2000,
      max_memory_restart: apiMaxMemory,
      // Graceful-shutdown budget before SIGKILL. Must stay under the pod's
      // terminationGracePeriodSeconds (30s) minus the postgres stop.
      kill_timeout: 8000,
    },
    {
      name: 'worker',
      script: 'dist/entrypoints/worker.js',
      cwd: '/app',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: workerMaxMemory,
      kill_timeout: 15000,
    },
  ],
};
