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

export class OperatorWalletsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert a new operator wallet. The DB trigger enforces the 3-wallet
   * cap as defense-in-depth; the route layer should also count first
   * and surface a clean 400 before this fires.
   */
  async insert(wallet: OperatorWallet): Promise<void> {
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

  /** Count for the per-validator cap check at the route layer. */
  async countByVote(vote: VotePubkey): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM operator_wallets WHERE vote_pubkey = $1`,
      [vote],
    );
    return Number(rows[0]?.count ?? 0);
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
