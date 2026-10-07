import type pg from 'pg';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';

export type MeasurementWriter = 'income' | 'fee' | 'deprecated' | 'rebuild' | 'guarded rebuild';
export type MeasurementClaim = 'single' | 'bulk' | 'legacy' | 'deferred' | 'scopes';
const delta = {
  epoch: 499,
  identityPubkey: 'IA',
  leaderFeeDeltaLamports: 10n,
  baseFeeDeltaLamports: 6n,
  priorityFeeDeltaLamports: 4n,
  tipDeltaLamports: 3n,
  computeUnitsDelta: 100n,
};

async function seed(pool: pg.Pool) {
  await pool.query(`DELETE FROM watched_validators_dynamic WHERE vote_pubkey='B'`);
  const stats = new StatsRepository(pool);
  for (const [votePubkey, epoch] of [
    ['A', 499],
    ['A', 500],
    ['B', 499],
  ] as const) {
    await stats.upsertSlotStats({
      epoch,
      votePubkey,
      identityPubkey: 'IA',
      slotsAssigned: 2,
      slotsProduced: 0,
      slotsSkipped: 0,
    });
  }
  return stats;
}

async function facts(pool: pg.Pool) {
  await pool.query(`INSERT INTO processed_blocks(slot,epoch,leader_identity,block_status,
    fees_lamports,base_fees_lamports,priority_fees_lamports,tips_lamports,compute_units_consumed)
    VALUES(1,499,'IA','produced',10,6,4,3,100)`);
}

async function snapshot(pool: pg.Pool) {
  const stats = new StatsRepository(pool);
  return {
    target: await stats.findByVoteEpoch('A', 499),
    live: await stats.findByVoteEpoch('A', 500),
    unrelated: await stats.findByVoteEpoch('B', 499),
    cohort: await stats.findEconomicCohortVotes(499, 499),
    completed: Boolean(
      (await new WatchedDynamicRepository(pool).findByVote('A'))?.prevEpochBackfilledAt,
    ),
  };
}

async function write(stats: StatsRepository, kind: MeasurementWriter) {
  if (kind === 'fee')
    return stats.addFeeDelta({ epoch: 499, identityPubkey: 'IA', deltaLamports: 10n });
  if (kind === 'deprecated') {
    return stats.addFeeAndTipDelta({
      epoch: 499,
      identityPubkey: 'IA',
      feeDeltaLamports: 10n,
      tipDeltaLamports: 3n,
    });
  }
  if (kind === 'rebuild' || kind === 'guarded rebuild') {
    return stats.rebuildIncomeTotalsFromProcessedBlocks(
      499,
      ['IA'],
      [],
      kind === 'guarded rebuild',
    );
  }
  return stats.addIncomeDelta(delta);
}

export async function runMeasurementClaim(pool: pg.Pool, kind: MeasurementClaim) {
  const stats = await seed(pool);
  await stats.addIncomeDelta(delta);
  await stats.addIncomeDelta({ ...delta, epoch: 500 });
  const before = await snapshot(pool);
  const repo = new WatchedDynamicRepository(pool);
  let deferred: boolean | undefined;
  if (kind === 'legacy' || kind === 'scopes') {
    await pool.query(
      `UPDATE watched_validators_dynamic SET prev_epoch_backfill_epoch=499,
      prev_epoch_backfill_identity=$1 WHERE vote_pubkey='A'`,
      [kind === 'legacy' ? null : 'IA'],
    );
  }
  if (kind === 'deferred') {
    await pool.query(
      `UPDATE epoch_validator_stats SET identity_pubkey='IB' WHERE vote_pubkey='A' AND epoch=499`,
    );
  }
  if (kind === 'single') await repo.getOrSetBackfillTarget('A', 499, 'IA');
  else if (kind === 'scopes') await repo.getBackfillScopes(['A'], 499);
  else await repo.getOrSetBackfillTargets(499);
  if (kind === 'deferred') {
    deferred = !(await stats.upsertSlotStatsIfIdentityMatches({
      epoch: 499,
      votePubkey: 'A',
      identityPubkey: 'IA',
      slotsAssigned: 2,
      slotsProduced: 0,
      slotsSkipped: 0,
    }));
  }
  return { before, after: await snapshot(pool), deferred };
}

export async function runMeasurementWriter(pool: pg.Pool, kind: MeasurementWriter) {
  const stats = await seed(pool);
  const repo = new WatchedDynamicRepository(pool);
  await repo.getOrSetBackfillTarget('A', 499, 'IA');
  await facts(pool);
  await write(stats, kind);
  await stats.addIncomeDelta({ ...delta, epoch: 500 });
  const pending = await snapshot(pool);
  let completed: Awaited<ReturnType<typeof snapshot>> | undefined;
  if (kind === 'income' || kind === 'rebuild') {
    await stats.upsertSlotStatsIfIdentityMatches({
      epoch: 499,
      votePubkey: 'A',
      identityPubkey: 'IA',
      slotsAssigned: 1,
      slotsProduced: 1,
      slotsSkipped: 0,
    });
    await repo.markBackfilled('A', 499, 'IA');
    await stats.addIncomeDelta({
      ...delta,
      leaderFeeDeltaLamports: 0n,
      baseFeeDeltaLamports: 0n,
      priorityFeeDeltaLamports: 0n,
      tipDeltaLamports: 0n,
      computeUnitsDelta: 0n,
    });
    completed = await snapshot(pool);
  }
  return { pending, completed };
}

async function waitBlocked(pool: pg.Pool, pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [
      pid,
    ]);
    if (Number(rows[0].blockers) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expected an observed SQL lock wait');
}

/** Exercise both statement-snapshot orders with actual SQL row-lock waits. */
export async function runMeasurementRace(
  pool: pg.Pool,
  kind: 'income' | 'fee' | 'rebuild',
  order: 'claim first' | 'writer first',
) {
  await seed(pool);
  await facts(pool);
  const claimant = await pool.connect();
  const writer = await pool.connect();
  const claimRepo = new WatchedDynamicRepository({
    query: claimant.query.bind(claimant),
  } as pg.Pool);
  const writerRepo = new StatsRepository({ query: writer.query.bind(writer) } as pg.Pool);
  let pending: Promise<unknown> | undefined;
  try {
    await claimant.query('BEGIN');
    await writer.query('BEGIN');
    if (order === 'claim first') {
      await claimRepo.getOrSetBackfillTarget('A', 499, 'IA');
      const { rows } = await writer.query('SELECT pg_backend_pid() AS pid');
      pending = write(writerRepo, kind);
      await waitBlocked(pool, Number(rows[0].pid));
      await claimant.query('COMMIT');
      await pending;
      await writer.query('COMMIT');
    } else {
      await write(writerRepo, kind);
      const { rows } = await claimant.query('SELECT pg_backend_pid() AS pid');
      pending = claimRepo.getOrSetBackfillTarget('A', 499, 'IA');
      await waitBlocked(pool, Number(rows[0].pid));
      await writer.query('COMMIT');
      await pending;
      await claimant.query('COMMIT');
    }
    return await snapshot(pool);
  } finally {
    if (order === 'claim first') {
      await claimant.query('ROLLBACK');
      await writer.query('ROLLBACK');
    } else {
      await writer.query('ROLLBACK');
      await claimant.query('ROLLBACK');
    }
    if (pending) await Promise.allSettled([pending]);
    writer.release();
    claimant.release();
  }
}

/** A lookup/delta blocked behind completion must observe the committed marker. */
export async function runCompletionRace(
  pool: pg.Pool,
  kind: 'single' | 'bulk' | 'scopes' | 'income' | 'rebuild',
) {
  const stats = await seed(pool);
  await new WatchedDynamicRepository(pool).getOrSetBackfillTarget('A', 499, 'IA');
  await facts(pool);
  await stats.addIncomeDelta(delta);
  await stats.upsertSlotStatsIfIdentityMatches({
    epoch: 499,
    votePubkey: 'A',
    identityPubkey: 'IA',
    slotsAssigned: 1,
    slotsProduced: 1,
    slotsSkipped: 0,
  });
  const before = await snapshot(pool);
  const completer = await pool.connect();
  const observer = await pool.connect();
  const completionRepo = new WatchedDynamicRepository({
    query: completer.query.bind(completer),
  } as pg.Pool);
  const observerRepo = new WatchedDynamicRepository({
    query: observer.query.bind(observer),
  } as pg.Pool);
  const observerStats = new StatsRepository({ query: observer.query.bind(observer) } as pg.Pool);
  let pending: Promise<unknown> | undefined;
  try {
    await completer.query('BEGIN');
    if (!(await completionRepo.markBackfilled('A', 499, 'IA')))
      throw new Error('expected complete facts');
    const { rows } = await observer.query('SELECT pg_backend_pid() AS pid');
    if (kind === 'single') pending = observerRepo.getOrSetBackfillTarget('A', 499, 'IA');
    else if (kind === 'bulk') pending = observerRepo.getOrSetBackfillTargets(499);
    else if (kind === 'scopes') pending = observerRepo.getBackfillScopes(['A'], 499);
    else if (kind === 'rebuild')
      pending = observerStats.rebuildIncomeTotalsFromProcessedBlocks(499, ['IA'], [], true);
    else
      pending = observerStats.addIncomeDelta({
        ...delta,
        leaderFeeDeltaLamports: 0n,
        baseFeeDeltaLamports: 0n,
        priorityFeeDeltaLamports: 0n,
        tipDeltaLamports: 0n,
        computeUnitsDelta: 0n,
      });
    await waitBlocked(pool, Number(rows[0].pid));
    await completer.query('COMMIT');
    await pending;
    return { before, after: await snapshot(pool) };
  } finally {
    await completer.query('ROLLBACK');
    if (pending) await Promise.allSettled([pending]);
    completer.release();
    observer.release();
  }
}
