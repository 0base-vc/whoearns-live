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

describe('StakewizClient.fetchValidatorGenesisEpochs', () => {
  it('maps vote_identity → first_epoch_with_stake', async () => {
    const body = JSON.stringify([
      { vote_identity: 'VoteA', identity: 'IdA', first_epoch_with_stake: 82 },
      { vote_identity: 'VoteB', identity: 'IdB', first_epoch_with_stake: 540 },
    ]);
    const client = new StakewizClient({ fetcher: streamingFetch(body), logger: silent });
    const map = await client.fetchValidatorGenesisEpochs();
    expect(map.size).toBe(2);
    expect(map.get('VoteA')).toBe(82);
    expect(map.get('VoteB')).toBe(540);
  });

  it('skips rows missing vote_identity or first_epoch_with_stake', async () => {
    const body = JSON.stringify([
      { vote_identity: 'VoteA', first_epoch_with_stake: 82 },
      { identity: 'IdB', first_epoch_with_stake: 540 }, // no vote_identity
      { vote_identity: 'VoteC' }, // no first_epoch_with_stake
      { vote_identity: 'VoteD', first_epoch_with_stake: -1 }, // negative
      { vote_identity: 'VoteE', first_epoch_with_stake: 'nope' }, // non-numeric
    ]);
    const client = new StakewizClient({ fetcher: streamingFetch(body), logger: silent });
    const map = await client.fetchValidatorGenesisEpochs();
    expect(map.size).toBe(1);
    expect(map.get('VoteA')).toBe(82);
  });

  it('floors a fractional first_epoch_with_stake', async () => {
    const body = JSON.stringify([{ vote_identity: 'VoteA', first_epoch_with_stake: 82.9 }]);
    const client = new StakewizClient({ fetcher: streamingFetch(body), logger: silent });
    const map = await client.fetchValidatorGenesisEpochs();
    expect(map.get('VoteA')).toBe(82);
  });

  it('throws on a non-2xx response', async () => {
    const client = new StakewizClient({
      fetcher: streamingFetch('[]', { status: 503 }),
      logger: silent,
    });
    await expect(client.fetchValidatorGenesisEpochs()).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the body is not a JSON array', async () => {
    const client = new StakewizClient({
      fetcher: streamingFetch('{"not":"an array"}'),
      logger: silent,
    });
    await expect(client.fetchValidatorGenesisEpochs()).rejects.toThrow(/not a JSON array/);
  });

  it('throws when the body is not valid JSON', async () => {
    const client = new StakewizClient({ fetcher: streamingFetch('<<garbage'), logger: silent });
    await expect(client.fetchValidatorGenesisEpochs()).rejects.toThrow(/not valid JSON/);
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
    await expect(client.fetchValidatorGenesisEpochs()).rejects.toThrow(/too large/);
    expect(bodyTouched).toBe(false);
  });
});
