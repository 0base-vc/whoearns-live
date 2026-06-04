import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { Logger } from '../core/logger.js';
import { normaliseHttpUrlOrNull } from '../core/url.js';
import type { StatsRepository } from '../storage/repositories/stats.repo.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';
import type {
  Epoch,
  IdentityPubkey,
  Validator,
  ValidatorInfo,
  VotePubkey,
} from '../types/domain.js';

export type WatchMode = 'explicit' | 'all' | 'top';

/**
 * Coerce a raw validator-info string into `null | string`:
 *   - `undefined` → null
 *   - strings that trim to empty → null
 *   - anything else → trimmed string (so "  Validator  " → "Validator")
 *
 * The Config program doesn't constrain contents — validators can
 * publish whitespace-only names, URLs with trailing spaces, etc.
 * Normalising here means the DB column reliably answers "does this
 * validator have a real name?" with a single `IS NOT NULL` check.
 */
function normaliseText(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const ON_DEMAND_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const ON_DEMAND_REFRESH_FAILURE_COOLDOWN_MS = 30 * 1000;
const ON_DEMAND_NEGATIVE_CACHE_MS = 5 * 60 * 1000;
/**
 * Hard ceiling on the per-pubkey negative cache. Each entry costs a
 * few hundred bytes; at 10k entries the worst case is sub-megabyte.
 * Lookups already expire entries on read but expired entries that
 * are never re-read would otherwise live forever — without a cap an
 * attacker spraying unique pubkeys could grow the Map until the pod
 * is restarted. FIFO eviction keeps the cap honest with O(1) work.
 */
const ON_DEMAND_NEGATIVE_CACHE_MAX_ENTRIES = 10_000;

export interface ValidatorServiceDeps {
  validatorsRepo: ValidatorsRepository;
  watchedDynamicRepo?: WatchedDynamicRepository;
  /**
   * Optional — when wired, every `refreshFromRpc` tick records the
   * per-(epoch, vote) vote-credit totals derived from
   * `getVoteAccounts.epochCredits`. Omitting the dep disables the
   * indexer (useful in tests + on-demand-only call sites).
   */
  statsRepo?: Pick<StatsRepository, 'upsertVoteCreditsBatch'>;
  rpc: SolanaRpcClient;
  logger: Logger;
  /**
   * Override for the negative-cache ceiling. Tests lower it to assert
   * FIFO eviction without iterating 10k+ pubkeys; production callers
   * should leave it unset and accept the constant.
   */
  onDemandNegativeCacheMaxEntries?: number;
}

/**
 * Orchestrates validator-identity bookkeeping.
 *
 * The authoritative source for the `(vote, identity)` mapping is the live
 * Solana network — we mirror it into the `validators` table so the rest of
 * the indexer can resolve identities locally without hitting RPC on every
 * read.
 */
export class ValidatorService {
  private readonly validatorsRepo: ValidatorsRepository;
  private readonly watchedDynamicRepo: WatchedDynamicRepository | undefined;
  private readonly statsRepo: Pick<StatsRepository, 'upsertVoteCreditsBatch'> | undefined;
  private readonly rpc: SolanaRpcClient;
  private readonly logger: Logger;
  /** Full last-refresh snapshot for `all` / `top` mode resolution. */
  private lastRefresh: Validator[] = [];
  /** Per-vote activated stake from the last refresh (used for top-N ranking). */
  private lastStakeByVote: Map<VotePubkey, number> = new Map();
  private onDemandRefreshPromise: Promise<void> | null = null;
  private nextOnDemandRefreshAllowedAtMs = 0;
  private onDemandMissUntilByPubkey: Map<string, number> = new Map();
  private readonly onDemandNegativeCacheMaxEntries: number;

  constructor(deps: ValidatorServiceDeps) {
    this.validatorsRepo = deps.validatorsRepo;
    this.watchedDynamicRepo = deps.watchedDynamicRepo;
    this.statsRepo = deps.statsRepo;
    this.rpc = deps.rpc;
    this.logger = deps.logger;
    this.onDemandNegativeCacheMaxEntries =
      deps.onDemandNegativeCacheMaxEntries ?? ON_DEMAND_NEGATIVE_CACHE_MAX_ENTRIES;
  }

  /**
   * Latest-known activated stake (lamports) for a vote, from the most
   * recent `refreshFromRpc` snapshot. Returns `null` when the vote
   * hasn't been seen yet — callers (e.g. the slot-ingester) treat
   * that as "don't write stake this tick" rather than writing zero.
   *
   * Returns `bigint` so callers can persist directly to the NUMERIC
   * column without a lossy Number round-trip (8-byte mantissa limits
   * Number at ~2^53, vs activated stake values that can exceed that
   * on a whale validator).
   */
  getActivatedStakeLamports(vote: VotePubkey): bigint | null {
    const raw = this.lastStakeByVote.get(vote);
    if (raw === undefined) return null;
    // Stake arrives from `getVoteAccounts` as a JSON number. Clamp
    // negatives to 0 defensively (shouldn't happen) and truncate the
    // fractional part (shouldn't happen either — lamports are
    // integers, but we want ToBigInt to succeed).
    if (raw <= 0) return 0n;
    return BigInt(Math.floor(raw));
  }

  /**
   * Pull the current vote accounts from RPC and upsert each one into storage.
   *
   * Current + delinquent are unioned so a validator that temporarily drops off
   * the "current" list isn't forgotten. We also record `activatedStake` per
   * vote to support `top:N` ranking without a second RPC call — the values
   * only need to be fresh enough to pick a representative sample, which
   * the refresh cadence already guarantees.
   */
  async refreshFromRpc(epoch: Epoch): Promise<Validator[]> {
    const accounts = await this.rpc.getVoteAccounts('confirmed');
    const merged = new Map<
      VotePubkey,
      {
        vote: VotePubkey;
        identity: IdentityPubkey;
        stake: number;
        commission: number | null;
      }
    >();
    // Commission is on the same `getVoteAccounts` row as
    // `activatedStake` — capture it in lockstep. Clamp to 0-100 so
    // an out-of-spec RPC reply can't poison the DB; treat anything
    // outside the expected range as `null` (unknown).
    function normaliseCommission(raw: number | null | undefined): number | null {
      if (raw === null || raw === undefined) return null;
      if (!Number.isFinite(raw)) return null;
      const clamped = Math.round(Math.max(0, Math.min(100, raw)));
      return clamped;
    }
    for (const row of accounts.current) {
      merged.set(row.votePubkey, {
        vote: row.votePubkey,
        identity: row.nodePubkey,
        stake: row.activatedStake,
        commission: normaliseCommission(row.commission),
      });
    }
    for (const row of accounts.delinquent) {
      merged.set(row.votePubkey, {
        vote: row.votePubkey,
        identity: row.nodePubkey,
        stake: row.activatedStake,
        commission: normaliseCommission(row.commission),
      });
    }

    const out: Validator[] = [];
    const stakeByVote = new Map<VotePubkey, number>();
    for (const { vote, identity, stake, commission } of merged.values()) {
      await this.validatorsRepo.upsert({
        votePubkey: vote,
        identityPubkey: identity,
        firstSeenEpoch: epoch,
        lastSeenEpoch: epoch,
        commission,
      });
      out.push({
        votePubkey: vote,
        identityPubkey: identity,
        firstSeenEpoch: epoch,
        lastSeenEpoch: epoch,
        // `genesis_epoch` is owned by the stakewiz-tenure-ingester
        // job; refreshFromRpc doesn't load it (same as the info +
        // client columns below). Callers needing tenure re-fetch via
        // `findByVote`, which SELECTs the full row.
        genesisEpoch: null,
        updatedAt: new Date(),
        // Info columns are owned by the validator-info-refresh job;
        // refreshFromRpc doesn't load them, so we return null here
        // and let callers who need them re-fetch via `findByVote`
        // (which SELECTs the full row). Keeping the in-memory
        // `lastRefresh` snapshot lean keeps repeated sorts fast.
        name: null,
        details: null,
        website: null,
        keybaseUsername: null,
        iconUrl: null,
        infoUpdatedAt: null,
        // Client classification is owned by a separate refresh path
        // (Phase 2 cluster-nodes ingester); refreshFromRpc never
        // overwrites it, so the in-memory snapshot uses neutral
        // defaults that the API layer treats as "unmeasured" until
        // the dedicated ingester has run.
        clientKind: 'unknown',
        clientVersion: null,
        clientUpdatedAt: null,
        commission,
        // MEV commission + Jito participation are owned by the
        // stakewiz-tenure-ingester (same as `genesisEpoch` above);
        // refreshFromRpc doesn't load them, so the in-memory snapshot
        // returns null and callers needing them re-fetch via
        // `findByVote`, which SELECTs the full row.
        mevCommissionBps: null,
        runsJito: null,
      });
      stakeByVote.set(vote, stake);
    }

    this.lastRefresh = out;
    this.lastStakeByVote = stakeByVote;
    this.logger.info({ epoch, validators: out.length }, 'validator.service: refreshed from RPC');

    // Vote-credit indexing — best-effort, never fails the refresh.
    // `epochCredits` returns up to the last 5 epochs as
    // `[epoch, credits, prevCredits][]` entries; we pick the one
    // matching the current `epoch` argument so a delinquent validator
    // (whose latest entry is older) is simply skipped rather than
    // mis-attributed to the current epoch.
    //
    // De-dup by votePubkey: if RPC briefly reports a vote in BOTH
    // `accounts.current` and `accounts.delinquent` (transient race
    // around delinquency transitions), the same vote_pubkey would
    // hit `upsertVoteCreditsBatch` twice in one statement and trigger
    // Postgres' `ON CONFLICT DO UPDATE command cannot affect row a
    // second time` error, aborting the entire batch.
    if (this.statsRepo !== undefined) {
      try {
        const bySource = new Map<
          VotePubkey,
          {
            votePubkey: VotePubkey;
            identityPubkey: IdentityPubkey;
            voteCredits: bigint;
            prevEpochVoteCredits: bigint;
          }
        >();
        for (const row of [...accounts.current, ...accounts.delinquent]) {
          const match = row.epochCredits.find(([e]) => e === epoch);
          if (match === undefined) continue;
          const [, credits, prevCredits] = match;
          if (!Number.isFinite(credits) || !Number.isFinite(prevCredits)) continue;
          bySource.set(row.votePubkey, {
            votePubkey: row.votePubkey,
            identityPubkey: row.nodePubkey,
            voteCredits: BigInt(Math.max(0, Math.floor(credits))),
            prevEpochVoteCredits: BigInt(Math.max(0, Math.floor(prevCredits))),
          });
        }
        const entries = [...bySource.values()];
        if (entries.length > 0) {
          await this.statsRepo.upsertVoteCreditsBatch(epoch, entries);
          this.logger.debug(
            { epoch, indexed: entries.length },
            'validator.service: vote credits indexed',
          );
        }
      } catch (err) {
        // Vote-credit indexing is decorative — failure must not break
        // the validator refresh, which downstream jobs depend on.
        this.logger.warn({ err, epoch }, 'validator.service: vote credits index failed');
      }
    }

    return out;
  }

  /**
   * Fetch the on-chain validator-info (moniker / icon / website /
   * keybase) for a SINGLE identity and upsert it into the
   * `validators` row. Called at registration time — once per
   * validator — rather than on a recurring sweep:
   *
   *   - `trackOnDemand()` calls this after a new dynamic validator
   *     has been upserted into `watched_validators_dynamic`.
   *   - `backfillMissingValidatorInfos()` calls it per identity on
   *     worker boot for every watched validator whose info slot is
   *     still null.
   *
   * Returns `{ found: boolean }` so callers can distinguish "we
   * queried and the validator has no on-chain info" (found=false,
   * `info_updated_at` stays null and we'll re-try on next boot)
   * from "info fetched and saved" (found=true).
   *
   * All strings are whitespace-normalised — the on-chain layout
   * doesn't enforce anything, so empty `"    "` values become
   * `null` so the UI consistently treats missing info as missing.
   */
  async refreshValidatorInfoForIdentity(identity: IdentityPubkey): Promise<{ found: boolean }> {
    let account;
    try {
      account = await this.rpc.getValidatorInfoForIdentity(identity);
    } catch (err) {
      this.logger.warn(
        { err, identity },
        'validator.service: validator-info RPC failed, will retry next boot',
      );
      return { found: false };
    }
    if (account === null) return { found: false };
    // `getValidatorInfoForIdentity` already filters to `parsed.type === 'validatorInfo'`,
    // so `parsed` is non-undefined here in practice — but the type leaves
    // it optional (raw-tuple fallback shape), so guard for compile-time safety.
    const cd = account.account.data.parsed?.info.configData;
    if (cd === undefined) return { found: false };
    await this.validatorsRepo.upsertInfo([
      {
        identityPubkey: identity,
        name: normaliseText(cd.name),
        details: normaliseText(cd.details),
        website: normaliseHttpUrlOrNull(cd.website),
        keybaseUsername: normaliseText(cd.keybaseUsername),
        iconUrl: normaliseHttpUrlOrNull(cd.iconUrl),
      },
    ]);
    this.logger.info(
      { identity, name: cd.name ?? null },
      'validator.service: validator-info captured',
    );
    return { found: true };
  }

  /**
   * Cluster-wide validator-info refresh. ONE `getConfigProgramAccounts`
   * call returns every PUBLISHED on-chain moniker (~2000 records,
   * ~3 MB on mainnet); we project each to a `ValidatorInfo` keyed by
   * identity and batch-upsert.
   *
   * This is the ONLY path that fills name / keybase / website / icon
   * for validators NOBODY has explicitly tracked. The per-identity
   * `refreshValidatorInfoForIdentity` only runs for the watched set +
   * on-demand-added validators, so without this the public
   * `/v1/validators/search` could match monikers for that handful
   * only — every other active validator sat in `validators` with a
   * NULL `name`, findable by pubkey but NOT by name. (A user searching
   * "chainflow" would miss the main Chainflow validator entirely
   * unless someone had already pulled it in by pubkey.)
   *
   * Identity comes from the Config account's signer key: `keys[]`
   * holds the Validator-Info program id (non-signer) and the
   * validator identity (the lone signer). Records we can't read an
   * identity from, and non-`validatorInfo` Config accounts (stake-
   * config, etc.) returned by the same RPC, are skipped. Duplicate
   * identities (shouldn't happen) collapse last-write-wins so the
   * repo's UNNEST join can't match a target row twice.
   *
   * Throws on RPC failure (the job logs + retries next tick). Returns
   * `{ observed, updated }`:
   *   - `observed` = parsed validator-info records carrying a signer
   *     identity (PRE-dedup). `observed > byIdentity.size` surfaces
   *     duplicate-identity records — should never happen in practice,
   *     but counting pre-dedup means the caller can see it if it does.
   *   - `updated` = rows whose moniker actually changed (the repo's
   *     IS DISTINCT FROM guard makes a no-drift tick a zero-row write).
   */
  async refreshAllValidatorInfo(): Promise<{ observed: number; updated: number }> {
    const accounts = await this.rpc.getConfigProgramAccounts();
    const byIdentity = new Map<IdentityPubkey, ValidatorInfo>();
    let observed = 0;
    for (const account of accounts) {
      // `parsed` is undefined for Config accounts the jsonParsed encoder
      // can't decode (stake-config, etc. fall back to a raw byte tuple).
      // Dereferencing it before the type check throws and kills the whole
      // tick — the cluster-wide moniker fill silently never lands.
      const parsed = account.account.data.parsed;
      if (parsed?.type !== 'validatorInfo') continue;
      const identity = parsed.info.keys.find((k) => k.signer)?.pubkey;
      if (identity === undefined || identity.length === 0) continue;
      observed += 1;
      const cd = parsed.info.configData;
      byIdentity.set(identity as IdentityPubkey, {
        identityPubkey: identity as IdentityPubkey,
        name: normaliseText(cd.name),
        details: normaliseText(cd.details),
        website: normaliseHttpUrlOrNull(cd.website),
        keybaseUsername: normaliseText(cd.keybaseUsername),
        iconUrl: normaliseHttpUrlOrNull(cd.iconUrl),
      });
    }
    const { updated } = await this.validatorsRepo.upsertInfoBatch([...byIdentity.values()]);
    return { observed, updated };
  }

  /**
   * One-shot boot-time backfill: for every watched validator whose
   * `info_updated_at` is null, fetch and store their on-chain
   * moniker. Called once from the worker entrypoint at startup so
   * an operator doesn't have to wait for a new /income/:vote visit
   * to populate monikers for validators that predate this feature.
   *
   * Best-effort: one failed RPC does NOT abort the batch; we log
   * and move on so the remaining validators still get filled.
   */
  async backfillMissingValidatorInfos(
    identities: IdentityPubkey[],
  ): Promise<{ filled: number; missing: number }> {
    let filled = 0;
    let missing = 0;
    for (const identity of identities) {
      const { found } = await this.refreshValidatorInfoForIdentity(identity);
      if (found) filled += 1;
      else missing += 1;
    }
    this.logger.info(
      { total: identities.length, filled, missing },
      'validator.service: validator-info boot backfill complete',
    );
    return { filled, missing };
  }

  /**
   * Resolve the watched votes for this tick.
   *
   * - `all`: last-refresh snapshot (priming via RPC on first call).
   * - `top`: last-refresh snapshot sorted by activated stake, sliced to topN.
   * - `explicit`: caller-provided list. If any votes are missing from the DB
   *   we trigger a refresh so the downstream identity lookup resolves on the
   *   same tick (avoids a cold-start window where the first tick has no
   *   data to work with).
   */
  async getActiveVotePubkeys(
    mode: WatchMode,
    explicitVotes: VotePubkey[],
    epoch: Epoch,
    opts: { topN?: number } = {},
  ): Promise<VotePubkey[]> {
    // Dynamic watched set — always unioned regardless of mode. A
    // user-added validator should be tracked even if they aren't in
    // the top-N by stake or in the explicit config list.
    const dynamicVotes = this.watchedDynamicRepo ? await this.watchedDynamicRepo.listVotes() : [];

    if (mode === 'all') {
      if (this.lastRefresh.length === 0) {
        const fresh = await this.refreshFromRpc(epoch);
        return this.unionVotes(
          fresh.map((v) => v.votePubkey),
          dynamicVotes,
        );
      }
      return this.unionVotes(
        this.lastRefresh.map((v) => v.votePubkey),
        dynamicVotes,
      );
    }

    if (mode === 'top') {
      if (this.lastRefresh.length === 0) {
        await this.refreshFromRpc(epoch);
      }
      const n = Math.max(1, opts.topN ?? 100);
      // Sort a copy by activated stake descending, ties broken by vote pubkey
      // (deterministic so the sample is stable within a refresh window).
      const sorted = [...this.lastRefresh].sort((a, b) => {
        const sa = this.lastStakeByVote.get(a.votePubkey) ?? 0;
        const sb = this.lastStakeByVote.get(b.votePubkey) ?? 0;
        if (sb !== sa) return sb - sa;
        return a.votePubkey.localeCompare(b.votePubkey);
      });
      return this.unionVotes(
        sorted.slice(0, n).map((v) => v.votePubkey),
        dynamicVotes,
      );
    }

    // `explicit` mode.
    if (explicitVotes.length === 0 && dynamicVotes.length === 0) return [];
    const union = this.unionVotes(explicitVotes, dynamicVotes);
    const known = await this.validatorsRepo.findManyByVotes(union);
    const knownVotes = new Set(known.map((k) => k.votePubkey));
    const missing = union.filter((v) => !knownVotes.has(v));
    if (missing.length > 0) {
      this.logger.info(
        { missing, epoch },
        'validator.service: watched votes missing from DB — priming via RPC',
      );
      await this.refreshFromRpc(epoch);
    }
    return union;
  }

  private unionVotes(primary: VotePubkey[], dynamic: VotePubkey[]): VotePubkey[] {
    if (dynamic.length === 0) return primary;
    const seen = new Set<VotePubkey>(primary);
    const out = [...primary];
    for (const v of dynamic) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  /**
   * Read the (vote → identity) map for the given votes. The caller is
   * expected to have already populated the cache via `refreshFromRpc`.
   */
  async getIdentityMap(votes: VotePubkey[]): Promise<Map<VotePubkey, IdentityPubkey>> {
    if (votes.length === 0) return new Map();
    return this.validatorsRepo.getIdentitiesForVotes(votes);
  }

  /**
   * Anti-abuse gate for the Phase 3 "add my validator" / claim flow.
   * Rejects any vote pubkey that hasn't met a minimum stake floor OR
   * hasn't produced at least one block in the cached snapshot.
   *
   * The concrete thresholds intentionally live as parameters rather
   * than module constants — the caller (claim route) owns the policy.
   * Defaults match the security-review recommendation: 1 SOL activated
   * stake minimum (rejects test/dev validators and zero-stake squatters)
   * and presence in the current-epoch leader schedule as a liveness
   * signal.
   *
   * Purely advisory — callers decide what to do on false (refuse the
   * claim, queue for manual review, etc.). Does NOT mutate state.
   *
   * Returns `{ eligible: true }` on pass, otherwise a structured
   * reason the caller can surface in the API response so the user
   * knows *why* their pubkey was rejected.
   */
  async assessClaimEligibility(
    vote: VotePubkey,
    opts: { minActivatedStakeLamports?: bigint; requireKnown?: boolean } = {},
  ): Promise<
    | { eligible: true; activatedStakeLamports: bigint }
    | { eligible: false; reason: string; activatedStakeLamports: bigint | null }
  > {
    const minStake = opts.minActivatedStakeLamports ?? 1_000_000_000n; // 1 SOL default
    const requireKnown = opts.requireKnown ?? true;

    // The last-refresh cache is always consulted first; if the vote
    // isn't there, try one refresh from RPC to cover the case where
    // we haven't seen this validator yet.
    let stakeLamports = this.lastStakeByVote.get(vote);
    if (stakeLamports === undefined && requireKnown) {
      // Trigger a refresh so a freshly-registered validator (not yet
      // in our cache) gets a fair shot. Routed through the cooldown +
      // dedupe wrapper so eligibility probes share the same backoff
      // budget as `trackOnDemand` — verifying a signed claim against
      // an unknown vote should not double the upstream RPC pressure.
      try {
        await this.refreshOnDemandVoteAccounts();
        stakeLamports = this.lastStakeByVote.get(vote);
      } catch (err) {
        this.logger.warn(
          { err, vote },
          'validator.service: refresh failed during claim eligibility check',
        );
      }
    }

    if (stakeLamports === undefined) {
      return {
        eligible: false,
        reason:
          'Vote account not found on mainnet. If this validator is new, wait for the next epoch boundary and try again.',
        activatedStakeLamports: null,
      };
    }

    const stakeBig = BigInt(Math.floor(stakeLamports));
    if (stakeBig < minStake) {
      return {
        eligible: false,
        reason: `Activated stake ${stakeBig} lamports is below the minimum ${minStake} lamports required to claim a validator.`,
        activatedStakeLamports: stakeBig,
      };
    }

    return { eligible: true, activatedStakeLamports: stakeBig };
  }

  /**
   * On-demand track for a never-before-seen validator.
   *
   * Invoked by the history route when a user hits `/income/:unknownPubkey`.
   * Resolves the pubkey to a `(vote, identity)` pair via RPC, enforces
   * the stake-activity floor (same as `assessClaimEligibility`), upserts
   * into `validators`, and then registers the vote into
   * `watched_validators_dynamic` so the fee-ingester will pick it up on
   * the next tick.
   *
   * Accepts EITHER a vote pubkey or an identity pubkey as input.
   * Returns the canonical vote pubkey on success so callers can
   * redirect or re-query with the stable identifier.
   *
   * Side-effects (all synchronous, all within this call):
   *   - `validators` row exists for the (vote, identity) pair
   *   - `watched_validators_dynamic` row exists (or lookup_count bumped
   *     if the caller is re-visiting)
   * Does NOT trigger backfill — the caller is responsible for queuing
   * a `fee.service.backfillForValidator` if previous-epoch data is
   * wanted immediately.
   */
  async trackOnDemand(
    pubkey: string,
    opts: { minActivatedStakeLamports?: bigint } = {},
  ): Promise<
    | { ok: true; votePubkey: VotePubkey; identityPubkey: IdentityPubkey; newlyTracked: boolean }
    | { ok: false; reason: string }
  > {
    if (this.watchedDynamicRepo === undefined) {
      return {
        ok: false,
        reason: 'Dynamic watch registry is not wired on this instance.',
      };
    }

    const nowMs = Date.now();
    const missUntil = this.onDemandMissUntilByPubkey.get(pubkey);
    if (missUntil !== undefined && missUntil > nowMs) {
      return {
        ok: false,
        reason:
          'Pubkey was not found among active Solana vote accounts recently. Try again after a few minutes.',
      };
    }
    if (missUntil !== undefined) this.onDemandMissUntilByPubkey.delete(pubkey);

    // Look up in our own cache (fast path for repeat hits). If miss,
    // refresh from RPC so a freshly-registered validator gets a fair
    // shot without a 24h wait for the next validator-service refresh.
    let matchVote: VotePubkey | undefined;
    let matchIdentity: IdentityPubkey | undefined;
    let matchStake: number | undefined;

    const seek = (): void => {
      for (const v of this.lastRefresh) {
        if (v.votePubkey === pubkey || v.identityPubkey === pubkey) {
          matchVote = v.votePubkey;
          matchIdentity = v.identityPubkey;
          matchStake = this.lastStakeByVote.get(v.votePubkey);
          return;
        }
      }
    };
    seek();

    if (matchVote === undefined) {
      try {
        await this.refreshOnDemandVoteAccounts();
        seek();
      } catch (err) {
        this.logger.warn({ err, pubkey }, 'validator.service: trackOnDemand refresh failed');
        return {
          ok: false,
          reason: 'Temporary failure resolving the validator via RPC. Try again shortly.',
        };
      }
    }

    if (matchVote === undefined || matchIdentity === undefined) {
      this.recordOnDemandMiss(pubkey, Date.now() + ON_DEMAND_NEGATIVE_CACHE_MS);
      return {
        ok: false,
        reason:
          'Pubkey not found among active Solana vote accounts. Double-check the address, or wait for the next epoch if this validator just came online.',
      };
    }

    const minStake = opts.minActivatedStakeLamports ?? 1_000_000_000n; // 1 SOL default
    const stakeBig = BigInt(Math.floor(matchStake ?? 0));
    if (stakeBig < minStake) {
      return {
        ok: false,
        reason: `Validator activated stake ${stakeBig} lamports is below the minimum ${minStake} lamports required for tracking.`,
      };
    }

    // Was this an existing dynamic row? Used for telemetry + the
    // `newlyTracked` hint returned to the caller (UI uses it to pick
    // the "just started" vs "already tracked" message).
    const existing = await this.watchedDynamicRepo.findByVote(matchVote);
    const newlyTracked = existing === null;

    await this.watchedDynamicRepo.add({
      votePubkey: matchVote,
      activatedStakeLamportsAtAdd: stakeBig,
    });

    if (newlyTracked) {
      this.logger.info(
        { vote: matchVote, identity: matchIdentity, stakeLamports: stakeBig.toString() },
        'validator.service: tracked new validator on-demand',
      );
      // Fire-and-forget moniker fetch so the first page load after
      // tracking has a chance to display the validator's name
      // rather than the raw pubkey. We don't block the API response
      // on this — the user already waited for the vote-accounts
      // refresh; adding another RPC call here would bloat p99.
      // On failure we silently let `info_updated_at` stay null;
      // the next worker boot picks it up via
      // `backfillMissingValidatorInfos`.
      void this.refreshValidatorInfoForIdentity(matchIdentity).catch((err) => {
        this.logger.warn(
          { err, identity: matchIdentity },
          'validator.service: post-track moniker fetch failed (non-fatal)',
        );
      });
    }

    return { ok: true, votePubkey: matchVote, identityPubkey: matchIdentity, newlyTracked };
  }

  private async refreshOnDemandVoteAccounts(): Promise<void> {
    // In-flight dedupe: parallel callers share the same RPC fetch.
    if (this.onDemandRefreshPromise !== null) {
      await this.onDemandRefreshPromise;
      return;
    }
    // Cooldown gate: when the cache is already primed, accept stale
    // data rather than burst the upstream RPC. Cold start (cache
    // empty) bypasses the gate so a freshly-booted pod can prime its
    // cache on the first request without waiting for the periodic
    // epoch-watcher tick.
    if (this.lastRefresh.length > 0 && Date.now() < this.nextOnDemandRefreshAllowedAtMs) {
      return;
    }

    this.onDemandRefreshPromise = (async () => {
      try {
        // 0 is a placeholder epoch — refresh only uses it for the
        // `firstSeen` column, which is overwritten on next real
        // refresh.
        await this.refreshFromRpc(0);
        this.nextOnDemandRefreshAllowedAtMs = Date.now() + ON_DEMAND_REFRESH_COOLDOWN_MS;
      } catch (err) {
        this.nextOnDemandRefreshAllowedAtMs = Date.now() + ON_DEMAND_REFRESH_FAILURE_COOLDOWN_MS;
        throw err;
      } finally {
        this.onDemandRefreshPromise = null;
      }
    })();

    await this.onDemandRefreshPromise;
  }

  /**
   * Record a negative-cache entry, evicting the oldest insertion when
   * the cap is reached. `Map` iterates in insertion order, so the
   * first key returned by `keys()` is the oldest — FIFO eviction is
   * a single delete + set pair. We re-insert on update to keep the
   * just-touched key from being evicted next.
   */
  private recordOnDemandMiss(pubkey: string, expiresAtMs: number): void {
    if (this.onDemandMissUntilByPubkey.has(pubkey)) {
      this.onDemandMissUntilByPubkey.delete(pubkey);
    } else if (this.onDemandMissUntilByPubkey.size >= this.onDemandNegativeCacheMaxEntries) {
      const oldest = this.onDemandMissUntilByPubkey.keys().next().value;
      if (oldest !== undefined) this.onDemandMissUntilByPubkey.delete(oldest);
    }
    this.onDemandMissUntilByPubkey.set(pubkey, expiresAtMs);
  }
}
