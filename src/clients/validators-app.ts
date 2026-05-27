import type { Logger } from '../core/logger.js';

/**
 * validators.app API client — sources canonical Solana validator
 * client identification.
 *
 * Why we need this: the gossip `ContactInfo` carries a 16-bit
 * `ClientVersion.client` field that's the canonical client ID per
 * the Solana Foundation `solana-validator-client-ids` registry. But
 * the standard JSON-RPC `getClusterNodes` projection drops that
 * field — it only surfaces the version STRING and `featureSet`.
 * Yellowstone gRPC / Geyser don't subscribe to gossip CRDS either.
 * So to distinguish, e.g., HarmonicFrankendancer (`client_id=11`)
 * from upstream Frankendancer (`client_id=2`) — both of which can
 * emit `0.909.x` version strings — we need a peer that's running a
 * gossip listener.
 *
 * validators.app runs that listener and exposes the decoded
 * `software_client` (string name from the canonical registry) and
 * `software_client_id` (the u16 ID itself) per validator via REST.
 *
 * The bulk endpoint returns the whole mainnet set (~700-2000 entries)
 * in one call. We project each entry to just the fields the
 * client-kind ingester writes — `{ identityPubkey, clientKind,
 * clientVersion }` — nothing else is load-bearing for this surface.
 *
 * No API key required. `fetcher` is injectable so unit tests can
 * stub the HTTP layer.
 */

const VALIDATORS_APP_URL = 'https://www.validators.app/api/v1/validators/mainnet.json';

/**
 * Bound the response read — the real payload is ~1-2 MB; a hostile
 * or broken upstream serving a huge body shouldn't OOM the worker.
 * Same posture as the stakewiz client.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20_000;

/**
 * Upper bound on entries we'll accept from one response. Mainnet
 * has ~1500-2000 validators; 20k is a generous ceiling that still
 * catches a pathological response before it churns memory.
 */
const MAX_ENTRIES = 20_000;

export interface ValidatorsAppClientDeps {
  fetcher?: typeof fetch;
  logger: Logger;
}

/**
 * One projected validators.app row. Only the four fields the
 * client-kind ingester writes:
 *   - `identityPubkey` — joins to our `validators.identity_pubkey` PK
 *   - `softwareClientId` — canonical u16 from the Solana Foundation
 *     `solana-validator-client-ids` registry (NULL for un-classified)
 *   - `softwareClientName` — the registry's string name
 *     (e.g. "HarmonicFrankendancer"), used as a fallback when the
 *     numeric ID is missing
 *   - `softwareVersion` — the raw version string the validator
 *     publishes via gossip (e.g. "0.909.0-rc.40001")
 */
export interface ValidatorsAppProjection {
  identityPubkey: string;
  softwareClientId: number | null;
  softwareClientName: string | null;
  softwareVersion: string | null;
}

export class ValidatorsAppClient {
  private readonly fetcher: typeof fetch;
  private readonly logger: Logger;

  constructor(deps: ValidatorsAppClientDeps) {
    this.fetcher = deps.fetcher ?? fetch;
    this.logger = deps.logger;
  }

  /**
   * Fetch every mainnet validator's canonical client identification.
   *
   * Returns a `Map<identityPubkey, ValidatorsAppProjection>`. Entries
   * missing the identity pubkey are skipped (not fatal — a single
   * bad row shouldn't sink the whole refresh). Entries with a
   * malformed `software_client_id` are still emitted with that field
   * NULL — the caller decides whether to fall back to the string
   * name or to `'unknown'`.
   *
   * Throws on network failure / non-2xx / oversize / unparseable
   * body — the caller (the ingester job) logs + retries next epoch.
   */
  async fetchValidatorClients(signal?: AbortSignal): Promise<Map<string, ValidatorsAppProjection>> {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal]);

    const response = await this.fetcher(VALIDATORS_APP_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: combinedSignal,
    });
    if (!response.ok) {
      throw new Error(`validators-app: HTTP ${response.status}`);
    }

    const contentLengthHeader = response.headers?.get?.('content-length') ?? null;
    if (contentLengthHeader !== null) {
      const declared = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`validators-app: response too large (${declared} bytes)`);
      }
    }

    const raw = await this.readBodyCapped(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('validators-app: response body is not valid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('validators-app: response body is not a JSON array');
    }
    if (parsed.length > MAX_ENTRIES) {
      throw new Error(`validators-app: ${parsed.length} entries exceeds the ${MAX_ENTRIES} cap`);
    }

    const out = new Map<string, ValidatorsAppProjection>();
    let skipped = 0;
    for (const entry of parsed) {
      const projection = projectEntry(entry);
      if (projection === null) {
        skipped += 1;
        continue;
      }
      out.set(projection.identityPubkey, projection);
    }
    if (skipped > 0) {
      this.logger.debug({ skipped, kept: out.size }, 'validators-app: skipped malformed rows');
    }
    return out;
  }

  /**
   * Read the response body with a hard byte ceiling. Mirrors the
   * streaming reader in `stakewiz.ts`: a stub fetch without a `body`
   * stream falls back to `text()`.
   */
  private async readBodyCapped(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error('validators-app: response too large');
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
        throw new Error('validators-app: response exceeded the byte cap mid-stream');
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
 * Project + validate one raw validators.app array element. The
 * identity pubkey is in `account` (NOT `vote_account`); we key on
 * identity because the `validators` table's PK is identity.
 *
 * Returns `null` when the row has no usable identity pubkey.
 * `software_client_id` / `software_client` / `software_version` are
 * each independently optional — a row with identity but no client
 * info is still emitted (the caller will degrade to `'unknown'`).
 */
function projectEntry(entry: unknown): ValidatorsAppProjection | null {
  if (entry === null || typeof entry !== 'object') return null;
  const obj = entry as Record<string, unknown>;
  const identity = obj['account'];
  if (typeof identity !== 'string' || identity.length === 0) return null;

  const rawId = obj['software_client_id'];
  let softwareClientId: number | null = null;
  if (typeof rawId === 'number' && Number.isFinite(rawId) && rawId >= 0 && rawId <= 65_535) {
    softwareClientId = Math.floor(rawId);
  }

  const rawName = obj['software_client'];
  // "Unknown" is the upstream's NULL sentinel — coerce it back to
  // null so our caller's classifier sees the same signal as a row
  // with no `software_client` field at all.
  const softwareClientName =
    typeof rawName === 'string' && rawName.length > 0 && rawName !== 'Unknown' ? rawName : null;

  const rawVersion = obj['software_version'];
  const softwareVersion =
    typeof rawVersion === 'string' && rawVersion.length > 0 ? rawVersion : null;

  return { identityPubkey: identity, softwareClientId, softwareClientName, softwareVersion };
}
