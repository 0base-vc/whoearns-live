import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import { setupPgFixture, teardownPgFixture, resetTables, type PgFixture } from './_pg-fixture.js';

describe('ValidatorsRepository', () => {
  let fixture: PgFixture | undefined;
  let repo: ValidatorsRepository;

  beforeAll(async () => {
    fixture = await setupPgFixture();
    repo = new ValidatorsRepository(fixture.pool);
  }, 120_000);

  afterAll(async () => {
    await teardownPgFixture(fixture);
  });

  beforeEach(async () => {
    if (fixture) await resetTables(fixture.pool);
  });

  it('upsert: inserts a new row', async () => {
    await repo.upsert({
      votePubkey: 'VoteA',
      identityPubkey: 'IdA',
      firstSeenEpoch: 100,
      lastSeenEpoch: 100,
    });
    const found = await repo.findByVote('VoteA');
    expect(found).not.toBeNull();
    expect(found!.identityPubkey).toBe('IdA');
    expect(found!.firstSeenEpoch).toBe(100);
    expect(found!.lastSeenEpoch).toBe(100);
    expect(found!.updatedAt).toBeInstanceOf(Date);
  });

  it('upsert: updates identity and advances lastSeenEpoch with GREATEST', async () => {
    await repo.upsert({
      votePubkey: 'VoteA',
      identityPubkey: 'IdA',
      firstSeenEpoch: 100,
      lastSeenEpoch: 100,
    });
    // Advance with a new identity (identity rotation is legal).
    await repo.upsert({
      votePubkey: 'VoteA',
      identityPubkey: 'IdA2',
      firstSeenEpoch: 100,
      lastSeenEpoch: 105,
    });
    const f1 = await repo.findByVote('VoteA');
    expect(f1!.identityPubkey).toBe('IdA2');
    expect(f1!.lastSeenEpoch).toBe(105);

    // Out-of-order write with a smaller lastSeenEpoch must NOT rewind it.
    await repo.upsert({
      votePubkey: 'VoteA',
      identityPubkey: 'IdA2',
      firstSeenEpoch: 100,
      lastSeenEpoch: 102,
    });
    const f2 = await repo.findByVote('VoteA');
    expect(f2!.lastSeenEpoch).toBe(105);
  });

  it('findByVote: returns null for unknown vote', async () => {
    const v = await repo.findByVote('unknown');
    expect(v).toBeNull();
  });

  it('findManyByVotes: returns empty array when votes is empty', async () => {
    const vs = await repo.findManyByVotes([]);
    expect(vs).toEqual([]);
  });

  it('findManyByVotes: returns multiple matches', async () => {
    await repo.upsert({
      votePubkey: 'V1',
      identityPubkey: 'I1',
      firstSeenEpoch: 1,
      lastSeenEpoch: 1,
    });
    await repo.upsert({
      votePubkey: 'V2',
      identityPubkey: 'I2',
      firstSeenEpoch: 2,
      lastSeenEpoch: 2,
    });
    await repo.upsert({
      votePubkey: 'V3',
      identityPubkey: 'I3',
      firstSeenEpoch: 3,
      lastSeenEpoch: 3,
    });
    const vs = await repo.findManyByVotes(['V1', 'V3', 'does-not-exist']);
    const votes = vs.map((v) => v.votePubkey).sort();
    expect(votes).toEqual(['V1', 'V3']);
  });

  it('getIdentityByVote: returns identity', async () => {
    await repo.upsert({
      votePubkey: 'VoteA',
      identityPubkey: 'IdA',
      firstSeenEpoch: 1,
      lastSeenEpoch: 1,
    });
    expect(await repo.getIdentityByVote('VoteA')).toBe('IdA');
    expect(await repo.getIdentityByVote('nope')).toBeNull();
  });

  it('getIdentitiesForVotes: returns a map', async () => {
    await repo.upsert({
      votePubkey: 'V1',
      identityPubkey: 'I1',
      firstSeenEpoch: 1,
      lastSeenEpoch: 1,
    });
    await repo.upsert({
      votePubkey: 'V2',
      identityPubkey: 'I2',
      firstSeenEpoch: 2,
      lastSeenEpoch: 2,
    });

    const map = await repo.getIdentitiesForVotes(['V1', 'V2', 'missing']);
    expect(map.size).toBe(2);
    expect(map.get('V1')).toBe('I1');
    expect(map.get('V2')).toBe('I2');
    expect(map.has('missing')).toBe(false);
  });

  it('getIdentitiesForVotes: empty input returns empty map', async () => {
    const map = await repo.getIdentitiesForVotes([]);
    expect(map.size).toBe(0);
  });
});
