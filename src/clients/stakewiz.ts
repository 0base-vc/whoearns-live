import type { Logger } from '../core/logger.js';

/**
 * Stakewiz API client — sources validator true-age data.
 *
 * `validators.first_seen_epoch` in our DB is only indexer-relative
 * (the epoch WhoEarns first observed the vote account). For the
 * Tenure card we need the validator's actual on-chain age. Stakewiz
 * (https://stakewiz.com) runs a full-history validator indexer and
 * exposes `first_epoch_with_stake` per validator — the epoch the
 * validator first held active stake, i.e. the true tenure start.
 *
 * The bulk endpoint `GET /validators` returns the whole mainnet set
 * (~1500 entries) in one call. We project each entry to the tenure
 * field (`firstEpochWithStake`) plus the Jito MEV-commission facts
 * (`runsJito` + `jitoCommissionBps`). Stakewiz reads the latter off
 * Jito's on-chain tip-distribution accounts, so the MEV commission
 * is the same kind of delegator FACT we already surface for tenure,
 * from the same source on the same 24 h cadence.
 *
 * No API key required. `fetcher` is injectable so unit tests can
 * stub the HTTP layer.
 */

const STAKEWIZ_VALIDATORS_URL = 'https://api.stakewiz.com/validators';

/** Bound the response read — the real payload is ~1-2 MB; a hostile
 *  or broken upstream serving a huge body shouldn't OOM the worker. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Upper bound on entries we'll accept from one response. Mainnet has
 * ~1500-2000 validators; 20k is a generous ceiling that still catches
 * a pathological response before it churns memory.
 */
const MAX_ENTRIES = 20_000;

export interface StakewizClientDeps {
  fetcher?: typeof fetch;
  logger: Logger;
}

/**
 * One projected stakewiz validator row — the tenure field plus the
 * Jito MEV-commission facts. See class docstring.
 */
export interface StakewizValidatorProjection {
  /** Maps to our `validators.vote_pubkey` (stakewiz calls it
   *  `vote_identity`). */
  voteIdentity: string;
  /** True on-chain tenure start (`first_epoch_with_stake`). `null`
   *  when stakewiz omits / malforms it — the row is still kept for
   *  its MEV facts. */
  firstEpochWithStake: number | null;
  /** Validator's Jito MEV commission in basis points (0-10000), or
   *  `null` when the validator isn't running Jito or the field is
   *  absent. 500 bps = 5%. */
  jitoCommissionBps: number | null;
  /** Whether the validator participates in Jito MEV tip
   *  distribution (`is_jito`). */
  runsJito: boolean;
}

export class StakewizClient {
  private readonly fetcher: typeof fetch;
  private readonly logger: Logger;

  constructor(deps: StakewizClientDeps) {
    this.fetcher = deps.fetcher ?? fetch;
    this.logger = deps.logger;
  }

  /**
   * Fetch every mainnet validator's tenure + Jito MEV-commission
   * facts in one bulk call.
   *
   * Returns a `Map<voteIdentity, StakewizValidatorProjection>`.
   * Entries missing `vote_identity` are skipped (not fatal — a single
   * bad row shouldn't sink the whole refresh). A row missing a valid
   * `first_epoch_with_stake` is still kept (with `firstEpochWithStake:
   * null`) so its MEV facts aren't lost; the tenure consumer filters
   * those out itself.
   *
   * Throws on network failure / non-2xx / oversize / unparseable
   * body — the caller (the ingester job) logs + retries next tick.
   */
  async fetchValidatorFacts(
    signal?: AbortSignal,
  ): Promise<Map<string, StakewizValidatorProjection>> {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal]);

    const response = await this.fetcher(STAKEWIZ_VALIDATORS_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: combinedSignal,
    });
    if (!response.ok) {
      throw new Error(`stakewiz: HTTP ${response.status}`);
    }

    // Content-Length preflight, then streaming byte cap — same posture
    // as the gist-verification fetch. A lying / missing header falls
    // through to the streaming counter.
    const contentLengthHeader = response.headers?.get?.('content-length') ?? null;
    if (contentLengthHeader !== null) {
      const declared = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`stakewiz: response too large (${declared} bytes)`);
      }
    }

    const raw = await this.readBodyCapped(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('stakewiz: response body is not valid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('stakewiz: response body is not a JSON array');
    }
    if (parsed.length > MAX_ENTRIES) {
      throw new Error(`stakewiz: ${parsed.length} entries exceeds the ${MAX_ENTRIES} cap`);
    }

    const out = new Map<string, StakewizValidatorProjection>();
    let skipped = 0;
    for (const entry of parsed) {
      const projection = projectEntry(entry);
      if (projection === null) {
        skipped += 1;
        continue;
      }
      out.set(projection.voteIdentity, projection);
    }
    if (skipped > 0) {
      this.logger.debug({ skipped, kept: out.size }, 'stakewiz: skipped malformed rows');
    }
    return out;
  }

  /**
   * Read the response body with a hard byte ceiling. Mirrors the
   * streaming reader in `github-gist-verification.service.ts`: a
   * stub fetch without a `body` stream falls back to `text()`.
   */
  private async readBodyCapped(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error('stakewiz: response too large');
      }
      return text;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('stakewiz: response exceeded the byte cap mid-stream');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  }
}

/**
 * Project + validate one raw stakewiz array element. Returns `null`
 * only when `vote_identity` is missing — that's the join key, so a
 * row without it is unusable. A missing / out-of-range
 * `first_epoch_with_stake` degrades to `firstEpochWithStake: null`
 * (the row survives for its MEV facts). MEV commission is read only
 * when `is_jito` is true; a non-Jito row reports `runsJito: false`
 * with `jitoCommissionBps: null`, which is itself a correct fact to
 * persist.
 */
function projectEntry(entry: unknown): StakewizValidatorProjection | null {
  if (entry === null || typeof entry !== 'object') return null;
  const obj = entry as Record<string, unknown>;
  const voteIdentity = obj['vote_identity'];
  if (typeof voteIdentity !== 'string' || voteIdentity.length === 0) return null;

  const rawFirstEpoch = obj['first_epoch_with_stake'];
  const firstEpochWithStake =
    typeof rawFirstEpoch === 'number' && Number.isFinite(rawFirstEpoch) && rawFirstEpoch >= 0
      ? Math.floor(rawFirstEpoch)
      : null;

  // MEV commission is meaningful only for Jito participants. Gate the
  // bps on `is_jito` so a non-Jito row never reports a stale / zero
  // commission as if it were a real take-rate.
  const runsJito = obj['is_jito'] === true;
  const rawBps = obj['jito_commission_bps'];
  const jitoCommissionBps =
    runsJito &&
    typeof rawBps === 'number' &&
    Number.isFinite(rawBps) &&
    rawBps >= 0 &&
    rawBps <= 10_000
      ? Math.floor(rawBps)
      : null;

  return { voteIdentity, firstEpochWithStake, jitoCommissionBps, runsJito };
}
