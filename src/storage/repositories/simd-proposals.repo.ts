import type pg from 'pg';
import type { SimdProposal } from '../../types/domain.js';

/**
 * Strip the same unsafe codepoints the curation-output parser rejects:
 * C0/C1 control characters (except TAB/LF/CR, which are legitimate)
 * and the Unicode text-direction-override block (U+202A-U+202E,
 * U+2066-U+2069). Applied to `title` + `status` on `upsertSource`
 * because those flow straight from a third-party SIMD PR into the
 * hub `SimdProposalCard` — the only filter previously was a 400-char
 * trim, which left BiDi-override smuggling open.
 *
 * Trims surrounding whitespace as a courtesy; the caller still
 * clamps length downstream.
 */
/* eslint-disable no-control-regex -- intentional C0/C1 + BiDi-override strip */
const UNSAFE_CHARS_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

function stripUnsafeChars(raw: string): string {
  return raw.replace(UNSAFE_CHARS_RE, '').trim();
}

interface SimdProposalRow {
  simd_number: number;
  title: string;
  status: string;
  source_url: string;
  body_sha256: string | null;
  ai_summary: string | null;
  // `ai_questions` is a JSONB column (migration 0031) — `pg` returns
  // the already-parsed value, so this is `unknown[] | null` here, not
  // the raw JSON string the pre-0031 TEXT column produced. A DB CHECK
  // (`jsonb_typeof = 'array'`) guarantees array-or-NULL, but we still
  // narrow defensively in `rowToProposal` rather than trusting the
  // shape blindly.
  ai_questions: unknown[] | null;
  ai_generated_at: Date | null;
  ai_body_sha256: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  reviewer_note: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToProposal(row: SimdProposalRow): SimdProposal {
  // `ai_questions` arrives pre-parsed from the JSONB column (0031).
  // The DB CHECK enforces array-or-NULL, but a row could still hold a
  // non-string element if something wrote one before the CHECK
  // existed — keep the per-element string narrowing so the typed
  // `string[] | null` contract holds. No try/catch needed: there is
  // no JSON string to parse, so the old "corrupt JSON silently reads
  // back as null" failure mode is gone.
  let aiQuestions: string[] | null = null;
  if (Array.isArray(row.ai_questions) && row.ai_questions.every((q) => typeof q === 'string')) {
    aiQuestions = row.ai_questions as string[];
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

/**
 * Title length cap (SEC-M3). Mirrors the
 * `chk_simd_proposals_title_length` DB CHECK from migration 0032.
 * `title` originates from a third-party SIMD PR and flows verbatim
 * into the Anthropic curation user message — an unbounded,
 * instruction-shaped title is both a prompt-injection surface and a
 * token-cost surface. The curation *body* was already bounded at
 * 10 KB by a prior pass; this closes the title gap. Clamped
 * defensively here (same pattern as `REVIEWER_NOTE_MAX_CHARS`) so a
 * slightly-over caller never trips the constraint.
 */
export const SIMD_TITLE_MAX_CHARS = 400;

/**
 * Reviewer-identifier length cap (AI-M7). `markReviewed` accepts a
 * free-form `reviewer` string today — there is no admin route yet to
 * impose a structured `prefix:value` scheme, so the only contract is
 * "a sane bounded identifier": non-empty, no control chars, trimmed,
 * and short enough that it can't itself become an injection / bloat
 * surface in `reviewed_by`. 64 chars comfortably fits an email, a
 * GitHub handle, or a `team:name` style id.
 */
export const REVIEWER_MAX_CHARS = 64;

/**
 * Validate + normalise a `reviewer` identifier for `markReviewed`
 * (AI-M7). Trims surrounding whitespace, then rejects:
 *   - empty / whitespace-only input (no anonymous reviews);
 *   - anything longer than `REVIEWER_MAX_CHARS`;
 *   - C0/C1 control characters (U+0000-U+001F, U+007F-U+009F)
 *     — invisible payload smuggling into the audit column.
 * Throws a clear `Error` on invalid input; returns the trimmed value
 * otherwise.
 */
function normaliseReviewer(reviewer: string): string {
  const trimmed = reviewer.trim();
  if (trimmed === '') {
    throw new Error('markReviewed: reviewer must be a non-empty identifier');
  }
  if (trimmed.length > REVIEWER_MAX_CHARS) {
    throw new Error(
      `markReviewed: reviewer must be <= ${REVIEWER_MAX_CHARS} chars (got ${trimmed.length})`,
    );
  }
  // eslint-disable-next-line no-control-regex -- intentional C0/C1 rejection
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new Error('markReviewed: reviewer must not contain control characters');
  }
  return trimmed;
}

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
   *
   * `title` and `status` come from a third-party SIMD PR and render
   * into the hub `SimdProposalCard`. Two stripping passes apply:
   *   - clamp to `SIMD_TITLE_MAX_CHARS` (DB CHECK + curation-prompt
   *     bound)
   *   - strip Unicode text-direction-override + C0/C1 control
   *     codepoints. Without this filter a malicious PR title with
   *     embedded U+202E can right-to-left-flip surrounding hub
   *     card chrome in a phishing-friendly way — same posture
   *     migration 0035 takes for `narrativeOverride`.
   */
  async upsertSource(input: SimdProposalUpsert): Promise<void> {
    const safeTitle = stripUnsafeChars(input.title).slice(0, SIMD_TITLE_MAX_CHARS);
    const safeStatus = stripUnsafeChars(input.status).slice(0, 64);
    await this.pool.query(
      `INSERT INTO simd_proposals (simd_number, title, status, source_url, body_sha256)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (simd_number) DO UPDATE
         SET title       = EXCLUDED.title,
             status      = EXCLUDED.status,
             source_url  = EXCLUDED.source_url,
             body_sha256 = EXCLUDED.body_sha256,
             updated_at  = NOW()`,
      [input.simdNumber, safeTitle, safeStatus, input.sourceUrl, input.bodySha256],
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
    // `ai_questions` is JSONB (migration 0031). The idiomatic pg-node
    // path is `JSON.stringify` the array and cast the text param
    // `::jsonb` — passing the JS array bare would make `pg` encode it
    // as a Postgres ARRAY literal, not JSON. The `::jsonb` cast also
    // means a malformed value would fail the write loudly rather than
    // being stored and silently read back as null.
    await this.pool.query(
      `UPDATE simd_proposals
          SET ai_summary       = $2,
              ai_questions     = $3::jsonb,
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
   *
   * `reviewer` is validated via `normaliseReviewer` (AI-M7): it must
   * be a non-empty, control-char-free identifier of at most
   * `REVIEWER_MAX_CHARS` chars. Invalid input throws before the
   * write — `reviewed_by` is an audit column and must not absorb
   * empty / oversized / payload-bearing strings.
   */
  async markReviewed(simdNumber: number, reviewer: string, note?: string): Promise<void> {
    const safeReviewer = normaliseReviewer(reviewer);
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
      [simdNumber, safeReviewer, safeNote],
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
