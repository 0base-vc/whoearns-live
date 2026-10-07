import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { EpochService } from '../../../src/services/epoch.service.js';
import { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import { resetTables, setupPgFixture, teardownPgFixture, type PgFixture } from './_pg-fixture.js';

describe('concurrent current epoch observations — PostgreSQL16', () => {
  let fixture: PgFixture | undefined;
  beforeAll(async () => {
    fixture = await setupPgFixture();
    const version = (await fixture.pool.query('SHOW server_version')).rows[0].server_version;
    expect(version).toMatch(/^16\./);
    console.info(`concurrent-epoch regression server: PostgreSQL ${version}`);
  }, 120000);
  afterAll(async () => teardownPgFixture(fixture));
  beforeEach(async () => {
    if (!fixture) throw new Error('fixture unavailable');
    await resetTables(fixture.pool);
  });
  it.each([
    ['older first', false],
    ['newer first', false],
    ['older first', true],
    ['newer first', true],
  ] as const)('keeps only the newest epoch open (%s, multiple old=%s)', async (order, multiple) => {
    if (!fixture) throw new Error('fixture unavailable');
    const db = fixture.pool,
      repo = new EpochsRepository(db);
    await repo.upsert({
      epoch: 500,
      firstSlot: 50000,
      lastSlot: 50099,
      slotCount: 100,
      isClosed: false,
    });
    if (multiple)
      await repo.upsert({
        epoch: 498,
        firstSlot: 49800,
        lastSlot: 49899,
        slotCount: 100,
        isClosed: false,
      });
    let entered = 0,
      releaseBoth!: () => void,
      releaseFirst!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const firstCommitted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = order === 'older first' ? 501 : 502;
    const previous: number[] = [];
    const ordered = async (epoch: number, run: () => Promise<unknown>) => {
      entered++;
      if (entered === 2) releaseBoth();
      await both;
      if (epoch !== first) await firstCommitted;
      try {
        return await run();
      } finally {
        if (epoch === first) releaseFirst();
      }
    };
    type Args = Parameters<EpochsRepository['upsert']>[0];
    const observedRepo = {
      findCurrent: async () => {
        const current = await repo.findCurrent();
        if (current) previous.push(current.epoch);
        return current;
      },
      upsert: (e: Args) => ordered(e.epoch, () => repo.upsert(e)),
      rollover: (prev: number, e: Args, signal?: AbortSignal) =>
        ordered(e.epoch, () => repo.rollover(prev, e, signal)),
      observeCurrent: (e: Args, signal?: AbortSignal) =>
        ordered(e.epoch, () =>
          Reflect.apply(
            (repo as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
              'observeCurrent'
            ]!,
            repo,
            [e, signal],
          ),
        ),
    } as unknown as EpochsRepository;
    const service = (epoch: number) =>
      new EpochService({
        epochsRepo: observedRepo,
        logger: pino({ level: 'silent' }),
        rpc: {
          getEpochInfo: async () => ({ epoch, absoluteSlot: epoch * 100 + 5 }),
          getEpochSchedule: async () => ({
            firstNormalEpoch: 0,
            firstNormalSlot: 0,
            slotsPerEpoch: 100,
          }),
        } as unknown as SolanaRpcClient,
      });
    const outcomes = await Promise.allSettled([
      service(501).syncCurrent(),
      service(502).syncCurrent(),
    ]);
    const open = (
      await db.query('SELECT epoch::text FROM epochs WHERE NOT is_closed ORDER BY epoch')
    ).rows;
    console.info(
      `epoch ordering reproduction: order=${order}, previous=${previous.join(',')}, open=${open.map((r) => r.epoch).join(',')}`,
    );
    expect(open).toEqual([{ epoch: '502' }]);
    expect(await repo.findCurrent()).toMatchObject({ epoch: 502, isClosed: false });
    expect(await repo.findByEpoch(501)).toMatchObject({ isClosed: true });
    expect(await repo.findByEpoch(500)).toMatchObject({ isClosed: true });
    if (multiple) expect(await repo.findByEpoch(498)).toMatchObject({ isClosed: true });
    expect(outcomes[1].status).toBe('fulfilled');
    expect(outcomes[0].status).toBe(order === 'older first' ? 'fulfilled' : 'rejected');
  });
});
