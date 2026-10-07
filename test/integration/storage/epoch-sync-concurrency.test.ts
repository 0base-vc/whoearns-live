import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { runEpochCancellationScenario } from './_atomic-epoch-scenario.js';
import { EpochService } from '../../../src/services/epoch.service.js';
import { EpochsRepository } from '../../../src/storage/repositories/epochs.repo.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import {
  boundPgPool,
  resetTables,
  setupPgFixture,
  teardownPgFixture,
  type PgFixture,
} from './_pg-fixture.js';

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
        ordered(e.epoch, () => repo.observeCurrent(e, signal)),
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
  it.each(['cancel', 'failure', 'success'] as const)(
    'makes all superseded rows atomic under %s',
    async (mode) => {
      if (!fixture) throw new Error('fixture unavailable');
      const result = await runEpochCancellationScenario(fixture.pool, mode, true);
      for (const read of [result.whileClosing, result.afterAbort]) {
        expect(read.current).toMatchObject({ epoch: 500, isClosed: false });
        expect(read.open).toEqual([{ epoch: '498' }, { epoch: '500' }]);
      }
      expect(result.after.open).toEqual(
        mode === 'success' ? [{ epoch: '501' }] : [{ epoch: '498' }, { epoch: '500' }],
      );
      expect(result.after.current).toMatchObject({
        epoch: mode === 'success' ? 501 : 500,
        isClosed: false,
      });
    },
  );

  it('rejects cancellation after a real observation-lock wait without replacing the newer current epoch', async () => {
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
    const leader = await db.connect(),
      waiter = await db.connect();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const afterClose = new Promise<void>((r) => {
      reached = r;
    });
    const leaderPool = boundPgPool(leader);
    const query = leaderPool.query.bind(leaderPool);
    leaderPool.query = (async (...args: unknown[]) => {
      const result = await Reflect.apply(query, leaderPool, args);
      if (typeof args[0] === 'string' && /UPDATE epochs\s+SET is_closed/.test(args[0])) {
        reached();
        await gate;
      }
      return result;
    }) as typeof leaderPool.query;
    const e = (epoch: number) => ({
      epoch,
      firstSlot: epoch * 100,
      lastSlot: epoch * 100 + 99,
      slotCount: 100,
      isClosed: false,
    });
    const controller = new AbortController();
    const first = new EpochsRepository(leaderPool).observeCurrent(e(502));
    let second: Promise<unknown> | undefined;
    try {
      await afterClose;
      const pid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      second = new EpochsRepository(boundPgPool(waiter))
        .observeCurrent(e(501), controller.signal)
        .then(
          () => 'resolved',
          () => 'cancelled',
        );
      let blocked = false;
      for (let n = 0; n < 100 && !blocked; n++) {
        blocked = (await db.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]))
          .rows[0].blocked;
        if (!blocked) await new Promise((r) => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
      expect(await repo.findCurrent()).toMatchObject({ epoch: 500, isClosed: false });
      controller.abort(new Error('shutdown during observation lock'));
      release();
      expect(await first).toBe(true);
      expect(await second).toBe('cancelled');
      expect(await repo.findCurrent()).toMatchObject({ epoch: 502, isClosed: false });
      expect(await repo.findByEpoch(501)).toBeNull();
      expect((await db.query('SELECT epoch::text FROM epochs WHERE NOT is_closed')).rows).toEqual([
        { epoch: '502' },
      ]);
    } finally {
      release();
      await first;
      await second;
      leader.release();
      waiter.release();
    }
  });

  it('serializes cold starts and closes stray lower rows on same-epoch observations', async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const repo = new EpochsRepository(fixture.pool);
    const e = (epoch: number) => ({
      epoch,
      firstSlot: epoch * 100,
      lastSlot: epoch * 100 + 99,
      slotCount: 100,
      isClosed: false,
    });
    await Promise.all([repo.observeCurrent(e(501)), repo.observeCurrent(e(502))]);
    await repo.upsert(e(498));
    expect(await repo.observeCurrent(e(502))).toBe(true);
    expect(
      (await fixture.pool.query('SELECT epoch::text FROM epochs WHERE NOT is_closed')).rows,
    ).toEqual([{ epoch: '502' }]);
    expect(await repo.findCurrent()).toMatchObject({ epoch: 502, isClosed: false });
  });
});
