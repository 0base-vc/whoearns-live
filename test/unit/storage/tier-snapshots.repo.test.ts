import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  TierSnapshotsRepository,
  type TierSnapshotUpsert,
} from '../../../src/storage/repositories/tier-snapshots.repo.js';
import type { VotePubkey } from '../../../src/types/domain.js';

/**
 * Capturing `pg.Pool` fake — the tier-snapshots repo only calls
 * `pool.query(sql, params)`, so we record each call and hand back a
 * canned result set. Lets the UNNEST batch + row-mapping logic be
 * unit-tested without a live Postgres (the repo otherwise only has
 * Docker-backed integration coverage).
 */
class FakePool {
  calls: Array<{ sql: string; params: unknown[] }> = [];
  nextRows: unknown[] = [];

  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ sql, params: params ?? [] });
    const rows = this.nextRows;
    this.nextRows = [];
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  get last(): { sql: string; params: unknown[] } {
    const c = this.calls[this.calls.length - 1];
    if (c === undefined) throw new Error('no query was issued');
    return c;
  }
}

const VOTE_A = 'VoteAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as VotePubkey;
const VOTE_B = 'VoteBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as VotePubkey;

function makeRepo(): { repo: TierSnapshotsRepository; pool: FakePool } {
  const pool = new FakePool();
  const repo = new TierSnapshotsRepository(pool as unknown as pg.Pool);
  return { repo, pool };
}

describe('TierSnapshotsRepository.upsertBatch', () => {
  let repo: TierSnapshotsRepository;
  let pool: FakePool;
  beforeEach(() => {
    ({ repo, pool } = makeRepo());
  });

  it('is a no-op (no query) on an empty batch', async () => {
    const written = await repo.upsertBatch([]);
    expect(written).toBe(0);
    expect(pool.calls).toHaveLength(0);
  });

  it('upserts a batch as one UNNEST statement with column-major arrays', async () => {
    const rows: TierSnapshotUpsert[] = [
      {
        votePubkey: VOTE_A,
        epoch: 510,
        composite: 87,
        tier: 'forge',
        reliability: 0.98,
        economicPercentile: 0.91,
        cuPercentile: 0.77,
      },
      {
        votePubkey: VOTE_B,
        epoch: 510,
        composite: null, // unrated → null composite
        tier: 'unrated',
        reliability: 0.4,
        economicPercentile: null,
        cuPercentile: null,
      },
    ];
    await repo.upsertBatch(rows);

    const { sql, params } = pool.last;
    // Single-statement batch via UNNEST of seven typed arrays.
    expect(sql).toMatch(/INSERT INTO tier_snapshots/);
    expect(sql).toMatch(/UNNEST\(/);
    // Idempotent on the (vote, epoch) PK.
    expect(sql).toMatch(/ON CONFLICT \(vote_pubkey, epoch\) DO UPDATE/);
    // Column-major: one array per column, each in row order.
    expect(params[0]).toEqual([VOTE_A, VOTE_B]);
    expect(params[1]).toEqual([510, 510]);
    expect(params[2]).toEqual([87, null]);
    expect(params[3]).toEqual(['forge', 'unrated']);
    expect(params[4]).toEqual([0.98, 0.4]);
    expect(params[5]).toEqual([0.91, null]);
    expect(params[6]).toEqual([0.77, null]);
  });

  it('returns the rowCount the pool reports', async () => {
    pool.nextRows = [{}, {}];
    const written = await repo.upsertBatch([
      {
        votePubkey: VOTE_A,
        epoch: 1,
        composite: 50,
        tier: 'hearth',
        reliability: 0.5,
        economicPercentile: 0.5,
        cuPercentile: null,
      },
    ]);
    // rowCount mirrors the canned result length.
    expect(written).toBe(2);
  });
});

describe('TierSnapshotsRepository reads', () => {
  let repo: TierSnapshotsRepository;
  let pool: FakePool;
  beforeEach(() => {
    ({ repo, pool } = makeRepo());
  });

  it('findByVote clamps the limit to 1..60 and orders newest-first', async () => {
    pool.nextRows = [
      {
        vote_pubkey: VOTE_A,
        epoch: 511,
        composite: 88,
        tier: 'forge',
        reliability: 0.99,
        economic_percentile: 0.92,
        cu_percentile: 0.81,
        created_at: new Date('2026-05-01T00:00:00Z'),
      },
    ];
    const out = await repo.findByVote(VOTE_A, 9999);
    const { sql, params } = pool.last;
    expect(sql).toMatch(/ORDER BY epoch DESC/);
    // 9999 clamped to the 60 cap.
    expect(params).toEqual([VOTE_A, 60]);
    // Row mapping: snake_case columns → camelCase domain shape.
    expect(out).toEqual([
      {
        votePubkey: VOTE_A,
        epoch: 511,
        composite: 88,
        tier: 'forge',
        reliability: 0.99,
        economicPercentile: 0.92,
        cuPercentile: 0.81,
        createdAt: new Date('2026-05-01T00:00:00Z'),
      },
    ]);
  });

  it('findByVote floors a non-positive limit to 1', async () => {
    await repo.findByVote(VOTE_A, 0);
    expect(pool.last.params).toEqual([VOTE_A, 1]);
  });

  it('findByVote maps null composite + null components (unrated row)', async () => {
    pool.nextRows = [
      {
        vote_pubkey: VOTE_A,
        epoch: 500,
        composite: null,
        tier: 'unrated',
        reliability: null,
        economic_percentile: null,
        cu_percentile: null,
        created_at: new Date('2026-04-01T00:00:00Z'),
      },
    ];
    const out = await repo.findByVote(VOTE_A, 16);
    expect(out[0]).toMatchObject({
      composite: null,
      tier: 'unrated',
      reliability: null,
      economicPercentile: null,
      cuPercentile: null,
    });
  });

  it('findLatestTwo reads at most 2 rows newest-first', async () => {
    pool.nextRows = [];
    const out = await repo.findLatestTwo(VOTE_A);
    const { sql, params } = pool.last;
    expect(sql).toMatch(/ORDER BY epoch DESC/);
    expect(sql).toMatch(/LIMIT 2/);
    expect(params).toEqual([VOTE_A]);
    expect(out).toEqual([]);
  });
});
