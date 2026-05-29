import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { StakewizClient } from '../../../src/clients/stakewiz.js';

const silent = pino({ level: 'silent' });

/**
 * Build a stub `fetch` that returns the given JSON body as a streamed
 * response (so the client's streaming byte-counter path is exercised,
 * not just the `text()` fallback).
 */
function streamingFetch(body: string, init?: { status?: number }): typeof fetch {
  return (async () => {
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    return {
      ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
      status: init?.status ?? 200,
      headers: new Headers({ 'content-length': String(bytes.byteLength) }),
      body: {
        getReader: () => ({
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
        }),
      },
    };
  }) as unknown as typeof fetch;
}

describe('StakewizClient.fetchValidatorFacts', () => {
  it('maps vote_identity → tenure + MEV-commission facts', async () => {
    const body = JSON.stringify([
      {
        vote_identity: 'VoteA',
        first_epoch_with_stake: 82,
        is_jito: true,
        jito_commission_bps: 500,
      },
      {
        vote_identity: 'VoteB',
        first_epoch_with_stake: 540,
        is_jito: false,
        jito_commission_bps: 0,
      },
    ]);
    const client = new StakewizClient({ fetcher: streamingFetch(body), logger: silent });
    const map = await client.fetchValidatorFacts();
    expect(map.size).toBe(2);
    expect(map.get('VoteA')).toEqual({
      voteIdentity: 'VoteA',
      firstEpochWithStake: 82,
      jitoCommissionBps: 500,
      runsJito: true,
    });
    // is_jito false → runsJito false AND bps forced to null even
    // though the row carried a (stale) 0 — a non-Jito validator has
    // no MEV commission to report.
    expect(map.get('VoteB')).toEqual({
      voteIdentity: 'VoteB',
      firstEpochWithStake: 540,
      jitoCommissionBps: null,
      runsJito: false,
    });
  });

  it('keeps rows with a missing/invalid first_epoch_with_stake (null tenure) but skips rows missing vote_identity', async () => {
    const body = JSON.stringify([
      {
        vote_identity: 'VoteA',
        first_epoch_with_stake: 82,
        is_jito: true,
        jito_commission_bps: 100,
      },
      { identity: 'IdB', first_epoch_with_stake: 540 }, // no vote_identity → skipped entirely
      { vote_identity: 'VoteC', is_jito: true, jito_commission_bps: 250 }, // no tenure → kept, null tenure
      { vote_identity: 'VoteD', first_epoch_with_stake: -1 }, // negative tenure → null
      { vote_identity: 'VoteE', first_epoch_with_stake: 'nope' }, // non-numeric tenure → null
    ]);
    const client = new StakewizClient({ fetcher: streamingFetch(body), logger: silent });
    const map = await client.fetchValidatorFacts();
    expect(map.size).toBe(4); // VoteA, VoteC, VoteD, VoteE — NOT the no-vote_identity row
    expect(map.has('IdB')).toBe(false);
    expect(map.get('VoteA')?.firstEpochWithStake).toBe(82);
    // Tenure missing but MEV facts survive — the row isn't dropped.
    expect(map.get('VoteC')?.firstEpochWithStake).toBeNull();
    expect(map.get('VoteC')?.jitoCommissionBps).toBe(250);
    expect(map.get('VoteD')?.firstEpochWithStake).toBeNull();
    expect(map.get('VoteE')?.firstEpochWithStake).toBeNull();
  });

  it('gates MEV commission on is_jito and rejects out-of-range bps to null', async () => {
    const body = JSON.stringify([
      {
        vote_identity: 'NoJito',
        first_epoch_with_stake: 10,
        is_jito: false,
        jito_commission_bps: 800,
      },
      { vote_identity: 'MissingFlag', first_epoch_with_stake: 11, jito_commission_bps: 800 }, // no is_jito
      {
        vote_identity: 'OutHigh',
        first_epoch_with_stake: 12,
        is_jito: true,
        jito_commission_bps: 10001,
      },
      {
        vote_identity: 'OutLow',
        first_epoch_with_stake: 13,
        is_jito: true,
        jito_commission_bps: -5,
      },
      {
        vote_identity: 'Full',
        first_epoch_with_stake: 14,
        is_jito: true,
        jito_commission_bps: 10000,
      },
      { vote_identity: 'JitoNoBps', first_epoch_with_stake: 15, is_jito: true }, // runs Jito, bps absent
    ]);
    const client = new StakewizClient({ fetcher: streamingFetch(body), logger: silent });
    const map = await client.fetchValidatorFacts();
    // Not running Jito (explicit or missing flag) → no MEV commission.
    expect(map.get('NoJito')).toMatchObject({ runsJito: false, jitoCommissionBps: null });
    expect(map.get('MissingFlag')).toMatchObject({ runsJito: false, jitoCommissionBps: null });
    // Running Jito but bps out of [0, 10000] → null (don't trust it).
    expect(map.get('OutHigh')).toMatchObject({ runsJito: true, jitoCommissionBps: null });
    expect(map.get('OutLow')).toMatchObject({ runsJito: true, jitoCommissionBps: null });
    // 10000 bps (100%) is the valid ceiling.
    expect(map.get('Full')).toMatchObject({ runsJito: true, jitoCommissionBps: 10000 });
    // Runs Jito but stakewiz omitted the bps → null bps, runsJito true.
    expect(map.get('JitoNoBps')).toMatchObject({ runsJito: true, jitoCommissionBps: null });
  });

  it('floors a fractional first_epoch_with_stake and jito_commission_bps', async () => {
    const body = JSON.stringify([
      {
        vote_identity: 'VoteA',
        first_epoch_with_stake: 82.9,
        is_jito: true,
        jito_commission_bps: 512.7,
      },
    ]);
    const client = new StakewizClient({ fetcher: streamingFetch(body), logger: silent });
    const map = await client.fetchValidatorFacts();
    expect(map.get('VoteA')?.firstEpochWithStake).toBe(82);
    expect(map.get('VoteA')?.jitoCommissionBps).toBe(512);
  });

  it('throws on a non-2xx response', async () => {
    const client = new StakewizClient({
      fetcher: streamingFetch('[]', { status: 503 }),
      logger: silent,
    });
    await expect(client.fetchValidatorFacts()).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the body is not a JSON array', async () => {
    const client = new StakewizClient({
      fetcher: streamingFetch('{"not":"an array"}'),
      logger: silent,
    });
    await expect(client.fetchValidatorFacts()).rejects.toThrow(/not a JSON array/);
  });

  it('throws when the body is not valid JSON', async () => {
    const client = new StakewizClient({ fetcher: streamingFetch('<<garbage'), logger: silent });
    await expect(client.fetchValidatorFacts()).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a Content-Length larger than the cap without reading the body', async () => {
    let bodyTouched = false;
    const fetcher = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }),
      body: {
        getReader: () => {
          bodyTouched = true;
          throw new Error('should not reach the reader');
        },
        cancel: async () => {},
      },
    })) as unknown as typeof fetch;
    const client = new StakewizClient({ fetcher, logger: silent });
    await expect(client.fetchValidatorFacts()).rejects.toThrow(/too large/);
    expect(bodyTouched).toBe(false);
  });
});
