/**
 * Convenience dispatcher. The canonical entrypoints are
 * `dist/entrypoints/api.js` and `dist/entrypoints/worker.js`; prefer those in
 * production. This file exists for `npm start` / `node dist/index.js` usage
 * where mode is selected via `ENTRYPOINT_MODE=api|worker`.
 */

import { startApi } from './entrypoints/api.js';
import { startWorker } from './entrypoints/worker.js';

const mode = (process.env['ENTRYPOINT_MODE'] ?? 'api').toLowerCase();

async function main(): Promise<void> {
  if (mode === 'api') {
    await startApi();
  } else if (mode === 'worker') {
    await startWorker();
  } else {
    console.error(`unknown ENTRYPOINT_MODE=${mode} (expected "api" or "worker")`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('entrypoint failed', err);
  process.exit(1);
});
