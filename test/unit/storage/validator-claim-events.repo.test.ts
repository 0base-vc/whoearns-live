import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_EVENTS_DEFAULT_LIMIT,
  CLAIM_EVENTS_MAX_LIMIT,
  ValidatorClaimEventsRepository,
} from '../../../src/storage/repositories/validator-claim-events.repo.js';

/**
 * Minimal capturing fake for `pg.Pool` — same pattern as
 * `simd-proposals.repo.test.ts`. The validator-claim-events repo only
 * ever calls `pool.query(sql, params)`, so we record every call and
 * return a canned result. Lets the append / listByVote SQL + param
 * logic be unit-tested without a live Postgres (the repo otherwise
 * only has Docker-backed integration coverage via migrations.test.ts).
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

function makeRepo(): { repo: ValidatorClaimEventsRepository; pool: FakePool } {
  const pool = new FakePool();
  const repo = new ValidatorClaimEventsRepository(pool as unknown as pg.Pool);
  return { repo, pool };
}

const VOTE = 'Vote111111111111111111111111111111111111111';
const IDENTITY = 'Node111111111111111111111111111111111111111';
const PRIOR_IDENTITY = 'Node222222222222222222222222222222222222222';

describe('ValidatorClaimEventsRepository — append', () => {
  let repo: ValidatorClaimEventsRepository;
  let pool: FakePool;
  beforeEach(() => {
    ({ repo, pool } = makeRepo());
  });

  it('issues a pure INSERT — no ON CONFLICT / UPDATE (append-only)', async () => {
    await repo.append({
      votePubkey: VOTE,
      eventType: 'claim',
      identityPubkey: IDENTITY,
    });
    const { sql } = pool.last;
    expect(sql).toMatch(/INSERT INTO validator_claim_events/);
    // The table is append-only — the write path must never UPDATE or
    // upsert a past row.
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).not.toMatch(/UPDATE/i);
  });

  it('writes the core columns in order; detail is cast ::jsonb', async () => {
    await repo.append({
      votePubkey: VOTE,
      eventType: 'wallet_register',
      identityPubkey: IDENTITY,
      detail: { walletPubkey: 'W', label: 'cold' },
      submittedIp: '203.0.113.7',
    });
    const { sql, params } = pool.last;
    // `detail` is JSONB — written as a JSON string param cast `::jsonb`,
    // not a bare JS object (which `pg` would encode as a composite).
    expect(sql).toMatch(/\$5::jsonb/);
    expect(params[0]).toBe(VOTE);
    expect(params[1]).toBe('wallet_register');
    expect(params[2]).toBe(IDENTITY);
    expect(params[3]).toBeNull(); // priorIdentityPubkey omitted
    expect(params[4]).toBe(JSON.stringify({ walletPubkey: 'W', label: 'cold' }));
    expect(params[5]).toBe('203.0.113.7');
  });

  it('passes priorIdentityPubkey through for an identity-rotation reclaim', async () => {
    await repo.append({
      votePubkey: VOTE,
      eventType: 'reclaim',
      identityPubkey: IDENTITY,
      priorIdentityPubkey: PRIOR_IDENTITY,
      submittedIp: '203.0.113.7',
    });
    expect(pool.last.params[3]).toBe(PRIOR_IDENTITY);
  });

  it('nulls absent optional fields (detail, submittedIp, priorIdentity)', async () => {
    await repo.append({
      votePubkey: VOTE,
      eventType: 'profile_update',
      identityPubkey: IDENTITY,
    });
    const { params } = pool.last;
    expect(params[3]).toBeNull(); // priorIdentityPubkey
    expect(params[4]).toBeNull(); // detail
    expect(params[5]).toBeNull(); // submittedIp
  });

  it('passes an explicit null identityPubkey straight through', async () => {
    await repo.append({
      votePubkey: VOTE,
      eventType: 'claim',
      identityPubkey: null,
    });
    expect(pool.last.params[2]).toBeNull();
  });
});

describe('ValidatorClaimEventsRepository — listByVote', () => {
  let repo: ValidatorClaimEventsRepository;
  let pool: FakePool;
  beforeEach(() => {
    ({ repo, pool } = makeRepo());
  });

  it('queries newest-first for the given vote pubkey', async () => {
    await repo.listByVote(VOTE);
    const { sql, params } = pool.last;
    expect(sql).toMatch(/FROM validator_claim_events/);
    expect(sql).toMatch(/WHERE vote_pubkey = \$1/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params[0]).toBe(VOTE);
  });

  it('defaults the limit to CLAIM_EVENTS_DEFAULT_LIMIT', async () => {
    await repo.listByVote(VOTE);
    expect(pool.last.params[1]).toBe(CLAIM_EVENTS_DEFAULT_LIMIT);
  });

  it('clamps an over-large limit to CLAIM_EVENTS_MAX_LIMIT', async () => {
    await repo.listByVote(VOTE, CLAIM_EVENTS_MAX_LIMIT + 5_000);
    expect(pool.last.params[1]).toBe(CLAIM_EVENTS_MAX_LIMIT);
  });

  it('clamps a zero / negative limit up to 1', async () => {
    await repo.listByVote(VOTE, 0);
    expect(pool.last.params[1]).toBe(1);
    await repo.listByVote(VOTE, -10);
    expect(pool.last.params[1]).toBe(1);
  });

  it('maps a row — including the pre-parsed JSONB detail object', async () => {
    pool.nextRows = [
      {
        id: '42',
        vote_pubkey: VOTE,
        event_type: 'github_link',
        identity_pubkey: IDENTITY,
        prior_identity_pubkey: null,
        // JSONB column: `pg` returns the already-parsed object, NOT a
        // JSON string — the FakePool row mirrors that shape.
        detail: { githubUsername: 'alice', priorGithubUsername: null },
        submitted_ip: '203.0.113.7',
        created_at: new Date('2026-05-14T00:00:00Z'),
      },
    ];
    const [event] = await repo.listByVote(VOTE);
    expect(event).toBeDefined();
    // BIGSERIAL id arrives as a string from `pg`; the repo coerces it.
    expect(event!.id).toBe(42);
    expect(event!.eventType).toBe('github_link');
    expect(event!.identityPubkey).toBe(IDENTITY);
    expect(event!.priorIdentityPubkey).toBeNull();
    expect(event!.detail).toEqual({ githubUsername: 'alice', priorGithubUsername: null });
    expect(event!.submittedIp).toBe('203.0.113.7');
  });

  it('collapses a non-object JSONB detail value to null', async () => {
    pool.nextRows = [
      {
        id: '7',
        vote_pubkey: VOTE,
        event_type: 'claim',
        identity_pubkey: IDENTITY,
        prior_identity_pubkey: null,
        // A JSON array (or scalar) is technically storable — the repo
        // narrows to plain-object-or-null so the typed contract holds.
        detail: ['not', 'an', 'object'],
        submitted_ip: null,
        created_at: new Date('2026-05-14T00:00:00Z'),
      },
    ];
    const [event] = await repo.listByVote(VOTE);
    expect(event!.detail).toBeNull();
  });
});
