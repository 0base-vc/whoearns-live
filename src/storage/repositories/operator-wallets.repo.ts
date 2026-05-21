import type pg from 'pg';
import type { OperatorWallet, VotePubkey } from '../../types/domain.js';

interface OperatorWalletRow {
  vote_pubkey: string;
  wallet_pubkey: string;
  label: string;
  signed_nonce: string;
  memo_tx_signature: string;
  registered_at: Date;
  expires_at: Date;
}

function rowToWallet(row: OperatorWalletRow): OperatorWallet {
  return {
    votePubkey: row.vote_pubkey,
    walletPubkey: row.wallet_pubkey,
    label: row.label,
    signedNonce: row.signed_nonce,
    memoTxSignature: row.memo_tx_signature,
    registeredAt: row.registered_at,
    expiresAt: row.expires_at,
  };
}

const COLS = `vote_pubkey, wallet_pubkey, label, signed_nonce,
  memo_tx_signature, registered_at, expires_at`;

export const OPERATOR_WALLET_CAP_PER_VALIDATOR = 3;

/**
 * Result of `OperatorWalletsRepository.insert` (TS-M6). The DB
 * constraint violations the route used to inspect by pg SQLSTATE
 * string — `23514` (the 3-wallet cap trigger) and `23505` (the
 * `signed_nonce` UNIQUE replay guard) — are caught HERE and surfaced
 * as a typed `reason`, so the route branches on a domain value with
 * no pg-errcode knowledge. Any other pg error still throws.
 */
export type OperatorWalletInsertResult =
  | { ok: true }
  | { ok: false; reason: 'wallet_cap_reached' | 'nonce_replay' };

export class OperatorWalletsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert a new operator wallet. The DB trigger enforces the 3-wallet
   * cap as defense-in-depth; the route layer should also count first
   * and surface a clean 409 before this fires.
   *
   * Returns a typed discriminated result rather than letting a raw pg
   * error escape (TS-M6): a `23514` check_violation (the cap trigger,
   * lost a race) maps to `wallet_cap_reached`, a `23505`
   * unique_violation (the only UNIQUE here is `signed_nonce`, added by
   * migration 0025) maps to `nonce_replay`. Matching by SQLSTATE code,
   * not message text, is robust to a migration reword. Any other pg
   * error is rethrown unchanged.
   */
  async insert(wallet: OperatorWallet): Promise<OperatorWalletInsertResult> {
    try {
      await this.pool.query(
        `INSERT INTO operator_wallets
           (vote_pubkey, wallet_pubkey, label, signed_nonce,
            memo_tx_signature, registered_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          wallet.votePubkey,
          wallet.walletPubkey,
          wallet.label,
          wallet.signedNonce,
          wallet.memoTxSignature,
          wallet.registeredAt,
          wallet.expiresAt,
        ],
      );
      return { ok: true };
    } catch (err) {
      const pgErr = err as { code?: string };
      // SQLSTATE 23514 = check_violation — the 3-wallet cap trigger
      // uses ERRCODE = 'check_violation'. Reaching here means the
      // route's count-first check lost a race against a concurrent
      // insert.
      if (pgErr.code === '23514') {
        return { ok: false, reason: 'wallet_cap_reached' };
      }
      // SQLSTATE 23505 = unique_violation — the only UNIQUE on this
      // table is `signed_nonce` (migration 0025), so this is a replay
      // of an already-accepted nonce.
      if (pgErr.code === '23505') {
        return { ok: false, reason: 'nonce_replay' };
      }
      throw err;
    }
  }

  async listByVote(vote: VotePubkey): Promise<OperatorWallet[]> {
    const { rows } = await this.pool.query<OperatorWalletRow>(
      `SELECT ${COLS} FROM operator_wallets
        WHERE vote_pubkey = $1
        ORDER BY registered_at ASC, wallet_pubkey ASC`,
      [vote],
    );
    return rows.map(rowToWallet);
  }

  /**
   * Active (not-expired) wallets only. Used by scoring routes that
   * must drop lapsed registrations from contributing signal.
   *
   * Ordered by `registered_at ASC` with a `wallet_pubkey ASC`
   * tiebreaker so two registrations landing in the same Postgres
   * millisecond don't flap order across requests — the
   * `/v1/claims/:vote.wallets.entries[]` shape relies on stable
   * ordering for cache validity.
   */
  async listActiveByVote(vote: VotePubkey): Promise<OperatorWallet[]> {
    const { rows } = await this.pool.query<OperatorWalletRow>(
      `SELECT ${COLS} FROM operator_wallets
        WHERE vote_pubkey = $1
          AND expires_at > NOW()
        ORDER BY registered_at ASC, wallet_pubkey ASC`,
      [vote],
    );
    return rows.map(rowToWallet);
  }

  /**
   * ACTIVE count for the per-validator cap check at the route layer.
   *
   * Counts only `expires_at > NOW()` rows — the cap is enforced over
   * ACTIVE registrations, not over the row lifetime. An operator whose
   * three 90-day registrations all lapsed has three free slots without
   * needing to call DELETE on each.
   *
   * Mirrors the BEFORE INSERT trigger installed by migration 0039 — the
   * route's fast-fail count + the DB defense-in-depth count must agree
   * on what "3" means, otherwise the trigger would raise
   * `check_violation` for a row the route already cleared (or vice
   * versa).
   */
  async countByVote(vote: VotePubkey): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM operator_wallets
        WHERE vote_pubkey = $1
          AND expires_at > NOW()`,
      [vote],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * All distinct ACTIVE (not-expired) registered wallet pubkeys. Used
   * by the Phase 4 activity indexer to enumerate the set to scan each
   * tick. Expired registrations silently drop out of the index set —
   * an operator who let their attestation lapse has implicitly opted
   * out of further activity harvesting.
   */
  async listAllDistinctWallets(): Promise<string[]> {
    const { rows } = await this.pool.query<{ wallet_pubkey: string }>(
      `SELECT DISTINCT wallet_pubkey
         FROM operator_wallets
        WHERE expires_at > NOW()
        ORDER BY wallet_pubkey`,
    );
    return rows.map((r) => r.wallet_pubkey);
  }

  /**
   * Existence check — true when the wallet is currently registered
   * AND not expired (same `expires_at > NOW()` gate as the other
   * ACTIVE reads).
   *
   * NOTE: the public per-wallet read endpoints this once backed were
   * removed (a URL keyed on the full operator-wallet pubkey is itself
   * information disclosure — wallet activity is now served inline on
   * `GET /v1/claims/:vote?includeActivity=1`). This method has no
   * remaining caller.
   */
  async existsActive(wallet: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM operator_wallets
          WHERE wallet_pubkey = $1
            AND expires_at > NOW()
       ) AS exists`,
      [wallet],
    );
    return rows[0]?.exists === true;
  }

  /**
   * Registration metadata for a single ACTIVE (not-expired) wallet.
   * Returns `null` when the wallet is unregistered OR its attestation
   * has lapsed (same `expires_at > NOW()` gate as `existsActive`). A
   * wallet pubkey is UNIQUE per registration in practice; `LIMIT 1`
   * is belt-and-braces.
   *
   * NOTE: the public `GET /v1/operator-wallets/:wallet` endpoint this
   * once backed was removed (a URL keyed on the full operator-wallet
   * pubkey is itself information disclosure). This method has no
   * remaining caller.
   */
  async findActiveByWallet(wallet: string): Promise<OperatorWallet | null> {
    const { rows } = await this.pool.query<OperatorWalletRow>(
      `SELECT ${COLS} FROM operator_wallets
        WHERE wallet_pubkey = $1
          AND expires_at > NOW()
        ORDER BY registered_at ASC
        LIMIT 1`,
      [wallet],
    );
    const row = rows[0];
    return row === undefined ? null : rowToWallet(row);
  }

  /** One-click unlink. */
  async delete(vote: VotePubkey, wallet: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM operator_wallets
        WHERE vote_pubkey = $1 AND wallet_pubkey = $2`,
      [vote, wallet],
    );
    return (rowCount ?? 0) > 0;
  }
}
