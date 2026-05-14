import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  REVIEWER_NOTE_MAX_CHARS,
  SimdProposalsRepository,
} from '../../../src/storage/repositories/simd-proposals.repo.js';

/**
 * Minimal capturing fake for `pg.Pool`. The simd-proposals repo only
 * ever calls `pool.query(sql, params)`, so we record every call and
 * return a canned result. This lets the AI-3 / AI-4 query + param
 * logic be unit-tested without a live Postgres (the repos otherwise
 * only have Docker-backed integration coverage).
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

function makeRepo(): { repo: SimdProposalsRepository; pool: FakePool } {
  const pool = new FakePool();
  const repo = new SimdProposalsRepository(pool as unknown as pg.Pool);
  return { repo, pool };
}

describe('SimdProposalsRepository — AI-3 body-drift', () => {
  let repo: SimdProposalsRepository;
  let pool: FakePool;
  beforeEach(() => {
    ({ repo, pool } = makeRepo());
  });

  it('listNeedingCuration picks up never-curated AND body-drifted rows', async () => {
    await repo.listNeedingCuration(5);
    const { sql } = pool.last;
    // Never-curated case.
    expect(sql).toMatch(/ai_generated_at IS NULL/);
    // Body-drift case — must use IS DISTINCT FROM so a NULL
    // ai_body_sha256 against a non-NULL body_sha256 still compares.
    expect(sql).toMatch(/ai_body_sha256 IS DISTINCT FROM body_sha256/);
  });

  it('setAiCuration stamps ai_body_sha256 from the row’s current body_sha256', async () => {
    await repo.setAiCuration({
      simdNumber: 42,
      aiSummary: 'neutral summary',
      aiQuestions: ['Q: a', 'Q: b', 'Q: c'],
    });
    const { sql, params } = pool.last;
    // The stamp is read from the row itself, never passed by the
    // caller — so it can't drift from what's actually stored.
    expect(sql).toMatch(/ai_body_sha256\s*=\s*body_sha256/);
    // Re-curation demotes the row back to needs-review.
    expect(sql).toMatch(/reviewed_at\s*=\s*NULL/);
    expect(sql).toMatch(/reviewer_note\s*=\s*NULL/);
    // `ai_questions` is JSONB (0031) — written as a JSON string param
    // cast `::jsonb`, not a bare Postgres array literal.
    expect(sql).toMatch(/ai_questions\s*=\s*\$3::jsonb/);
    expect(params[0]).toBe(42);
    expect(params[1]).toBe('neutral summary');
    expect(params[2]).toBe(JSON.stringify(['Q: a', 'Q: b', 'Q: c']));
  });

  it('maps ai_body_sha256 + reviewer_note when reading a row', async () => {
    pool.nextRows = [
      {
        simd_number: 7,
        title: 'T',
        status: 'review',
        source_url: 'https://example.test/0007.md',
        body_sha256: 'newhash',
        ai_summary: 's',
        // JSONB column (0031): `pg` returns the already-parsed array,
        // NOT a JSON string — the FakePool row mirrors that shape.
        ai_questions: ['Q: x', 'Q: y', 'Q: z'],
        ai_generated_at: new Date('2026-01-01T00:00:00Z'),
        ai_body_sha256: 'oldhash',
        reviewed_at: null,
        reviewed_by: null,
        reviewer_note: 'looked fine',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    const proposal = await repo.findByNumber(7);
    expect(proposal).not.toBeNull();
    expect(proposal!.aiBodySha256).toBe('oldhash');
    expect(proposal!.bodySha256).toBe('newhash');
    expect(proposal!.reviewerNote).toBe('looked fine');
    // Round-trips the parsed JSONB array through the string narrowing.
    expect(proposal!.aiQuestions).toEqual(['Q: x', 'Q: y', 'Q: z']);
  });

  it('reads ai_questions back as null when the JSONB value is NULL', async () => {
    pool.nextRows = [
      {
        simd_number: 8,
        title: 'T',
        status: 'review',
        source_url: 'https://example.test/0008.md',
        body_sha256: 'h',
        ai_summary: null,
        ai_questions: null,
        ai_generated_at: null,
        ai_body_sha256: null,
        reviewed_at: null,
        reviewed_by: null,
        reviewer_note: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    const proposal = await repo.findByNumber(8);
    expect(proposal).not.toBeNull();
    expect(proposal!.aiQuestions).toBeNull();
  });
});

describe('SimdProposalsRepository — AI-4 reviewer note', () => {
  let repo: SimdProposalsRepository;
  let pool: FakePool;
  beforeEach(() => {
    ({ repo, pool } = makeRepo());
  });

  it('passes a normal note through trimmed', async () => {
    await repo.markReviewed(1, 'reviewer@x', '  summary understates CU impact, acceptable  ');
    expect(pool.last.params[2]).toBe('summary understates CU impact, acceptable');
  });

  it('clamps an over-length note to REVIEWER_NOTE_MAX_CHARS', async () => {
    const long = 'x'.repeat(REVIEWER_NOTE_MAX_CHARS + 50);
    await repo.markReviewed(1, 'reviewer@x', long);
    const note = pool.last.params[2] as string;
    expect(note.length).toBe(REVIEWER_NOTE_MAX_CHARS);
  });

  it('stores null for an omitted note', async () => {
    await repo.markReviewed(1, 'reviewer@x');
    expect(pool.last.params[2]).toBeNull();
  });

  it('stores null for a whitespace-only note', async () => {
    await repo.markReviewed(1, 'reviewer@x', '   \n  ');
    expect(pool.last.params[2]).toBeNull();
  });

  it('still writes reviewer + timestamp regardless of note', async () => {
    await repo.markReviewed(99, 'reviewer@x');
    const { sql, params } = pool.last;
    expect(sql).toMatch(/reviewed_at\s*=\s*NOW\(\)/);
    expect(params[0]).toBe(99);
    expect(params[1]).toBe('reviewer@x');
  });
});
