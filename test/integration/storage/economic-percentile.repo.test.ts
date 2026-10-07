import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatsRepository } from '../../../src/storage/repositories/stats.repo.js';
import { resetTables, setupPgFixture, teardownPgFixture, type PgFixture } from './_pg-fixture.js';

const FROM = 1041;
const TO = 1050;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Hash Cond'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
  Plans?: PlanNode[];
}

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

describe('economic percentile equality join — PostgreSQL 16', () => {
  let fixture: PgFixture | undefined;
  let repo: StatsRepository;
  let baselineRepo: StatsRepository;
  let baselineSql: string;
  let nextSlot = 1;

  function pool(): pg.Pool {
    if (!fixture) throw new Error('PostgreSQL fixture is not ready');
    return fixture.pool;
  }

  beforeAll(async () => {
    fixture = await setupPgFixture();
    const { rows } = await pool().query<{ server_version: string }>('SHOW server_version');
    expect(rows[0]?.server_version).toMatch(/^16\./);
    console.info(`economic-percentile regression server: PostgreSQL ${rows[0]?.server_version}`);
    baselineSql = await readFile(
      new URL('../../fixtures/economic-percentile-before-equality.sql', import.meta.url),
      'utf8',
    );
    repo = new StatsRepository(pool());
    // Only the query is replaced: both variants use the real repository's
    // result mapping, while the old SQL is a frozen, independent oracle.
    baselineRepo = new StatsRepository({
      query: (_sql: string, values: unknown[]) => pool().query(baselineSql, values),
    } as unknown as pg.Pool);
  }, 120_000);

  afterAll(async () => {
    await teardownPgFixture(fixture);
  });

  async function reset(): Promise<void> {
    await resetTables(pool());
    nextSlot = 1;
  }

  async function seedValidator(
    vote: string,
    identities: string[],
    opts: {
      partial?: 'fees' | 'tips';
      optedOut?: boolean;
      zeroSlots?: boolean;
      slotsUnseen?: boolean;
      income?: number;
    } = {},
  ): Promise<void> {
    await pool().query(
      `INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch)
       VALUES($1,$2,$3,$4)`,
      [vote, identities[0], FROM, TO],
    );
    const now = new Date();
    for (const [offset, identity] of identities.entries()) {
      await pool().query(
        `INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,
           slots_assigned,slots_updated_at,fees_updated_at,tips_updated_at,
           block_fees_total_lamports,block_tips_total_lamports)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)`,
        [
          FROM + offset,
          vote,
          identity,
          opts.zeroSlots ? 0 : 10,
          opts.slotsUnseen ? null : now,
          opts.partial === 'fees' ? null : now,
          opts.partial === 'tips' ? null : now,
          opts.income ?? 100,
        ],
      );
    }
    if (opts.optedOut) {
      await pool().query(
        `INSERT INTO validator_claims(vote_pubkey,identity_pubkey,last_nonce_used)
         VALUES($1,$2,'fixture')`,
        [vote, identities[0]],
      );
      await pool().query('INSERT INTO validator_profiles(vote_pubkey,opted_out) VALUES($1,TRUE)', [
        vote,
      ]);
    }
  }

  async function block(
    epoch: number,
    identity: string,
    cu: number,
    status = 'produced',
  ): Promise<void> {
    await pool().query(
      `INSERT INTO processed_blocks(epoch,slot,leader_identity,fees_lamports,
         block_status,compute_units_consumed) VALUES($1,$2,$3,1,$4,$5)`,
      [epoch, nextSlot++, identity, status, cu],
    );
  }

  async function compare(vote: string) {
    const oldResult = await baselineRepo.findEconomicPercentile(vote, FROM, TO);
    const result = await repo.findEconomicPercentile(vote, FROM, TO);
    expect(result).toEqual(oldResult);
    return result;
  }

  describe('rotation, weighting, nulls and cohort membership', () => {
    beforeAll(async () => {
      await reset();
      await seedValidator('Rotator', ['Old', 'New', 'Old']);
      await seedValidator('Shared', ['Old']);
      await seedValidator('NoBlocks', ['Empty']);
      await seedValidator('SkippedOnly', ['Skipped']);
      await seedValidator('ZeroCu', ['Zero']);
      await seedValidator('Partial', ['Partial'], { partial: 'fees' });
      await seedValidator('FeesOnly', ['FeesOnly'], { partial: 'tips' });
      await seedValidator('SlotsUnseen', ['SlotsUnseen'], { slotsUnseen: true });
      await seedValidator('OptedOut', ['OptedOut'], { optedOut: true });
      await seedValidator('ZeroSlots', ['ZeroSlots'], { zeroSlots: true });
      // BOTH identities in one epoch, then an old identity used in a
      // later epoch. Identity matching remains window-wide. Repeating
      // Old in the stats must not multiply its block facts.
      await block(FROM, 'Old', 10);
      await block(FROM, 'New', 30);
      await block(FROM + 1, 'New', 40);
      await block(FROM + 1, 'Old', 20);
      await block(FROM + 2, 'Old', 50);
      await block(TO, 'New', 90); // second partition; weighted average = 40
      await block(FROM, 'New', 999, 'skipped');
      await block(FROM - 1, 'Old', 9999);
      await block(TO + 1, 'New', 9999);
      await block(FROM, 'Skipped', 100, 'skipped');
      await block(FROM, 'Zero', 0);
      for (const identity of [
        'Partial',
        'FeesOnly',
        'SlotsUnseen',
        'OptedOut',
        'ZeroSlots',
        'Unrelated',
      ]) {
        await block(FROM, identity, 1000);
      }
    });

    it.each([
      'Rotator',
      'Shared',
      'NoBlocks',
      'SkippedOnly',
      'ZeroCu',
      'Partial',
      'FeesOnly',
      'SlotsUnseen',
      'OptedOut',
      'ZeroSlots',
      'Missing',
    ])('preserves the full percentile lookup for %s', async (vote) => {
      const result = await compare(vote);
      expect(result.cohortSize).toBe(5);
      if (vote === 'Rotator') {
        expect(result.validatorAvgCuPerBlock).toBe(40);
        expect(result.measuredEpochs).toBe(3);
      }
      if (vote === 'Shared') expect(result.validatorAvgCuPerBlock).toBeCloseTo(80 / 3, 12);
      if (['NoBlocks', 'SkippedOnly'].includes(vote)) {
        expect(result.validatorAvgCuPerBlock).toBeNull();
        expect(result.cuPercentile).toBeNull();
        expect(result.percentile).not.toBeNull();
      }
      if (vote === 'ZeroCu') {
        expect(result.validatorAvgCuPerBlock).toBe(0);
        expect(result.cuPercentile).toBe(0);
      }
      if (
        ['Partial', 'FeesOnly', 'SlotsUnseen', 'OptedOut', 'ZeroSlots', 'Missing'].includes(vote)
      ) {
        expect(result.percentile).toBeNull();
        expect(result.measuredEpochs).toBe(0);
        expect(result.cohortMedianCuPerBlock).toBeCloseTo(80 / 3, 12);
      }
    });
  });

  describe('deterministic randomized parity', () => {
    beforeAll(async () => {
      await reset();
      let seed = 19;
      const random = (n: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % n;
      };
      for (let v = 0; v < 24; v++) {
        await seedValidator(
          `V${v}`,
          Array.from({ length: 4 }, () => `I${random(16)}`),
          {
            ...(v % 9 === 0 ? { partial: 'fees' as const } : {}),
            optedOut: v % 11 === 0,
            income: random(5) * 100,
          },
        );
      }
      const epochs: number[] = [];
      const slots: number[] = [];
      const identities: string[] = [];
      const cus: number[] = [];
      const statuses: string[] = [];
      for (let n = 0; n < 4000; n++) {
        epochs.push(FROM - 1 + random(12));
        slots.push(nextSlot++);
        identities.push(`I${random(20)}`);
        cus.push(random(5) * 10_000_000);
        statuses.push(random(8) === 0 ? 'skipped' : 'produced');
      }
      await pool().query(
        `INSERT INTO processed_blocks(epoch,slot,leader_identity,compute_units_consumed,block_status,fees_lamports)
         SELECT epoch,slot,identity,cu,status,1
         FROM unnest($1::bigint[],$2::bigint[],$3::text[],$4::numeric[],$5::text[])
           AS facts(epoch,slot,identity,cu,status)`,
        [epochs, slots, identities, cus, statuses],
      );
    });

    it.each(Array.from({ length: 25 }, (_, v) => `V${v}`))(
      'matches the frozen array-join query for %s',
      async (vote) => {
        await compare(vote);
      },
    );
  });

  describe('empty cohort', () => {
    beforeAll(reset);

    it('returns null target and distribution values with a zero-sized cohort', async () => {
      const result = await compare('Missing');
      expect(result.cohortSize).toBe(0);
      expect(result.percentile).toBeNull();
      expect(result.validatorAvgCuPerBlock).toBeNull();
      expect(result.cohortMedianCuPerBlock).toBeNull();
      expect(result.cohortMedianLamportsPerSlot).toBeNull();
    });
  });

  describe('representative cohort execution plan', () => {
    beforeAll(async () => {
      await reset();
      await pool()
        .query(`INSERT INTO validators(vote_pubkey,identity_pubkey,first_seen_epoch,last_seen_epoch)
        SELECT 'V'||v,'I'||v,1041,1050 FROM generate_series(0,119) v`);
      await pool().query(`INSERT INTO epoch_validator_stats(epoch,vote_pubkey,identity_pubkey,
        slots_assigned,slots_updated_at,fees_updated_at,tips_updated_at,
        block_fees_total_lamports,block_tips_total_lamports)
        SELECT e,'V'||v,'I'||v,10000,NOW(),NOW(),NOW(),(v+1)*100000,100
        FROM generate_series(1041,1050) e CROSS JOIN generate_series(0,119) v`);
      await pool().query(`INSERT INTO processed_blocks(epoch,slot,leader_identity,fees_lamports,
        block_status,compute_units_consumed)
        SELECT 1041+(n%10),n,'I'||(n%150),1,
          CASE WHEN n%13=0 THEN 'skipped' ELSE 'produced' END,(n%100)*1000000
        FROM generate_series(1,20000) n`);
      await pool().query('ANALYZE epoch_validator_stats');
      await pool().query('ANALYZE validator_profiles');
      await pool().query('ANALYZE processed_blocks');
    });

    it('joins identities with a hash and visits each block partition once on PostgreSQL 16', async () => {
      await compare('V7');
      let sql = '';
      const marker = new Error('capture SQL');
      const captureRepo = new StatsRepository({
        query: async (text: string) => {
          sql = text;
          throw marker;
        },
      } as unknown as pg.Pool);
      await expect(captureRepo.findEconomicPercentile('V7', FROM, TO)).rejects.toBe(marker);
      const { rows } = await pool().query<{
        'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[];
      }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${sql}`, [FROM, TO, 'V7']);
      const plan = rows[0]?.['QUERY PLAN'][0];
      if (!plan) throw new Error('Missing execution plan');
      const nodes = planNodes(plan.Plan);
      expect(
        nodes.some(
          (node) =>
            node['Node Type'] === 'Hash Join' && node['Hash Cond']?.includes('leader_identity'),
        ),
      ).toBe(true);
      const scans = nodes.filter((node) => node['Relation Name']?.startsWith('processed_blocks'));
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) expect(scan['Actual Loops']).toBe(1);
      console.info('economic-percentile PG16 synthetic plan', {
        executionMs: plan['Execution Time'],
        blockScans: scans.map((scan) => ({
          relation: scan['Relation Name'],
          loops: scan['Actual Loops'],
        })),
      });
    });
  });
});
