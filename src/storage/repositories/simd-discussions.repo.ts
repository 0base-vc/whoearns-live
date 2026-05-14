import type pg from 'pg';
import type { SimdDiscussionComment } from '../../types/domain.js';

interface SimdDiscussionCommentRow {
  discussion_number: number;
  comment_id: string;
  github_username: string;
  reactions_count: number;
  active_window: boolean;
  created_at: Date;
  ingested_at: Date;
}

function rowToComment(row: SimdDiscussionCommentRow): SimdDiscussionComment {
  return {
    discussionNumber: row.discussion_number,
    commentId: row.comment_id,
    githubUsername: row.github_username,
    reactionsCount: row.reactions_count,
    activeWindow: row.active_window,
    createdAt: row.created_at,
    ingestedAt: row.ingested_at,
  };
}

export interface SimdDiscussionCommentUpsert {
  discussionNumber: number;
  commentId: string;
  githubUsername: string;
  reactionsCount: number;
  activeWindow: boolean;
  createdAt: Date;
}

export interface PerUsernameStats {
  githubUsername: string;
  commentCount: number;
  reactionsReceived: number;
  /** Subset of `commentCount` posted on active-window discussions. */
  activeWindowCount: number;
}

export class SimdDiscussionsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Batch-upsert comments observed in one ingest tick. Existing rows
   * are updated with the latest reactions_count + active_window flag
   * — comments don't have a write-once contract on GitHub
   * (reactions accumulate, the parent discussion's lifecycle can
   * shift "active_window" from true to false).
   */
  async upsertBatch(comments: ReadonlyArray<SimdDiscussionCommentUpsert>): Promise<number> {
    if (comments.length === 0) return 0;
    const discussionNumbers = comments.map((c) => c.discussionNumber);
    const commentIds = comments.map((c) => c.commentId);
    const usernames = comments.map((c) => c.githubUsername);
    const reactions = comments.map((c) => c.reactionsCount);
    const actives = comments.map((c) => c.activeWindow);
    const createdAts = comments.map((c) => c.createdAt.toISOString());

    const { rowCount } = await this.pool.query(
      `INSERT INTO simd_discussion_comments
         (discussion_number, comment_id, github_username,
          reactions_count, active_window, created_at, ingested_at)
       SELECT v.discussion_number::int, v.comment_id, v.github_username,
              v.reactions_count::int, v.active_window::boolean,
              v.created_at::timestamptz, NOW()
         FROM UNNEST(
           $1::int[], $2::text[], $3::text[],
           $4::int[], $5::boolean[], $6::text[]
         ) AS v(discussion_number, comment_id, github_username,
                reactions_count, active_window, created_at)
       ON CONFLICT (discussion_number, comment_id) DO UPDATE
         SET reactions_count = EXCLUDED.reactions_count,
             active_window   = EXCLUDED.active_window,
             ingested_at     = NOW()`,
      [discussionNumbers, commentIds, usernames, reactions, actives, createdAts],
    );
    return rowCount ?? 0;
  }

  /**
   * Per-username comment count + reactions sum for the last `days`
   * (default 180). Used to compute the governance subcomponent of
   * the Operator Activity Index.
   */
  async statsByUsername(usernames: ReadonlyArray<string>, days = 180): Promise<PerUsernameStats[]> {
    if (usernames.length === 0) return [];
    const safeDays = Math.max(1, Math.min(days, 365));
    const lowered = usernames.map((u) => u.toLowerCase());
    const { rows } = await this.pool.query<{
      github_username: string;
      comment_count: string;
      reactions_received: string;
      active_window_count: string;
    }>(
      `SELECT LOWER(github_username) AS github_username,
              COUNT(*)::text AS comment_count,
              COALESCE(SUM(reactions_count), 0)::text AS reactions_received,
              COUNT(*) FILTER (WHERE active_window)::text AS active_window_count
         FROM simd_discussion_comments
        WHERE LOWER(github_username) = ANY($1::text[])
          AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY LOWER(github_username)`,
      [lowered, safeDays],
    );
    return rows.map((r) => ({
      githubUsername: r.github_username,
      commentCount: Number(r.comment_count),
      reactionsReceived: Number(r.reactions_received),
      activeWindowCount: Number(r.active_window_count),
    }));
  }

  /**
   * True once the table holds at least one ingested comment. The
   * GitHub Discussions ingest job that feeds this table is unshipped
   * (see `docs/scoring.md` Phase 6+7 — "NOT yet live"), so in every
   * real deployment today this returns `false`. The OAI route uses it
   * to distinguish "the governance ingest hasn't run" (report
   * `governance.score: null`) from "linked but genuinely has no
   * comments" — a `0` would conflate the two. Whatever first writes
   * rows (the ingest job, a backfill) flips the signal; deliberately
   * NOT keyed on an `ingestion_cursors` job-name string so it needs
   * no coordination with the still-unwritten job.
   *
   * `LIMIT 1` so Postgres can stop at the first row instead of
   * counting the whole table.
   */
  async hasAnyData(): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM simd_discussion_comments) AS exists`,
    );
    return rows[0]?.exists ?? false;
  }

  async listRecentByUsername(username: string, limit = 50): Promise<SimdDiscussionComment[]> {
    const safe = Math.max(1, Math.min(limit, 200));
    const { rows } = await this.pool.query<SimdDiscussionCommentRow>(
      `SELECT discussion_number, comment_id, github_username,
              reactions_count, active_window, created_at, ingested_at
         FROM simd_discussion_comments
        WHERE LOWER(github_username) = LOWER($1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [username, safe],
    );
    return rows.map(rowToComment);
  }
}
