/**
 * Unit tests for `ClaimService` — the core Ed25519 verify + replay
 * gate for the Phase 3 validator-ownership flow.
 *
 * We generate real keypairs with `@noble/ed25519` inside each test
 * (it's fast — ~2ms per keypair) rather than hard-coding test
 * vectors. That way:
 *   - the tests exercise the ACTUAL crypto path end-to-end, not a
 *     canned byte sequence that could drift from reality
 *   - a future library bump that changes signature output bytes is
 *     invisible to these tests (they sign + verify both)
 *   - generating at runtime avoids embedding a secret key in the
 *     repo (even a test one would draw nervous security scans)
 *
 * Scenarios covered:
 *   - happy path (valid signature → claim persists)
 *   - bad signature (wrong keypair → rejected)
 *   - identity mismatch (keypair valid but not the one this vote
 *     declares on-chain → rejected with `identity_mismatch`)
 *   - stale timestamp (signed more than 5 min in the past)
 *   - future-dated timestamp (>5 min ahead of server clock)
 *   - nonce replay (same nonce submitted twice)
 *   - malformed signature (wrong length, bad base58)
 *   - validator_not_found (unknown vote pubkey)
 *   - offchain-message envelope (server and CLI must agree on bytes)
 *   - profile update flow (verify + persist, nonce bumped)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  getPublicKeyAsync as ed25519PublicKeyAsync,
  signAsync as ed25519SignAsync,
  utils as ed25519Utils,
} from '@noble/ed25519';
import { pino } from 'pino';
import {
  ClaimService,
  buildOffchainMessage,
  canonicaliseSignedPayload,
  MESSAGE_FRESHNESS_WINDOW_SEC,
  type SignedPayloadBody,
} from '../../../src/services/claim.service.js';
import type { ClaimsRepository } from '../../../src/storage/repositories/claims.repo.js';
import type { ProfilesRepository } from '../../../src/storage/repositories/profiles.repo.js';
import type { ValidatorsRepository } from '../../../src/storage/repositories/validators.repo.js';
import type {
  Validator,
  ValidatorClaim,
  ValidatorProfile,
  VotePubkey,
} from '../../../src/types/domain.js';

const silent = pino({ level: 'silent' });

// Deterministic pubkey for the vote account — doesn't need to be a
// real pubkey on-chain, just a stable string. Our verification
// logic never decodes this; it's an opaque identifier in the DB.
const VOTE = 'SFund7s2YPS7iCu7W2TobbuQEpVEAv9ZU7zHKiN1Gow';

/**
 * Generate a fresh ed25519 keypair and return it in the same encoding
 * the production code uses: identity pubkey as base58 string, secret
 * as raw bytes. `@noble/ed25519` v3 exposes getPublicKey as async
 * because it routes through WebCrypto when available.
 */
async function generateIdentityKeypair(): Promise<{
  identityBase58: string;
  secret: Uint8Array;
  publicBytes: Uint8Array;
}> {
  // `@noble/ed25519` v3 renamed `randomPrivateKey` → `randomSecretKey`.
  // We keep the old name as a fallback for backwards-compat in case
  // a downgrade happens.
  const secret =
    (
      ed25519Utils as unknown as {
        randomSecretKey?: () => Uint8Array;
        randomPrivateKey?: () => Uint8Array;
      }
    ).randomSecretKey?.() ??
    (
      ed25519Utils as unknown as {
        randomPrivateKey: () => Uint8Array;
      }
    ).randomPrivateKey();
  const publicBytes = await ed25519PublicKeyAsync(secret);
  return {
    identityBase58: bs58.encode(publicBytes),
    secret,
    publicBytes,
  };
}

/**
 * Sign a canonical payload with the given keypair, returning the
 * base58 signature string that the API accepts.
 */
async function signPayload(body: SignedPayloadBody, secret: Uint8Array): Promise<string> {
  const canonical = canonicaliseSignedPayload(body);
  const envelope = buildOffchainMessage(canonical);
  const sig = await ed25519SignAsync(envelope, secret);
  return bs58.encode(sig);
}

/**
 * In-memory fakes. Deliberately minimal — we only implement the
 * methods the service actually calls so the test surface documents
 * the real dependency contract.
 */
class FakeClaimsRepo implements Pick<ClaimsRepository, 'findByVote' | 'upsert' | 'bumpNonce'> {
  private rows = new Map<VotePubkey, ValidatorClaim>();

  async findByVote(vote: VotePubkey): Promise<ValidatorClaim | null> {
    return this.rows.get(vote) ?? null;
  }
  async upsert(args: {
    votePubkey: VotePubkey;
    identityPubkey: string;
    nonce: string;
  }): Promise<void> {
    this.rows.set(args.votePubkey, {
      votePubkey: args.votePubkey,
      identityPubkey: args.identityPubkey,
      claimedAt: new Date(),
      lastNonceUsed: args.nonce,
    });
  }
  async bumpNonce(args: { votePubkey: VotePubkey; nonce: string }): Promise<void> {
    const existing = this.rows.get(args.votePubkey);
    if (existing !== undefined) {
      this.rows.set(args.votePubkey, { ...existing, lastNonceUsed: args.nonce });
    }
  }
}

class FakeProfilesRepo implements Pick<ProfilesRepository, 'findByVote' | 'upsert'> {
  public rows = new Map<VotePubkey, ValidatorProfile>();

  async findByVote(vote: VotePubkey): Promise<ValidatorProfile | null> {
    return this.rows.get(vote) ?? null;
  }
  async upsert(args: {
    votePubkey: VotePubkey;
    twitterHandle: string | null;
    hideFooterCta: boolean;
    optedOut: boolean;
    narrativeOverride: string | null;
  }): Promise<void> {
    this.rows.set(args.votePubkey, {
      votePubkey: args.votePubkey,
      twitterHandle: args.twitterHandle,
      hideFooterCta: args.hideFooterCta,
      optedOut: args.optedOut,
      narrativeOverride: args.narrativeOverride,
      updatedAt: new Date(),
    });
  }
}

class FakeValidatorsRepo implements Pick<ValidatorsRepository, 'findByVote' | 'findByIdentity'> {
  public rows = new Map<VotePubkey, Validator>();

  async findByVote(vote: VotePubkey): Promise<Validator | null> {
    return this.rows.get(vote) ?? null;
  }
  async findByIdentity(): Promise<Validator | null> {
    return null;
  }
  addValidator(vote: VotePubkey, identity: string): void {
    this.rows.set(vote, {
      votePubkey: vote,
      identityPubkey: identity,
      firstSeenEpoch: 950,
      lastSeenEpoch: 960,
      updatedAt: new Date(),
      name: null,
      details: null,
      website: null,
      keybaseUsername: null,
      iconUrl: null,
      infoUpdatedAt: null,
    });
  }
}

function makeService(now: number = Date.now()): {
  service: ClaimService;
  claims: FakeClaimsRepo;
  profiles: FakeProfilesRepo;
  validators: FakeValidatorsRepo;
} {
  const claims = new FakeClaimsRepo();
  const profiles = new FakeProfilesRepo();
  const validators = new FakeValidatorsRepo();
  const service = new ClaimService({
    claimsRepo: claims as unknown as ClaimsRepository,
    profilesRepo: profiles as unknown as ProfilesRepository,
    validatorsRepo: validators as unknown as ValidatorsRepository,
    logger: silent,
    now: () => now,
  });
  return { service, claims, profiles, validators };
}

describe('canonicaliseSignedPayload', () => {
  it('produces a deterministic, line-oriented text body', () => {
    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: 'V',
      identityPubkey: 'I',
      nonce: 'N1',
      timestampSec: 1700000000,
    };
    // Stable output — if this ever changes, every deployed signed
    // message invalidates simultaneously, so this is effectively a
    // protocol-version assertion.
    expect(canonicaliseSignedPayload(body)).toBe(
      ['purpose=claim', 'vote=V', 'identity=I', 'nonce=N1', 'ts=1700000000'].join('\n'),
    );
  });

  it('appends profile lines when a profile is attached', () => {
    const body: SignedPayloadBody = {
      purpose: 'profile',
      votePubkey: 'V',
      identityPubkey: 'I',
      nonce: 'N1',
      timestampSec: 1700000000,
      profile: {
        twitterHandle: 'alice',
        hideFooterCta: true,
        optedOut: false,
        narrativeOverride: null,
      },
    };
    expect(canonicaliseSignedPayload(body)).toBe(
      [
        'purpose=profile',
        'vote=V',
        'identity=I',
        'nonce=N1',
        'ts=1700000000',
        'twitter=alice',
        'hideFooterCta=1',
        'optedOut=0',
        // narrative is always present in canonical form even when null
        // (lexical-position invariant — see canonicaliseSignedPayload).
        'narrative=',
      ].join('\n'),
    );
  });

  it('treats missing twitter handle as empty string', () => {
    const body: SignedPayloadBody = {
      purpose: 'profile',
      votePubkey: 'V',
      identityPubkey: 'I',
      nonce: 'N1',
      timestampSec: 1700000000,
      profile: {
        twitterHandle: null,
        hideFooterCta: false,
        optedOut: true,
        narrativeOverride: null,
      },
    };
    // Null renders as `twitter=`, not `twitter=null` — consistent
    // with the DB semantic of "empty string maps to NULL".
    expect(canonicaliseSignedPayload(body)).toContain('twitter=\n');
  });

  it('inlines narrativeOverride and escapes newlines so the canonical form stays one-line-per-field', () => {
    const body: SignedPayloadBody = {
      purpose: 'profile',
      votePubkey: 'V',
      identityPubkey: 'I',
      nonce: 'N1',
      timestampSec: 1700000000,
      profile: {
        twitterHandle: 'alice',
        hideFooterCta: false,
        optedOut: false,
        narrativeOverride: 'first line\nsecond line\nthird',
      },
    };
    const out = canonicaliseSignedPayload(body);
    // Only ONE physical line containing `narrative=` — embedded
    // newlines must be escaped so the line-delimited form stays
    // unambiguous. An attacker can't smuggle additional fields by
    // injecting `\noptedOut=1` into the override.
    expect(out.split('\n').filter((l) => l.startsWith('narrative=')).length).toBe(1);
    expect(out).toContain('narrative=first line\\nsecond line\\nthird');
  });
});

describe('buildOffchainMessage', () => {
  // Empirically-verified Solana offchain-message envelope (Agave CLI 3.0.13):
  //   0x00 + 16  prefix  (0xFF + "solana offchain")
  //   0x10 +  1  version (= 0)
  //   0x11 +  1  format  (1 = UTF-8 — we use this so `\n` is allowed)
  //   0x12 +  2  msgLen  (u16 LE)
  //   0x14 +  N  message
  // Total header = 20 bytes.
  //
  // The Anza spec page describes a richer "future-ready" form (with
  // 32-byte appDomain + signer_count + signers fields, header total
  // 85 bytes), but the current CLI does NOT serialise those fields.
  // See service file docstring for the full discrepancy notes and
  // the probe procedure in case the spec gets implemented later.
  const HEADER_LEN = 20;

  it('produces the spec-compliant 20-byte header for a "hello" message', () => {
    const out = buildOffchainMessage('hello');

    // 0xFF + b"solana offchain"
    expect(out[0]).toBe(0xff);
    expect(String.fromCharCode(...out.slice(1, 16))).toBe('solana offchain');
    // version = 0
    expect(out[16]).toBe(0);
    // format = 1 (UTF-8). NOT 0 (ASCII) — `\n` in our payload would be
    // out-of-range for ASCII format, AND the CLI auto-picks UTF-8 for
    // any input with non-printable bytes, so we match its choice.
    expect(out[17]).toBe(1);
    // message_length = 5 (u16 LE)
    expect(out[18]).toBe(5);
    expect(out[19]).toBe(0);
    // message bytes
    expect(String.fromCharCode(...out.slice(20, 25))).toBe('hello');
    expect(out.length).toBe(HEADER_LEN + 5);
  });

  it('handles the empty string without trailing garbage', () => {
    const out = buildOffchainMessage('');
    expect(out[18]).toBe(0);
    expect(out[19]).toBe(0);
    expect(out.length).toBe(HEADER_LEN);
  });

  it('encodes a UTF-8 message containing newlines without truncation', () => {
    // Our canonical signed payload uses `\n` as a separator. Format 0
    // (ASCII) would reject that range; we use format 1 (UTF-8) so the
    // envelope passes through cleanly. The CLI does the same auto-
    // selection — verified empirically (see service docstring).
    const msg = 'a\nb\nc';
    const out = buildOffchainMessage(msg);
    expect(out[17]).toBe(1); // format = UTF-8
    // Length is 5 bytes (a, \n, b, \n, c).
    expect(out[18]).toBe(5);
    expect(out[19]).toBe(0);
    expect(out.length).toBe(HEADER_LEN + 5);
  });

  it('encodes a multi-byte length correctly (u16 LE)', () => {
    // 256 bytes triggers the high byte of the length header — checks
    // we got LE byte order right (lo first, then hi).
    const msg = 'x'.repeat(256);
    const out = buildOffchainMessage(msg);
    expect(out[18]).toBe(0); // low byte = 0
    expect(out[19]).toBe(1); // high byte = 1 (256 = 0x0100)
    expect(out.length).toBe(HEADER_LEN + 256);
  });
});

describe('ClaimService.verifySigned', () => {
  let fixedNow: number;

  beforeEach(() => {
    // Mid-range timestamp so both +/- freshness tests have room to
    // move without hitting 1970 or the year-2038 edge.
    fixedNow = 1_730_000_000_000; // ~2024-10-27 UTC
  });

  it('accepts a fresh, correctly-signed claim and persists the row', async () => {
    const { service, claims, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'nonce-001',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    const sig = await signPayload(body, kp.secret);

    const result = await service.verifySigned({ body, signatureBase58: sig });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.votePubkey).toBe(VOTE);
      expect(result.claim.identityPubkey).toBe(kp.identityBase58);
      expect(result.claim.lastNonceUsed).toBe('nonce-001');
    }
    const persisted = await claims.findByVote(VOTE);
    expect(persisted).not.toBeNull();
  });

  it('rejects a signature from a DIFFERENT keypair (bad_signature)', async () => {
    // Fingerprint of the attack: attacker signs with their own
    // keypair but claims it's the validator's identity. The
    // signature verifies arithmetically against THEIR pubkey, not
    // the one they're claiming — verification fails.
    const { service, validators } = makeService(fixedNow);
    const realKp = await generateIdentityKeypair();
    const attackerKp = await generateIdentityKeypair();
    validators.addValidator(VOTE, realKp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: realKp.identityBase58, // claims to be the real identity
      nonce: 'nonce-002',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    const sig = await signPayload(body, attackerKp.secret); // signs with wrong key

    const result = await service.verifySigned({ body, signatureBase58: sig });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects when the signed identity does not match on-chain (identity_mismatch)', async () => {
    // Attacker owns a valid keypair but tries to use it to claim a
    // vote pubkey that's registered to a DIFFERENT identity on-chain.
    const { service, validators } = makeService(fixedNow);
    const realIdentityKp = await generateIdentityKeypair();
    const attackerKp = await generateIdentityKeypair();
    validators.addValidator(VOTE, realIdentityKp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: attackerKp.identityBase58, // wrong identity
      nonce: 'nonce-003',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    const sig = await signPayload(body, attackerKp.secret);

    const result = await service.verifySigned({ body, signatureBase58: sig });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_mismatch');
  });

  it('rejects a stale timestamp (more than 5 minutes old)', async () => {
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'nonce-004',
      timestampSec: Math.floor(fixedNow / 1000) - MESSAGE_FRESHNESS_WINDOW_SEC - 10,
    };
    const sig = await signPayload(body, kp.secret);

    const result = await service.verifySigned({ body, signatureBase58: sig });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale_timestamp');
  });

  it('rejects a future-dated timestamp (more than 5 min ahead)', async () => {
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'nonce-005',
      timestampSec: Math.floor(fixedNow / 1000) + MESSAGE_FRESHNESS_WINDOW_SEC + 10,
    };
    const sig = await signPayload(body, kp.secret);

    const result = await service.verifySigned({ body, signatureBase58: sig });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale_timestamp');
  });

  it('rejects a nonce replay (same nonce submitted twice)', async () => {
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'nonce-same',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    const sig = await signPayload(body, kp.secret);

    const first = await service.verifySigned({ body, signatureBase58: sig });
    expect(first.ok).toBe(true);

    // Re-submit exactly the same payload → replay detection fires.
    const second = await service.verifySigned({ body, signatureBase58: sig });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('nonce_replay');
  });

  it('accepts a SECOND request with a fresh nonce (cursor advances)', async () => {
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body1: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'nonce-101',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    const sig1 = await signPayload(body1, kp.secret);
    const first = await service.verifySigned({ body: body1, signatureBase58: sig1 });
    expect(first.ok).toBe(true);

    const body2: SignedPayloadBody = { ...body1, nonce: 'nonce-102' };
    const sig2 = await signPayload(body2, kp.secret);
    const second = await service.verifySigned({ body: body2, signatureBase58: sig2 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.claim.lastNonceUsed).toBe('nonce-102');
  });

  it('rejects a malformed signature (wrong length)', async () => {
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'nonce-006',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    // 32 bytes (pubkey length) instead of 64 (signature length)
    const tooShort = bs58.encode(new Uint8Array(32));
    const result = await service.verifySigned({ body, signatureBase58: tooShort });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed_signature');
  });

  it('rejects when the validator is unknown (validator_not_found)', async () => {
    const { service } = makeService(fixedNow); // no validators added
    const kp = await generateIdentityKeypair();

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'nonce-007',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    const sig = await signPayload(body, kp.secret);
    const result = await service.verifySigned({ body, signatureBase58: sig });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('validator_not_found');
  });
});

describe('ClaimService.updateProfile', () => {
  const fixedNow = 1_730_000_000_000;

  it('verifies and persists a profile, then rejects the same nonce on replay', async () => {
    const { service, profiles, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody & { profile: NonNullable<SignedPayloadBody['profile']> } = {
      purpose: 'profile',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'prof-001',
      timestampSec: Math.floor(fixedNow / 1000),
      profile: {
        twitterHandle: 'alice',
        hideFooterCta: true,
        optedOut: false,
        narrativeOverride: null,
      },
    };
    const sig = await signPayload(body, kp.secret);

    const result = await service.updateProfile({ body, signatureBase58: sig });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.twitterHandle).toBe('alice');
      expect(result.profile.hideFooterCta).toBe(true);
      expect(result.profile.optedOut).toBe(false);
    }
    const persisted = await profiles.findByVote(VOTE);
    expect(persisted?.twitterHandle).toBe('alice');

    // Replay fails.
    const replay = await service.updateProfile({ body, signatureBase58: sig });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('nonce_replay');
  });

  it('rejects profile update when signature does not match the profile fields', async () => {
    // Attacker intercepts a signed profile update and changes the
    // profile content (e.g. flips optedOut from false to true) but
    // replays the signature. The signed canonical bytes differ from
    // what we'd reconstruct, so verify fails.
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const originalBody = {
      purpose: 'profile' as const,
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'prof-002',
      timestampSec: Math.floor(fixedNow / 1000),
      profile: {
        twitterHandle: 'alice',
        hideFooterCta: false,
        optedOut: false,
        narrativeOverride: null,
      },
    };
    const sig = await signPayload(originalBody, kp.secret);

    // Attacker-modified body — same nonce/signature but different
    // profile fields.
    const tamperedBody = {
      ...originalBody,
      profile: {
        twitterHandle: 'alice',
        hideFooterCta: false,
        optedOut: true,
        narrativeOverride: null,
      }, // flipped
    };

    const result = await service.updateProfile({ body: tamperedBody, signatureBase58: sig });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });
});

describe('ClaimService.getClaim and getProfile (status endpoint backbone)', () => {
  // The status endpoint reads BOTH `getClaim` and `getProfile` to
  // distinguish three states. Earlier the endpoint relied solely on
  // `getProfile` and conflated "no profile row" with "not claimed",
  // which sent claimed-but-never-edited operators back through the
  // first-claim flow on every visit. These tests pin all three
  // states so a future edit can't silently regress that behaviour.
  const fixedNow = 1_730_000_000_000;

  it('state A: never claimed → both nulls', async () => {
    const { service } = makeService(fixedNow); // empty repos
    const claim = await service.getClaim(VOTE);
    const profile = await service.getProfile(VOTE);
    expect(claim).toBeNull();
    expect(profile).toBeNull();
  });

  it('state B: claimed but no profile edit yet → claim non-null, profile null', async () => {
    // The exact regression the previous status-endpoint logic
    // mishandled. After verifySigned succeeds, the claim row
    // exists but `validator_profiles` has nothing until the first
    // updateProfile call.
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody = {
      purpose: 'claim',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'state-b-nonce',
      timestampSec: Math.floor(fixedNow / 1000),
    };
    const verify = await service.verifySigned({
      body,
      signatureBase58: await signPayload(body, kp.secret),
    });
    expect(verify.ok).toBe(true);

    expect(await service.getClaim(VOTE)).not.toBeNull();
    expect(await service.getProfile(VOTE)).toBeNull();
  });

  it('state C: claimed AND profile edited → both non-null with correct values', async () => {
    const { service, validators } = makeService(fixedNow);
    const kp = await generateIdentityKeypair();
    validators.addValidator(VOTE, kp.identityBase58);

    const body: SignedPayloadBody & { profile: NonNullable<SignedPayloadBody['profile']> } = {
      purpose: 'profile',
      votePubkey: VOTE,
      identityPubkey: kp.identityBase58,
      nonce: 'state-c-nonce',
      timestampSec: Math.floor(fixedNow / 1000),
      profile: {
        twitterHandle: 'alice',
        hideFooterCta: true,
        optedOut: false,
        narrativeOverride: null,
      },
    };
    const result = await service.updateProfile({
      body,
      signatureBase58: await signPayload(body, kp.secret),
    });
    expect(result.ok).toBe(true);

    const claim = await service.getClaim(VOTE);
    const profile = await service.getProfile(VOTE);
    expect(claim?.identityPubkey).toBe(kp.identityBase58);
    expect(profile?.twitterHandle).toBe('alice');
    expect(profile?.hideFooterCta).toBe(true);
    expect(profile?.optedOut).toBe(false);
  });
});
