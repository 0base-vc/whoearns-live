import type pg from 'pg';
import type { OperatorWallet, VotePubkey } from '../../types/domain.js';

interface OperatorWalletRow {
  vote_pubkey: string;
  wallet_pubkey: string;
  label: string;
  signed_nonce: string;
  anchor_tx_signature: string;
  registered_at: Date;
  expires_at: Date;
}

function rowToWallet(row: OperatorWalletRow): OperatorWallet {
  return {
    votePubkey: row.vote_pubkey,
    walletPubkey: row.wallet_pubkey,
    label: row.label,
    signedNonce: row.signed_nonce,
    anchorTxSignature: row.anchor_tx_signature,
    registeredAt: row.registered_at,
    expiresAt: row.expires_at,
  };
}

const COLS = `vote_pubkey, wallet_pubkey, label, signed_nonce,
  anchor_tx_signature, registered_at, expires_at`;

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
            anchor_tx_signature, registered_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          wallet.votePubkey,
          wallet.walletPubkey,
          wallet.label,
          wallet.signedNonce,
          wallet.anchorTxSignature,
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
        ORDER BY registered_at ASC`,
      [vote],
    );
    return rows.map(rowToWallet);
  }

  /**
   * Active (not-expired) wallets only. Used by scoring routes that
   * must drop lapsed registrations from contributing signal.
   */
  async listActiveByVote(vote: VotePubkey): Promise<OperatorWallet[]> {
    const { rows } = await this.pool.query<OperatorWalletRow>(
      `SELECT ${COLS} FROM operator_wallets
        WHERE vote_pubkey = $1
          AND expires_at > NOW()
        ORDER BY registered_at ASC`,
      [vote],
    );
    return rows.map(rowToWallet);
  }

  /** Count for the per-validator cap check at the route layer. */
  async countByVote(vote: VotePubkey): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM operator_wallets WHERE vote_pubkey = $1`,
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
   * Existence check for the public `/v1/operator-wallets/:wallet/...`
   * read endpoints. Returns true when the wallet is currently
   * registered AND not expired. Used to gate the route against an
   * existence oracle — the unregistered-wallet path now returns 404
   * rather than an empty response.
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
   * Registration metadata for a single ACTIVE (not-expired) wallet —
   * backs `GET /v1/operator-wallets/:wallet`. Returns `null` when the
   * wallet is unregistered OR its attestation has lapsed, so the
   * public route can collapse both into one 404 and stay off the
   * existence-oracle surface (same `expires_at > NOW()` gate as
   * `existsActive`). A wallet pubkey is UNIQUE per registration in
   * practice; `LIMIT 1` is belt-and-braces.
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
