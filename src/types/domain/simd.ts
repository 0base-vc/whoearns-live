/**
 * SIMD (Solana Improvement Document) domain types — the Phase 5 tracked
 * proposals with AI curation, and the Phase 6 GitHub Discussions
 * comment mirror that feeds the governance score.
 */

/**
 * Phase 6 — one ingested GitHub Discussions comment on a SIMD
 * thread (Giscus backend on simd.watch). Used by the governance
 * score to attribute discussion participation back to claimed
 * validators via the `validator_github.github_username` mapping.
 */
export interface SimdDiscussionComment {
  discussionNumber: number;
  commentId: string;
  githubUsername: string;
  /**
   * Sum of EVERY GitHub user's positive reactions on the comment
   * (THUMBS_UP + HEART + ROCKET + HOORAY). Honest all-users total —
   * NOT the value the OAI governance score consumes (SEC-M5).
   */
  totalReactionsCount: number;
  /**
   * Subset of `totalReactionsCount` from GitHub users linked to a
   * claimed validator (`validator_github`). This is the
   * peer-validator count the OAI governance score actually uses —
   * resistant to reaction-bot inflation. Computed by the (unshipped)
   * GitHub Discussions ingester via a JOIN at ingest time; `0`
   * everywhere until that ingester runs.
   */
  peerReactionsCount: number;
  activeWindow: boolean;
  createdAt: Date;
  ingestedAt: Date;
}

/**
 * Phase 5 — one tracked SIMD (Solana Improvement Document) with
 * optional AI curation (summary + discussion questions). Pre-review
 * rows are NOT exposed via the public API; only the row's
 * `simd_number`, `title`, `status`, `source_url`, and review state
 * are routinely surfaced. AI fields ship after a human reviewer
 * signs off.
 */
export interface SimdProposal {
  simdNumber: number;
  title: string;
  status: string;
  sourceUrl: string;
  bodySha256: string | null;
  aiSummary: string | null;
  aiQuestions: string[] | null;
  aiGeneratedAt: Date | null;
  /**
   * The `bodySha256` value the current AI curation was generated
   * against (AI-3). When this differs from `bodySha256` the upstream
   * proposal text has changed since the model last saw it, so the
   * row is eligible for re-curation. `null` for rows that have never
   * been curated.
   */
  aiBodySha256: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  /**
   * Optional free-text note the reviewer recorded when approving the
   * curation (AI-4) — e.g. "summary slightly understates the
   * compute-budget impact, acceptable" or "re-reviewed after body
   * drift". Capped at 280 chars by a DB CHECK. Internal audit field;
   * NOT surfaced on the public `/v1/simd-proposals` endpoint.
   */
  reviewerNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}
