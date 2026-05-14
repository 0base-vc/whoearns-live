import type pg from 'pg';
import type { SimdProposal } from '../../types/domain.js';

interface SimdProposalRow {
  simd_number: number;
  title: string;
  status: string;
  source_url: string;
  body_sha256: string | null;
  ai_summary: string | null;
  ai_questions: string | null;
  ai_generated_at: Date | null;
  ai_body_sha256: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  reviewer_note: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToProposal(row: SimdProposalRow): SimdProposal {
  let aiQuestions: string[] | null = null;
  if (row.ai_questions !== null) {
    try {
      const parsed: unknown = JSON.parse(row.ai_questions);
      if (Array.isArray(parsed) && parsed.every((q) => typeof q === 'string')) {
        aiQuestions = parsed;
      }
    } catch {
      // Corrupt JSON — keep aiQuestions null rather than crashing the
      // read path. The sync job will overwrite on next AI pass.
      aiQuestions = null;
    }
  }
  return {
    simdNumber: row.simd_number,
    title: row.title,
    status: row.status,
    sourceUrl: row.source_url,
    bodySha256: row.body_sha256,
    aiSummary: row.ai_summary,
    aiQuestions,
    aiGeneratedAt: row.ai_generated_at,
    aiBodySha256: row.ai_body_sha256,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewerNote: row.reviewer_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLS = `simd_number, title, status, source_url, body_sha256,
  ai_summary, ai_questions, ai_generated_at, ai_body_sha256,
  reviewed_at, reviewed_by, reviewer_note, created_at, updated_at`;

/**
 * Reviewer-note length cap (AI-4). Mirrors the
 * `chk_simd_proposals_reviewer_note_length` DB CHECK from migration
 * 0030 — kept in sync here so the repo can clamp defensively before
 * the write rather than surfacing a raw constraint violation.
 */
export const REVIEWER_NOTE_MAX_CHARS = 280;

export interface SimdProposalUpsert {
  simdNumber: number;
  title: string;
  status: string;
  sourceUrl: string;
  bodySha256: string;
}

export class SimdProposalsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Upsert the canonical fields from the GitHub mirror. AI fields and
   * the review state are LEFT UNTOUCHED — they're owned by separate
   * write paths (curation pipeline + manual review).
   */
  async upsertSource(input: SimdProposalUpsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO simd_proposals (simd_number, title, status, source_url, body_sha256)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (simd_number) DO UPDATE
         SET title       = EXCLUDED.title,
             status      = EXCLUDED.status,
             source_url  = EXCLUDED.source_url,
             body_sha256 = EXCLUDED.body_sha256,
             updated_at  = NOW()`,
      [input.simdNumber, input.title, input.status, input.sourceUrl, input.bodySha256],
    );
  }

  /**
   * Record an AI-generated summary + questions; resets reviewer state.
   *
   * `ai_body_sha256` is stamped with the row's CURRENT `body_sha256`
   * (AI-3) — pinning the curation to the exact proposal body the
   * model saw. A later upstream edit bumps `body_sha256`, the two
   * diverge, and `listNeedingCuration` picks the row up again. The
   * stamp is read from the row inside the UPDATE rather than passed
   * by the caller so it can never drift from what's actually stored.
   *
   * Re-curation always demotes the row back to needs-review:
   * `reviewed_at` / `reviewed_by` / `reviewer_note` are cleared.
   */
  async setAiCuration(args: {
    simdNumber: number;
    aiSummary: string;
    aiQuestions: readonly string[];
  }): Promise<void> {
    await this.pool.query(
      `UPDATE simd_proposals
          SET ai_summary       = $2,
              ai_questions     = $3,
              ai_generated_at  = NOW(),
              ai_body_sha256   = body_sha256,
              reviewed_at      = NULL,
              reviewed_by      = NULL,
              reviewer_note    = NULL,
              updated_at       = NOW()
        WHERE simd_number = $1`,
      [args.simdNumber, args.aiSummary, JSON.stringify(args.aiQuestions)],
    );
  }

  /**
   * Mark a curation human-reviewed. `note` (AI-4) is an optional
   * short free-text audit record of WHY the reviewer approved this
   * specific curation — capped at 280 chars by a DB CHECK; the repo
   * also trims + clamps defensively so a slightly-over caller can't
   * trip the constraint. Passing `undefined` leaves any prior note
   * untouched is NOT the behaviour — a fresh review writes a fresh
   * note, so `undefined` clears it (review state is per-approval).
   */
  async markReviewed(simdNumber: number, reviewer: string, note?: string): Promise<void> {
    const trimmed = note?.trim();
    const safeNote =
      trimmed === undefined || trimmed === '' ? null : trimmed.slice(0, REVIEWER_NOTE_MAX_CHARS);
    await this.pool.query(
      `UPDATE simd_proposals
          SET reviewed_at   = NOW(),
              reviewed_by   = $2,
              reviewer_note = $3,
              updated_at    = NOW()
        WHERE simd_number = $1`,
      [simdNumber, reviewer, safeNote],
    );
  }

  async findByNumber(simdNumber: number): Promise<SimdProposal | null> {
    const { rows } = await this.pool.query<SimdProposalRow>(
      `SELECT ${COLS} FROM simd_proposals WHERE simd_number = $1`,
      [simdNumber],
    );
    return rows[0] ? rowToProposal(rows[0]) : null;
  }

  /**
   * Reviewed proposals only, newest first, capped at `limit`. Used by
   * the public `/v1/simd-proposals` endpoint. Pre-review rows stay
   * hidden — see migration 0027 commentary.
   */
  async listReviewed(limit = 20): Promise<SimdProposal[]> {
    const safe = Math.max(1, Math.min(limit, 100));
    const { rows } = await this.pool.query<SimdProposalRow>(
      `SELECT ${COLS}
         FROM simd_proposals
        WHERE reviewed_at IS NOT NULL
        ORDER BY reviewed_at DESC, simd_number DESC
        LIMIT $1`,
      [safe],
    );
    return rows.map(rowToProposal);
  }

  /**
   * Rows that need AI curation. Two cases (AI-3):
   *   1. Never curated — `ai_generated_at IS NULL`.
   *   2. Body drifted — `ai_body_sha256 IS DISTINCT FROM body_sha256`,
   *      i.e. the upstream proposal text changed since the model last
   *      saw it. `IS DISTINCT FROM` (not `<>`) so a NULL on either
   *      side still compares correctly: a curated-but-unstamped row
   *      (NULL `ai_body_sha256`) against a non-NULL `body_sha256`
   *      reads as drifted and is re-curated once to establish the
   *      baseline.
   *
   * Backed by the partial index `idx_simd_proposals_needs_curation`
   * (migration 0030) whose predicate is exactly this WHERE clause.
   */
  async listNeedingCuration(limit = 10): Promise<SimdProposal[]> {
    const safe = Math.max(1, Math.min(limit, 100));
    const { rows } = await this.pool.query<SimdProposalRow>(
      `SELECT ${COLS}
         FROM simd_proposals
        WHERE ai_generated_at IS NULL
           OR ai_body_sha256 IS DISTINCT FROM body_sha256
        ORDER BY simd_number DESC
        LIMIT $1`,
      [safe],
    );
    return rows.map(rowToProposal);
  }
}
