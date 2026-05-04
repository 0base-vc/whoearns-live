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
