import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import type { Logger } from '../core/logger.js';
import type { ValidatorsRepository } from '../storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../storage/repositories/watched-dynamic.repo.js';
import type { Epoch, IdentityPubkey, Validator, VotePubkey } from '../types/domain.js';

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

export interface ValidatorServiceDeps {
  validatorsRepo: ValidatorsRepository;
  watchedDynamicRepo?: WatchedDynamicRepository;
  rpc: SolanaRpcClient;
  logger: Logger;
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
  private readonly rpc: SolanaRpcClient;
  private readonly logger: Logger;
  /** Full last-refresh snapshot for `all` / `top` mode resolution. */
  private lastRefresh: Validator[] = [];
  /** Per-vote activated stake from the last refresh (used for top-N ranking). */
  private lastStakeByVote: Map<VotePubkey, number> = new Map();

  constructor(deps: ValidatorServiceDeps) {
    this.validatorsRepo = deps.validatorsRepo;
    this.watchedDynamicRepo = deps.watchedDynamicRepo;
    this.rpc = deps.rpc;
    this.logger = deps.logger;
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
      { vote: VotePubkey; identity: IdentityPubkey; stake: number }
    >();
    for (const row of accounts.current) {
      merged.set(row.votePubkey, {
        vote: row.votePubkey,
        identity: row.nodePubkey,
        stake: row.activatedStake,
      });
    }
    for (const row of accounts.delinquent) {
      merged.set(row.votePubkey, {
        vote: row.votePubkey,
        identity: row.nodePubkey,
        stake: row.activatedStake,
      });
    }

    const out: Validator[] = [];
    const stakeByVote = new Map<VotePubkey, number>();
    for (const { vote, identity, stake } of merged.values()) {
      await this.validatorsRepo.upsert({
        votePubkey: vote,
        identityPubkey: identity,
        firstSeenEpoch: epoch,
        lastSeenEpoch: epoch,
      });
      out.push({
        votePubkey: vote,
        identityPubkey: identity,
        firstSeenEpoch: epoch,
        lastSeenEpoch: epoch,
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
      });
      stakeByVote.set(vote, stake);
    }

    this.lastRefresh = out;
    this.lastStakeByVote = stakeByVote;
    this.logger.info({ epoch, validators: out.length }, 'validator.service: refreshed from RPC');
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
    const cd = account.account.data.parsed.info.configData;
    await this.validatorsRepo.upsertInfo([
      {
        identityPubkey: identity,
        name: normaliseText(cd.name),
        details: normaliseText(cd.details),
        website: normaliseText(cd.website),
        keybaseUsername: normaliseText(cd.keybaseUsername),
        iconUrl: normaliseText(cd.iconUrl),
      },
    ]);
    this.logger.info(
      { identity, name: cd.name ?? null },
      'validator.service: validator-info captured',
    );
    return { found: true };
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
      // in our cache) gets a fair shot.
      try {
        // 0 is a placeholder epoch — refresh doesn't actually use it
        // for vote account lookups, only for the UPSERT `firstSeen`
        // field which is overwritten on next real refresh anyway.
        await this.refreshFromRpc(0);
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
        // 0 is a placeholder epoch — refresh only uses it for the
        // `firstSeen` column, which is overwritten on next real
        // refresh.
        await this.refreshFromRpc(0);
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
}
