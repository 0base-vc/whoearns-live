import { describe, expect, it } from 'vitest';
import {
  awaitMemoTxConfirmation,
  getBalanceLamports,
  getLatestBlockhash,
  getSignatureStatus,
  getSolanaRpcUrl,
  SolanaRpcError,
} from '../../../ui/src/lib/solana-rpc-client.js';

/**
 * Build a `fetch` stub that answers each JSON-RPC call by `method`.
 * `responders` maps an RPC method name to the `result` payload it
 * should return (or a function producing one per call).
 */
function rpcFetch(responders: Record<string, unknown | (() => unknown)>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    calls.push(body.method);
    const responder = responders[body.method];
    if (responder === undefined) {
      return new Response(JSON.stringify({ error: { message: `no stub for ${body.method}` } }), {
        status: 200,
      });
    }
    const result = typeof responder === 'function' ? (responder as () => unknown)() : responder;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const SIGNATURE = '5'.repeat(88);

describe('getSolanaRpcUrl', () => {
  it('falls back to the keyless public RPC when PUBLIC_SOLANA_RPC_URL is unset', () => {
    // The test stub for `$env/static/public` exports an empty string.
    expect(getSolanaRpcUrl()).toBe('https://solana-rpc.publicnode.com');
  });
});

describe('getBalanceLamports', () => {
  it('returns the lamport balance from getBalance', async () => {
    const { fetch, calls } = rpcFetch({ getBalance: { value: 250_000 } });
    await expect(getBalanceLamports('Wallet1111', fetch)).resolves.toBe(250_000);
    expect(calls).toEqual(['getBalance']);
  });

  it('throws SolanaRpcError on a non-numeric balance', async () => {
    const { fetch } = rpcFetch({ getBalance: { value: null } });
    await expect(getBalanceLamports('Wallet1111', fetch)).rejects.toBeInstanceOf(SolanaRpcError);
  });
});

describe('getLatestBlockhash', () => {
  it('returns the blockhash from getLatestBlockhash', async () => {
    const { fetch } = rpcFetch({
      getLatestBlockhash: { value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' } },
    });
    await expect(getLatestBlockhash(fetch)).resolves.toBe(
      'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    );
  });

  it('throws when no blockhash is returned', async () => {
    const { fetch } = rpcFetch({ getLatestBlockhash: { value: {} } });
    await expect(getLatestBlockhash(fetch)).rejects.toBeInstanceOf(SolanaRpcError);
  });
});

describe('getSignatureStatus', () => {
  it('returns the confirmation status when the cluster knows the signature', async () => {
    const { fetch } = rpcFetch({
      getSignatureStatuses: { value: [{ confirmationStatus: 'confirmed', err: null }] },
    });
    await expect(getSignatureStatus(SIGNATURE, fetch)).resolves.toBe('confirmed');
  });

  it('returns null when the cluster has no record of the signature', async () => {
    const { fetch } = rpcFetch({ getSignatureStatuses: { value: [null] } });
    await expect(getSignatureStatus(SIGNATURE, fetch)).resolves.toBeNull();
  });

  it('throws when the transaction errored on chain', async () => {
    const { fetch } = rpcFetch({
      getSignatureStatuses: {
        value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }],
      },
    });
    await expect(getSignatureStatus(SIGNATURE, fetch)).rejects.toBeInstanceOf(SolanaRpcError);
  });
});

describe('awaitMemoTxConfirmation', () => {
  it('resolves true once getSignatureStatuses reports confirmed', async () => {
    let polls = 0;
    const { fetch } = rpcFetch({
      getSignatureStatuses: () => {
        polls += 1;
        return { value: [polls >= 2 ? { confirmationStatus: 'confirmed', err: null } : null] };
      },
    });
    const confirmed = await awaitMemoTxConfirmation(SIGNATURE, {
      fetchFn: fetch,
      timeoutMs: 30_000,
      pollIntervalMs: 1_000,
      now: () => 0,
      sleep: async () => {},
    });
    expect(confirmed).toBe(true);
  });

  it('resolves false when the memo tx never confirms within the 30s window', async () => {
    // Status always null (cluster has no record) + a clock that
    // advances past the deadline → the timeout recovery path the UI
    // surfaces as `timeout`.
    const { fetch } = rpcFetch({ getSignatureStatuses: { value: [null] } });
    let n = 0;
    const ticks = [0, 31_000, 31_000];
    const timedOut = await awaitMemoTxConfirmation(SIGNATURE, {
      fetchFn: fetch,
      timeoutMs: 30_000,
      pollIntervalMs: 1_000,
      now: () => ticks[n++] ?? 31_000,
      sleep: async () => {},
    });
    expect(timedOut).toBe(false);
  });
});
