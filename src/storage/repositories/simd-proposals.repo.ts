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
  reviewed_at: Date | null;
  reviewed_by: string | null;
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
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLS = `simd_number, title, status, source_url, body_sha256,
  ai_summary, ai_questions, ai_generated_at, reviewed_at, reviewed_by,
  created_at, updated_at`;

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

  /** Record an AI-generated summary + questions; resets reviewer state. */
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
              reviewed_at      = NULL,
              reviewed_by      = NULL,
              updated_at       = NOW()
        WHERE simd_number = $1`,
      [args.simdNumber, args.aiSummary, JSON.stringify(args.aiQuestions)],
    );
  }

  async markReviewed(simdNumber: number, reviewer: string): Promise<void> {
    await this.pool.query(
      `UPDATE simd_proposals
          SET reviewed_at = NOW(),
              reviewed_by = $2,
              updated_at  = NOW()
        WHERE simd_number = $1`,
      [simdNumber, reviewer],
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

  /** Rows that need AI curation (no AI output yet OR body changed since AI). */
  async listNeedingCuration(limit = 10): Promise<SimdProposal[]> {
    const safe = Math.max(1, Math.min(limit, 100));
    const { rows } = await this.pool.query<SimdProposalRow>(
      `SELECT ${COLS}
         FROM simd_proposals
        WHERE ai_generated_at IS NULL
        ORDER BY simd_number DESC
        LIMIT $1`,
      [safe],
    );
    return rows.map(rowToProposal);
  }
}
