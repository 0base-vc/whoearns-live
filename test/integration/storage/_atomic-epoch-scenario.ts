import type pg from 'pg';
import { pino } from 'pino';
import { EpochService } from '../../../src/services/epoch.service.js';
import { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';

/** Pause after a real close SQL write and inspect it from another DB connection. */
export async function runEpochCancellationScenario(
  pool: pg.Pool,
  mode: 'cancel' | 'failure' | 'success' = 'cancel',
) {
  const repo = new EpochsRepository(pool);
  await repo.upsert({
    epoch: 500,
    firstSlot: 50000,
    lastSlot: 50099,
    slotCount: 100,
    isClosed: false,
  });
  let closed!: () => void;
  let release!: () => void;
  const afterClose = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrap =
    (query: (...args: unknown[]) => Promise<unknown>) =>
    async (...args: unknown[]) => {
      if (mode === 'failure' && typeof args[0] === 'string' && /INSERT INTO epochs/.test(args[0]))
        await query('SELECT 1 / 0'); // Real SQL failure aborts the transaction.
      const result = await query(...args);
      if (typeof args[0] === 'string' && /UPDATE epochs\s+SET is_closed/.test(args[0])) {
        closed();
        await gate;
      }
      return result;
    };
  const wrappedPool = {
    query: wrap((...args) => Reflect.apply(pool.query, pool, args)),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: wrap((...args) => Reflect.apply(client.query, client, args)),
        release: () => client.release(),
      };
    },
  } as unknown as pg.Pool;
  const controller = new AbortController();
  const rpc = {
    getEpochInfo: async () => ({ epoch: 501, absoluteSlot: 50105 }),
    getEpochSchedule: async () => ({ slotsPerEpoch: 100, firstNormalEpoch: 0, firstNormalSlot: 0 }),
  } as unknown as SolanaRpcClient;
  const service = new EpochService({
    epochsRepo: new EpochsRepository(wrappedPool),
    rpc,
    logger: pino({ level: 'silent' }),
  });
  const pending = service.syncCurrent(controller.signal).then(
    () => 'resolved',
    () => 'cancelled',
  );
  try {
    await afterClose;
    const read = async () => ({
      current: await repo.findCurrent(),
      open: (await pool.query('SELECT epoch::text FROM epochs WHERE NOT is_closed ORDER BY epoch'))
        .rows,
    });
    const whileClosing = await read();
    if (mode === 'cancel') controller.abort(new Error('cancel during close'));
    const afterAbort = await read();
    release();
    const result = await pending;
    return { whileClosing, afterAbort, after: await read(), result };
  } finally {
    release();
    await pending;
  }
}
