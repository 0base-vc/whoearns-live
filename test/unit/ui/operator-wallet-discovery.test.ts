import { describe, expect, it } from 'vitest';
import { encodeBase58 } from '../../../ui/src/lib/base58.js';
import {
  OPERATOR_WALLET_CONNECT_FEATURE,
  OPERATOR_WALLET_SIGN_AND_SEND_FEATURE,
  OPERATOR_WALLET_SIGN_TRANSACTION_FEATURE,
  connectSelectedOperatorWallet,
  createOperatorWalletSelectionState,
  detectSupportedOperatorWallets,
  discoverSupportedOperatorWallets,
  sendMemoTransaction,
  type ConnectedOperatorWallet,
  type WalletStandardConnectFeature,
  type WalletStandardWallet,
} from '../../../ui/src/lib/operator-wallet-discovery.js';

function wallet(args: {
  name: string;
  version?: string;
  features?: readonly string[] | Record<string, object>;
  chains?: readonly string[];
  accounts?: WalletStandardWallet['accounts'];
}): WalletStandardWallet {
  const features = Array.isArray(args.features)
    ? Object.fromEntries(args.features.map((feature) => [feature, {}]))
    : (args.features ??
      Object.fromEntries(
        [OPERATOR_WALLET_CONNECT_FEATURE, OPERATOR_WALLET_SIGN_AND_SEND_FEATURE].map((feature) => [
          feature,
          {},
        ]),
      ));
  const detectedWallet: WalletStandardWallet = {
    name: args.name,
    chains: args.chains ?? ['solana:mainnet'],
    features,
  };
  const withAccounts =
    args.accounts === undefined ? detectedWallet : { ...detectedWallet, accounts: args.accounts };
  if (args.version !== undefined) {
    return { ...withAccounts, version: args.version };
  }
  return withAccounts;
}

describe('detectSupportedOperatorWallets', () => {
  it('detects Phantom and Backpack as merge-gate Wallet Standard wallets', () => {
    const detected = detectSupportedOperatorWallets([
      wallet({ name: 'Phantom', version: '1.2.3' }),
      wallet({ name: 'Backpack', version: '4.5.6' }),
    ]);

    expect(detected).toMatchObject([
      {
        name: 'Phantom',
        normalizedName: 'phantom',
        version: '1.2.3',
        supportTier: 'merge-gate',
        canConnect: true,
        canSignAndSendTransaction: true,
      },
      {
        name: 'Backpack',
        normalizedName: 'backpack',
        version: '4.5.6',
        supportTier: 'merge-gate',
        canConnect: true,
        canSignAndSendTransaction: true,
      },
    ]);
  });

  it('detects Solflare and Ledger-capable wallets as best-effort supported wallets', () => {
    const detected = detectSupportedOperatorWallets([
      wallet({
        name: 'Solflare',
        features: [OPERATOR_WALLET_CONNECT_FEATURE, OPERATOR_WALLET_SIGN_TRANSACTION_FEATURE],
      }),
      wallet({
        name: 'Phantom Ledger',
        features: [OPERATOR_WALLET_CONNECT_FEATURE, OPERATOR_WALLET_SIGN_TRANSACTION_FEATURE],
      }),
    ]);

    expect(
      detected.map((entry) => [entry.name, entry.supportTier, entry.canSignTransaction]),
    ).toEqual([
      ['Solflare', 'best-effort', true],
      ['Phantom Ledger', 'best-effort', true],
    ]);
  });

  it('rejects unsupported names, missing transaction signing, missing connect, and non-Solana chains', () => {
    const detected = detectSupportedOperatorWallets([
      wallet({ name: 'Unknown Wallet' }),
      wallet({ name: 'Phantom', features: [OPERATOR_WALLET_CONNECT_FEATURE] }),
      wallet({ name: 'Backpack', features: [OPERATOR_WALLET_SIGN_AND_SEND_FEATURE] }),
      wallet({ name: 'Solflare', chains: ['eip155:1'] }),
    ]);

    expect(detected).toEqual([]);
  });
});

describe('discoverSupportedOperatorWallets', () => {
  it('reads wallets from a Wallet Standard registry-compatible object', () => {
    const registry = {
      get: () => [wallet({ name: 'Phantom' })],
    };

    expect(discoverSupportedOperatorWallets(registry)).toHaveLength(1);
  });
});

describe('connectSelectedOperatorWallet', () => {
  it('initiates Wallet Standard connect on the selected wallet and returns the connected Solana account', async () => {
    const connectCalls: unknown[] = [];
    const connectFeature: WalletStandardConnectFeature = {
      connect: async (input) => {
        connectCalls.push(input);
        return {
          accounts: [
            {
              address: '7Zb1w7QLhT1vJZcmtw7vQxCuAq2k5rUyqXMeZWG7SxYh',
              chains: ['solana:mainnet'],
            },
          ],
        };
      },
    };
    const detected = detectSupportedOperatorWallets([
      wallet({
        name: 'Phantom',
        features: {
          [OPERATOR_WALLET_CONNECT_FEATURE]: connectFeature,
          [OPERATOR_WALLET_SIGN_AND_SEND_FEATURE]: {},
        },
      }),
    ]);
    const selectedWallet = detected[0];
    if (selectedWallet === undefined) throw new Error('expected a detected Phantom wallet');

    const connected = await connectSelectedOperatorWallet(selectedWallet);

    expect(connectCalls).toEqual([{ silent: false }]);
    expect(connected.wallet).toBe(selectedWallet);
    expect(connected.walletPubkey).toBe('7Zb1w7QLhT1vJZcmtw7vQxCuAq2k5rUyqXMeZWG7SxYh');
  });
});

describe('createOperatorWalletSelectionState', () => {
  it('exposes discovered wallets as selectable UI options', () => {
    const discovered = detectSupportedOperatorWallets([
      wallet({ name: 'Phantom', version: '1.2.3' }),
      wallet({ name: 'Backpack', version: '4.5.6' }),
    ]);

    const initial = createOperatorWalletSelectionState(discovered);

    expect(initial.options).toMatchObject([
      {
        id: 'phantom:1.2.3:0',
        value: 'phantom:1.2.3:0',
        label: 'Phantom',
        detail: '1.2.3 · merge-gate',
        supportTier: 'merge-gate',
        selected: true,
      },
      {
        id: 'backpack:4.5.6:1',
        value: 'backpack:4.5.6:1',
        label: 'Backpack',
        detail: '4.5.6 · merge-gate',
        supportTier: 'merge-gate',
        selected: false,
      },
    ]);
    expect(initial.selectedWallet?.name).toBe('Phantom');

    const selected = createOperatorWalletSelectionState(discovered, 'backpack:4.5.6:1');

    expect(selected.selectedOption?.label).toBe('Backpack');
    expect(selected.selectedWallet?.wallet).toBe(discovered[1]?.wallet);
    expect(selected.options.map((option) => option.selected)).toEqual([false, true]);
  });
});

describe('sendMemoTransaction', () => {
  /** A connected wallet whose sign-and-send feature is `feature`. */
  function connectedWith(feature: object): ConnectedOperatorWallet {
    const account = {
      address: '7Zb1w7QLhT1vJZcmtw7vQxCuAq2k5rUyqXMeZWG7SxYh',
      chains: ['solana:mainnet'],
    };
    const detected = detectSupportedOperatorWallets([
      wallet({
        name: 'Phantom',
        accounts: [account],
        features: {
          [OPERATOR_WALLET_CONNECT_FEATURE]: {},
          [OPERATOR_WALLET_SIGN_AND_SEND_FEATURE]: feature,
        },
      }),
    ]);
    const supported = detected[0];
    if (supported === undefined) throw new Error('expected a detected wallet');
    return { wallet: supported, account, walletPubkey: account.address };
  }

  it('signs and sends the transaction via the Wallet Standard feature and returns a base58 signature', async () => {
    const sigBytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 13) % 256);
    const sent: Array<{ transaction: Uint8Array; chain: string }> = [];
    const connected = connectedWith({
      signAndSendTransaction: async (input: { transaction: Uint8Array; chain: string }) => {
        sent.push({ transaction: input.transaction, chain: input.chain });
        return [{ signature: sigBytes }];
      },
    });
    const transaction = Uint8Array.from([1, 2, 3]);

    const signature = await sendMemoTransaction({ connected, transaction });

    expect(signature).toBe(encodeBase58(sigBytes));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.transaction).toBe(transaction);
    expect(sent[0]?.chain).toBe('solana:mainnet');
  });

  it('throws when the wallet returns no signature', async () => {
    const connected = connectedWith({
      signAndSendTransaction: async () => [],
    });
    await expect(
      sendMemoTransaction({ connected, transaction: Uint8Array.from([0]) }),
    ).rejects.toThrow(/no transaction signature/);
  });
});
