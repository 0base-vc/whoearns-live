import { describe, it, expect, vi } from 'vitest';
import { pino } from 'pino';
import { ValidatorService } from '../../../src/services/validator.service.js';
import type { SolanaRpcClient } from '../../../src/clients/solana-rpc.js';
import type { RpcValidatorInfoAccount } from '../../../src/clients/types.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type { WatchedDynamicRepository } from '../../../src/storage/repositories/watched-dynamic.repo.js';
import {
  IDENTITY_A,
  IDENTITY_B,
  IDENTITY_C,
  VOTE_A,
  VOTE_B,
  voteAccountsFixture,
} from '../../fixtures/rpc-fixtures.js';
import { FakeValidatorsRepo, FakeWatchedDynamicRepo } from './_fakes.js';

const silent = pino({ level: 'silent' });

function makeRpcStub(accounts = voteAccountsFixture): Pick<SolanaRpcClient, 'getVoteAccounts'> {
  return {
    getVoteAccounts: vi.fn().mockResolvedValue(accounts),
  };
}

function makeService(
  rpc: Pick<SolanaRpcClient, 'getVoteAccounts'>,
  repo: FakeValidatorsRepo,
): ValidatorService {
  return new ValidatorService({
    validatorsRepo: repo as unknown as ValidatorsRepository,
    rpc: rpc as unknown as SolanaRpcClient,
    logger: silent,
  });
}

describe('ValidatorService.refreshFromRpc', () => {
  it('upserts current vote accounts', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);

    const result = await service.refreshFromRpc(500);
    expect(result).toHaveLength(2);
    expect(repo.rows.size).toBe(2);
    expect(repo.rows.get(VOTE_A)?.identityPubkey).toBe(IDENTITY_A);
    expect(repo.rows.get(VOTE_B)?.identityPubkey).toBe(IDENTITY_B);
  });

  it('merges delinquent validators into the upsert set', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub({
      current: [voteAccountsFixture.current[0]!],
      delinquent: [voteAccountsFixture.current[1]!],
    });
    const service = makeService(rpc, repo);
    const out = await service.refreshFromRpc(500);
    expect(out).toHaveLength(2);
  });

  it('collapses duplicate votePubkeys across current/delinquent', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub({
      current: [voteAccountsFixture.current[0]!],
      delinquent: [voteAccountsFixture.current[0]!],
    });
    const service = makeService(rpc, repo);
    const out = await service.refreshFromRpc(500);
    expect(out).toHaveLength(1);
    expect(out[0]?.votePubkey).toBe(VOTE_A);
  });
});

describe('ValidatorService.getActiveVotePubkeys', () => {
  it('explicit mode passes through given votes and primes missing ones via RPC', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);

    const out = await service.getActiveVotePubkeys('explicit', [VOTE_A, 'VoteMissing'], 500);
    expect(out).toEqual([VOTE_A, 'VoteMissing']);
    // One of the requested votes wasn't in the DB; the service should have
    // triggered a cold-start refresh so the follow-on identity lookup works
    // within the same tick.
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
  });

  it('explicit mode does not call RPC when every vote is already in the DB', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);

    const out = await service.getActiveVotePubkeys('explicit', [VOTE_A], 500);
    expect(out).toEqual([VOTE_A]);
    expect(rpc.getVoteAccounts).not.toHaveBeenCalled();
  });

  it('explicit mode returns [] for empty input without RPC', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);
    const out = await service.getActiveVotePubkeys('explicit', [], 500);
    expect(out).toEqual([]);
    expect(rpc.getVoteAccounts).not.toHaveBeenCalled();
  });

  it('all mode calls refreshFromRpc on first invocation', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);

    const out = await service.getActiveVotePubkeys('all', [], 500);
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
    expect(out).toContain(VOTE_A);
    expect(out).toContain(VOTE_B);
  });

  it('all mode uses the last-refresh cache on subsequent calls', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);

    await service.refreshFromRpc(500);
    const out = await service.getActiveVotePubkeys('all', [], 500);
    // refreshFromRpc is the only call that should have happened.
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
    expect(out).toContain(VOTE_A);
  });
});

describe('ValidatorService.getIdentityMap', () => {
  it('returns an empty map for an empty list', async () => {
    const repo = new FakeValidatorsRepo();
    const service = makeService(makeRpcStub(), repo);
    const map = await service.getIdentityMap([]);
    expect(map.size).toBe(0);
  });

  it('resolves each vote to its identity from the repo', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await repo.upsert({
      votePubkey: VOTE_B,
      identityPubkey: IDENTITY_B,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const service = makeService(makeRpcStub(), repo);

    const map = await service.getIdentityMap([VOTE_A, VOTE_B, 'missing']);
    expect(map.get(VOTE_A)).toBe(IDENTITY_A);
    expect(map.get(VOTE_B)).toBe(IDENTITY_B);
    expect(map.has('missing')).toBe(false);
  });

  it('does not include identities for unknown votes', async () => {
    const repo = new FakeValidatorsRepo();
    const service = makeService(makeRpcStub(), repo);

    const map = await service.getIdentityMap(['missing']);
    expect(map.size).toBe(0);
    // IDENTITY_C wasn't added; ensures IDENTITY_C import is exercised.
    expect(IDENTITY_C).toBeDefined();
  });
});

/**
 * `trackOnDemand` is the entry point for the history-route auto-track
 * flow: given an arbitrary pubkey (either a vote or an identity), it
 * resolves it against the live vote accounts, enforces the stake floor,
 * and registers the result into the dynamic watched set.
 *
 * These tests use the vote-accounts fixture (VOTE_A / IDENTITY_A) which
 * is stamped with 1_000_000_000_000 lamports activated stake — well
 * above the 1 SOL default minimum.
 */
describe('ValidatorService.trackOnDemand', () => {
  function makeServiceWithDynamic(rpc: Pick<SolanaRpcClient, 'getVoteAccounts'>): {
    service: ValidatorService;
    validatorsRepo: FakeValidatorsRepo;
    watchedDynamicRepo: FakeWatchedDynamicRepo;
  } {
    const validatorsRepo = new FakeValidatorsRepo();
    const watchedDynamicRepo = new FakeWatchedDynamicRepo();
    const service = new ValidatorService({
      validatorsRepo: validatorsRepo as unknown as ValidatorsRepository,
      watchedDynamicRepo: watchedDynamicRepo as unknown as WatchedDynamicRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });
    return { service, validatorsRepo, watchedDynamicRepo };
  }

  it('resolves an unknown vote pubkey via RPC and registers it', async () => {
    const rpc = makeRpcStub();
    const { service, validatorsRepo, watchedDynamicRepo } = makeServiceWithDynamic(rpc);

    const result = await service.trackOnDemand(VOTE_A);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.votePubkey).toBe(VOTE_A);
      expect(result.identityPubkey).toBe(IDENTITY_A);
      expect(result.newlyTracked).toBe(true);
    }
    // Side effects: refreshFromRpc ran so `validators` has both rows,
    // and watched-dynamic has the canonical vote pubkey.
    expect(validatorsRepo.rows.size).toBe(2);
    expect(await watchedDynamicRepo.findByVote(VOTE_A)).not.toBeNull();
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
  });

  it('accepts an identity pubkey and resolves it to the canonical vote', async () => {
    const rpc = makeRpcStub();
    const { service, watchedDynamicRepo } = makeServiceWithDynamic(rpc);

    // Passing IDENTITY_A — the service must map it back to VOTE_A.
    const result = await service.trackOnDemand(IDENTITY_A);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.votePubkey).toBe(VOTE_A);
      expect(result.identityPubkey).toBe(IDENTITY_A);
    }
    // The row in watched_validators_dynamic must be keyed by VOTE,
    // not by the identity the caller passed in — otherwise the
    // fee-ingester union would miss it.
    expect(await watchedDynamicRepo.findByVote(VOTE_A)).not.toBeNull();
  });

  it('marks newlyTracked=false on the second call for the same pubkey', async () => {
    const rpc = makeRpcStub();
    const { service } = makeServiceWithDynamic(rpc);

    const first = await service.trackOnDemand(VOTE_A);
    const second = await service.trackOnDemand(VOTE_A);

    expect(first.ok && first.newlyTracked).toBe(true);
    expect(second.ok && (second as { ok: true; newlyTracked: boolean }).newlyTracked).toBe(false);
  });

  it('returns ok:false when the pubkey is not in the RPC vote account set', async () => {
    const rpc = makeRpcStub();
    const { service, watchedDynamicRepo } = makeServiceWithDynamic(rpc);

    const result = await service.trackOnDemand('DefinitelyNotAPubkey');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not found among active/i);
    }
    // And nothing got added.
    expect((await watchedDynamicRepo.listVotes()).length).toBe(0);
  });

  it('does not repeat full vote-account refreshes for unknown pubkeys during cooldown', async () => {
    const rpc = makeRpcStub();
    const { service } = makeServiceWithDynamic(rpc);

    const first = await service.trackOnDemand('UnknownPubkey11111111111111111111111111111');
    const second = await service.trackOnDemand('UnknownPubkey22222222222222222222222222222');

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
  });

  it('caps the negative-cache map and evicts oldest pubkey first', async () => {
    const rpc = makeRpcStub();
    const validatorsRepo = new FakeValidatorsRepo();
    const watchedDynamicRepo = new FakeWatchedDynamicRepo();
    const service = new ValidatorService({
      validatorsRepo: validatorsRepo as unknown as ValidatorsRepository,
      watchedDynamicRepo: watchedDynamicRepo as unknown as WatchedDynamicRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
      onDemandNegativeCacheMaxEntries: 3,
    });

    // 4 distinct unknown pubkeys → cap=3 → first one must have been evicted.
    await service.trackOnDemand('Unknown1111111111111111111111111111111111');
    await service.trackOnDemand('Unknown2222222222222222222222222222222222');
    await service.trackOnDemand('Unknown3333333333333333333333333333333333');
    await service.trackOnDemand('Unknown4444444444444444444444444444444444');

    const cache = (service as unknown as { onDemandMissUntilByPubkey: Map<string, number> })
      .onDemandMissUntilByPubkey;
    expect(cache.size).toBe(3);
    expect(cache.has('Unknown1111111111111111111111111111111111')).toBe(false);
    expect(cache.has('Unknown4444444444444444444444444444444444')).toBe(true);
  });

  it('returns ok:false when activated stake falls below the floor', async () => {
    const rpc = makeRpcStub();
    const { service } = makeServiceWithDynamic(rpc);

    // Raise the floor past what the fixture carries.
    const result = await service.trackOnDemand(VOTE_A, {
      minActivatedStakeLamports: 10_000_000_000_000n, // 10k SOL
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/below the minimum/i);
    }
  });

  it('returns ok:false with a guidance message when the RPC refresh fails', async () => {
    const rpc: Pick<SolanaRpcClient, 'getVoteAccounts'> = {
      getVoteAccounts: vi.fn().mockRejectedValue(new Error('upstream timeout')),
    };
    const { service } = makeServiceWithDynamic(rpc);

    const result = await service.trackOnDemand(VOTE_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/temporary failure/i);
    }
  });

  it('returns ok:false when the dynamic registry is not wired', async () => {
    const rpc = makeRpcStub();
    // Build a service WITHOUT watchedDynamicRepo. Mirrors a misconfigured
    // deployment (e.g. an old-style entrypoint that forgot the repo).
    const service = new ValidatorService({
      validatorsRepo: new FakeValidatorsRepo() as unknown as ValidatorsRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    const result = await service.trackOnDemand(VOTE_A);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not wired/i);
    }
  });
});

/**
 * `ensureActivatedStakeLamports` is the seam the API process uses to
 * lazily populate its stake cache on the known-validator path. The API
 * `ValidatorService` instance has no periodic `refreshFromRpc` tick
 * (that runs on the worker only), so without lazy refresh, bulk-ingested
 * validators (see PR #25) would sit at a permanent cache miss and never
 * make it into `watched_validators_dynamic`. These tests lock down the
 * cache-hit / refresh-fill / refresh-failure / dedup / negative-cache
 * invariants of that seam.
 */
describe('ValidatorService.ensureActivatedStakeLamports', () => {
  /**
   * Type-safe helper for poking the private fields these tests rely on.
   * Keeps the casts readable + isolated.
   */
  type ServiceInternals = {
    onDemandMissUntilByPubkey: Map<string, number>;
    nextOnDemandRefreshAllowedAtMs: number;
  };

  it('returns source=cache without RPC when the cache is warm and leaves the negative cache untouched', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);

    // Seed the cache via a real refresh.
    await service.refreshFromRpc(0);
    (rpc.getVoteAccounts as ReturnType<typeof vi.fn>).mockClear();

    const result = await service.ensureActivatedStakeLamports(VOTE_A);
    expect(result).toEqual({ source: 'cache', lamports: 1_000_000_000_000n });
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(0);
    // The negative cache is reserved for trackOnDemand's unknown-pubkey
    // probes — known-path lookups must never write to it.
    expect((service as unknown as ServiceInternals).onDemandMissUntilByPubkey.size).toBe(0);
  });

  it('cache-cold triggers one RPC refresh and returns source=refresh; second call within cooldown stays at cache', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc = makeRpcStub();
    const service = makeService(rpc, repo);

    const first = await service.ensureActivatedStakeLamports(VOTE_A);
    expect(first).toEqual({ source: 'refresh', lamports: 1_000_000_000_000n });

    const second = await service.ensureActivatedStakeLamports(VOTE_A);
    expect(second).toEqual({ source: 'cache', lamports: 1_000_000_000_000n });

    // One RPC across both calls. NOTE: it's the cache-first lookup at the
    // top of `ensureActivatedStakeLamports` that prevents the second RPC,
    // NOT the success cooldown — by the time control would reach
    // `refreshOnDemandVoteAccounts`, the first refresh has already
    // populated the entry, so we return at the cache-hit branch. The
    // cooldown is what defends a DIFFERENT-vote cache-miss within the
    // 5-min window (covered separately). Asserting both here as defense-
    // in-depth: RPC call count AND cooldown gate engaged.
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
    expect((service as unknown as ServiceInternals).nextOnDemandRefreshAllowedAtMs).toBeGreaterThan(
      Date.now(),
    );
  });

  it('cache-cold + vote not in RPC reply returns source=unknown-vote and does not write the negative cache', async () => {
    const repo = new FakeValidatorsRepo();
    // Snapshot only carries VOTE_A; VOTE_B is absent.
    const rpc = makeRpcStub({
      current: [voteAccountsFixture.current[0]!],
      delinquent: [],
    });
    const service = makeService(rpc, repo);

    const result = await service.ensureActivatedStakeLamports(VOTE_B);
    expect(result).toEqual({ source: 'unknown-vote' });
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
    // Same invariant as the cache-warm case: known-path lookups must
    // never pollute trackOnDemand's negative cache.
    expect((service as unknown as ServiceInternals).onDemandMissUntilByPubkey.size).toBe(0);
  });

  it('returns source=refresh-failed without throwing and engages the failure cooldown', async () => {
    const repo = new FakeValidatorsRepo();
    const rpc: Pick<SolanaRpcClient, 'getVoteAccounts'> = {
      getVoteAccounts: vi.fn().mockRejectedValue(new Error('upstream timeout')),
    };
    const service = makeService(rpc, repo);

    const before = Date.now();
    // The first call must resolve (not reject) — the contract is that
    // route handlers can `await` without try/catch.
    await expect(service.ensureActivatedStakeLamports(VOTE_A)).resolves.toEqual(
      expect.objectContaining({ source: 'refresh-failed' }),
    );

    // The cooldown gate should now be ~30s in the future (failure cooldown).
    const nextAt = (service as unknown as ServiceInternals).nextOnDemandRefreshAllowedAtMs;
    expect(nextAt).toBeGreaterThanOrEqual(before + 25_000);
    expect(nextAt).toBeLessThanOrEqual(before + 35_000 + 1_000);

    // Negative cache is reserved for trackOnDemand — refresh failures
    // here must not write to it. (The cooldown gate alone bounds retry
    // pressure for OTHER votes that may be queried next: when
    // `lastRefresh.length === 0` the cold-start bypass intentionally
    // overrides the cooldown so the very first RPC attempt isn't
    // permanently shut out — this is the same posture as
    // `trackOnDemand` and is verified by its own test suite.)
    expect((service as unknown as ServiceInternals).onDemandMissUntilByPubkey.size).toBe(0);
  });

  it('two parallel cold-cache callers share a single RPC fetch (stampede dedup)', async () => {
    const repo = new FakeValidatorsRepo();
    // Manually-deferred promise so both callers race the same in-flight
    // refresh. Without dedup we'd see two parallel `getVoteAccounts`
    // calls; with it, both ensure() awaits resolve off one fetch.
    let resolveAccounts: ((value: typeof voteAccountsFixture) => void) | undefined;
    const accountsPromise = new Promise<typeof voteAccountsFixture>((resolve) => {
      resolveAccounts = resolve;
    });
    const rpc: Pick<SolanaRpcClient, 'getVoteAccounts'> = {
      getVoteAccounts: vi.fn().mockReturnValue(accountsPromise),
    };
    const service = makeService(rpc, repo);

    // Kick off both ensure() calls without awaiting — they should
    // collide on the same in-flight `onDemandRefreshPromise`.
    const pA = service.ensureActivatedStakeLamports(VOTE_A);
    const pB = service.ensureActivatedStakeLamports(VOTE_B);
    // Yield once so both calls reach their `await refreshOnDemandVoteAccounts()`.
    await Promise.resolve();
    // Now resolve the deferred RPC; both ensures unwind off the same fetch.
    resolveAccounts!(voteAccountsFixture);

    const [resultA, resultB] = await Promise.all([pA, pB]);
    expect(resultA).toEqual({ source: 'refresh', lamports: 1_000_000_000_000n });
    expect(resultB).toEqual({ source: 'refresh', lamports: 500_000_000_000n });
    // The load-bearing invariant: one RPC, two callers — the
    // onDemandRefreshPromise dedupe must collapse them.
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
  });
});

describe('ValidatorService.refreshValidatorInfoForIdentity', () => {
  function validatorInfo(configData: {
    name?: string;
    details?: string;
    website?: string;
    iconUrl?: string;
    keybaseUsername?: string;
  }): RpcValidatorInfoAccount {
    return {
      pubkey: 'Config1111111111111111111111111111111111111',
      account: {
        data: {
          parsed: {
            type: 'validatorInfo',
            info: {
              keys: [{ pubkey: IDENTITY_A, signer: true }],
              configData,
            },
          },
          program: 'spl-config',
        },
      },
    };
  }

  it('keeps only http(s) validator-info URLs', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const rpc = {
      getVoteAccounts: vi.fn(),
      getValidatorInfoForIdentity: vi.fn().mockResolvedValue(
        validatorInfo({
          name: '  Example Validator  ',
          website: 'javascript:alert(1)',
          iconUrl: 'https://example.com/icon.png',
        }),
      ),
    };
    const service = new ValidatorService({
      validatorsRepo: repo as unknown as ValidatorsRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    await service.refreshValidatorInfoForIdentity(IDENTITY_A);

    const row = await repo.findByVote(VOTE_A);
    expect(row?.name).toBe('Example Validator');
    expect(row?.website).toBeNull();
    expect(row?.iconUrl).toBe('https://example.com/icon.png');
  });
});

describe('ValidatorService.refreshAllValidatorInfo', () => {
  function infoAccount(
    identity: string,
    configData: {
      name?: string;
      details?: string;
      website?: string;
      iconUrl?: string;
      keybaseUsername?: string;
    },
    opts: { type?: string; signer?: boolean } = {},
  ): RpcValidatorInfoAccount {
    return {
      pubkey: 'Config1111111111111111111111111111111111111',
      account: {
        data: {
          parsed: {
            type: opts.type ?? 'validatorInfo',
            info: {
              keys: [
                { pubkey: 'Va1idator1nfo111111111111111111111111111111', signer: false },
                { pubkey: identity, signer: opts.signer ?? true },
              ],
              configData,
            },
          },
          program: 'spl-config',
        },
      },
    };
  }

  it('fills monikers cluster-wide from one getConfigProgramAccounts pull', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await repo.upsert({
      votePubkey: VOTE_B,
      identityPubkey: IDENTITY_B,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });

    // Before: neither validator has a name, so a moniker search misses both.
    expect(await repo.searchByText('chainflow', 10)).toHaveLength(0);

    const rpc = {
      getVoteAccounts: vi.fn(),
      getConfigProgramAccounts: vi.fn().mockResolvedValue([
        infoAccount(IDENTITY_A, {
          name: '  Chainflow  ',
          keybaseUsername: 'chainflow',
          website: 'https://chainflow.io',
        }),
        infoAccount(IDENTITY_B, { name: 'Chainflow Experimental' }),
      ]),
    };
    const service = new ValidatorService({
      validatorsRepo: repo as unknown as ValidatorsRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    const res = await service.refreshAllValidatorInfo();
    expect(res).toEqual({ observed: 2, updated: 2 });

    // After: BOTH Chainflow validators are now findable by name — the
    // discovery bug this job fixes.
    const hits = await repo.searchByText('chainflow', 10);
    expect(hits.map((r) => r.votePubkey).sort()).toEqual([VOTE_A, VOTE_B].sort());
    const a = await repo.findByVote(VOTE_A);
    expect(a?.name).toBe('Chainflow'); // whitespace-normalised
    expect(a?.website).toBe('https://chainflow.io/'); // http(s)-normalised
  });

  it('skips Config accounts the jsonParsed encoder fell back to raw bytes for', async () => {
    // Real-world response shape from a primary RPC: for accounts the
    // `jsonParsed` encoder can't decode (every Config account that isn't
    // a `validatorInfo`), `data` comes back as a `[base64, "base64"]`
    // tuple instead of a `{parsed, program}` object. The pre-fix loop
    // dereferenced `data.parsed.type` before filtering and threw on the
    // first such row — the entire bulk fill silently never landed, so
    // unwatched validators (e.g. the main Chainflow vs. the experimental
    // one) were never findable by moniker via /v1/validators/search.
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    await repo.upsert({
      votePubkey: VOTE_B,
      identityPubkey: IDENTITY_B,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const rawTupleAccount = {
      pubkey: 'StakeConfig11111111111111111111111111111111',
      account: {
        data: ['BAAAAAAAAAA=', 'base64'] as unknown as RpcValidatorInfoAccount['account']['data'],
      },
    } as RpcValidatorInfoAccount;
    const rpc = {
      getVoteAccounts: vi.fn(),
      getConfigProgramAccounts: vi
        .fn()
        .mockResolvedValue([
          rawTupleAccount,
          infoAccount(IDENTITY_A, { name: 'Chainflow' }),
          rawTupleAccount,
          infoAccount(IDENTITY_B, { name: 'Chainflow Experimental' }),
        ]),
    };
    const service = new ValidatorService({
      validatorsRepo: repo as unknown as ValidatorsRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    const res = await service.refreshAllValidatorInfo();
    expect(res).toEqual({ observed: 2, updated: 2 });

    // Both Chainflow validators are now findable — the discovery bug
    // (one matches, the other doesn't) does not reappear.
    const hits = await repo.searchByText('chainflow', 10);
    expect(hits.map((r) => r.votePubkey).sort()).toEqual([VOTE_A, VOTE_B].sort());
  });

  it('skips non-validatorInfo accounts and records without a signer identity', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const rpc = {
      getVoteAccounts: vi.fn(),
      getConfigProgramAccounts: vi.fn().mockResolvedValue([
        infoAccount(IDENTITY_A, { name: 'Kept' }),
        // A stake-config (non-validatorInfo) account returned by the same RPC.
        infoAccount(IDENTITY_C, { name: 'StakeConfig' }, { type: 'stakeConfig' }),
        // A validatorInfo record with no signer key — identity unreadable.
        infoAccount(IDENTITY_B, { name: 'NoSigner' }, { signer: false }),
      ]),
    };
    const service = new ValidatorService({
      validatorsRepo: repo as unknown as ValidatorsRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    const res = await service.refreshAllValidatorInfo();
    expect(res.observed).toBe(1); // only the validatorInfo+signer record counts
    expect((await repo.findByVote(VOTE_A))?.name).toBe('Kept');
  });

  it('counts observed pre-dedup so duplicate-identity records are visible (observed > unique)', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    // Same identity appears TWICE in the Config program response —
    // shouldn't happen in practice, but if it ever does, `observed`
    // surfaces the drift instead of silently collapsing to 1.
    const rpc = {
      getVoteAccounts: vi.fn(),
      getConfigProgramAccounts: vi
        .fn()
        .mockResolvedValue([
          infoAccount(IDENTITY_A, { name: 'First' }),
          infoAccount(IDENTITY_A, { name: 'Second' }),
        ]),
    };
    const service = new ValidatorService({
      validatorsRepo: repo as unknown as ValidatorsRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    const res = await service.refreshAllValidatorInfo();
    expect(res.observed).toBe(2); // both parsed records counted
    // Last-write-wins on the Map collapse — the repo sees the second.
    expect((await repo.findByVote(VOTE_A))?.name).toBe('Second');
  });

  it('is a zero-row write on a second, no-drift tick (IS DISTINCT FROM guard)', async () => {
    const repo = new FakeValidatorsRepo();
    await repo.upsert({
      votePubkey: VOTE_A,
      identityPubkey: IDENTITY_A,
      firstSeenEpoch: 500,
      lastSeenEpoch: 500,
    });
    const rpc = {
      getVoteAccounts: vi.fn(),
      getConfigProgramAccounts: vi
        .fn()
        .mockResolvedValue([infoAccount(IDENTITY_A, { name: 'Stable' })]),
    };
    const service = new ValidatorService({
      validatorsRepo: repo as unknown as ValidatorsRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    expect((await service.refreshAllValidatorInfo()).updated).toBe(1);
    expect((await service.refreshAllValidatorInfo()).updated).toBe(0);
  });
});

describe('ValidatorService.assessClaimEligibility', () => {
  it('shares the on-demand cooldown so a verify probe does not double the RPC fetch', async () => {
    const rpc = makeRpcStub();
    const validatorsRepo = new FakeValidatorsRepo();
    const watchedDynamicRepo = new FakeWatchedDynamicRepo();
    const service = new ValidatorService({
      validatorsRepo: validatorsRepo as unknown as ValidatorsRepository,
      watchedDynamicRepo: watchedDynamicRepo as unknown as WatchedDynamicRepository,
      rpc: rpc as unknown as SolanaRpcClient,
      logger: silent,
    });

    // First call resolves through a cold cache → triggers one refresh.
    const first = await service.assessClaimEligibility(
      'UnknownVote1111111111111111111111111111111',
    );
    expect(first.eligible).toBe(false);
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);

    // Second call within the cooldown window — the cache miss should
    // route through `refreshOnDemandVoteAccounts`, find the cooldown
    // engaged, and skip the RPC call instead of issuing a second one.
    const second = await service.assessClaimEligibility(
      'UnknownVote2222222222222222222222222222222',
    );
    expect(second.eligible).toBe(false);
    expect(rpc.getVoteAccounts).toHaveBeenCalledTimes(1);
  });
});
