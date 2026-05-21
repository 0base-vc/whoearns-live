import { encodeBase58 } from './base58.js';

export const OPERATOR_WALLET_SIGN_AND_SEND_FEATURE = 'solana:signAndSendTransaction';
export const OPERATOR_WALLET_SIGN_TRANSACTION_FEATURE = 'solana:signTransaction';
export const OPERATOR_WALLET_CONNECT_FEATURE = 'standard:connect';

/**
 * Wallet Standard chain id the memo transaction targets. Mainnet —
 * the operator-wallet registration is a real on-chain transaction.
 */
export const OPERATOR_WALLET_SOLANA_CHAIN = 'solana:mainnet';

export type OperatorWalletSupportTier = 'merge-gate' | 'best-effort';

export interface WalletStandardFeature {
  readonly [property: string]: unknown;
}

export interface WalletStandardConnectFeature extends WalletStandardFeature {
  connect(input?: {
    readonly silent?: boolean;
  }): Promise<{ readonly accounts?: readonly WalletStandardAccount[] }>;
}

/**
 * Wallet Standard `solana:signAndSendTransaction` feature — signs the
 * given serialized transaction with the account's keypair AND
 * broadcasts it, returning the resulting tx signature.
 */
export interface WalletStandardSignAndSendFeature extends WalletStandardFeature {
  signAndSendTransaction(
    ...inputs: ReadonlyArray<{
      readonly account: WalletStandardAccount;
      readonly transaction: Uint8Array;
      readonly chain: string;
    }>
  ): Promise<ReadonlyArray<{ readonly signature: Uint8Array }>>;
}

export interface WalletStandardAccount {
  readonly address?: string;
  readonly publicKey?: Uint8Array;
  readonly chains?: readonly string[];
}

export interface WalletStandardWallet {
  readonly name: string;
  readonly version?: string;
  readonly icon?: string;
  readonly accounts?: readonly WalletStandardAccount[];
  readonly chains?: readonly string[];
  readonly features: Readonly<Record<string, WalletStandardFeature>>;
}

export interface WalletStandardRegistry {
  get(): readonly WalletStandardWallet[];
}

export interface SupportedOperatorWallet {
  readonly wallet: WalletStandardWallet;
  readonly name: string;
  readonly normalizedName: string;
  readonly version: string | null;
  readonly supportTier: OperatorWalletSupportTier;
  readonly canSignAndSendTransaction: boolean;
  readonly canSignTransaction: boolean;
  readonly canConnect: boolean;
}

export interface OperatorWalletSelectOption {
  readonly id: string;
  readonly value: string;
  readonly label: string;
  readonly detail: string;
  readonly supportTier: OperatorWalletSupportTier;
  readonly wallet: SupportedOperatorWallet;
  readonly selected: boolean;
}

export interface OperatorWalletSelectionState {
  readonly options: readonly OperatorWalletSelectOption[];
  readonly selectedOption: OperatorWalletSelectOption | null;
  readonly selectedWallet: SupportedOperatorWallet | null;
}

export interface ConnectedOperatorWallet {
  readonly wallet: SupportedOperatorWallet;
  readonly account: WalletStandardAccount;
  readonly walletPubkey: string;
}

const MERGE_GATE_WALLETS = new Set(['phantom', 'backpack']);
const BEST_EFFORT_WALLETS = new Set(['solflare']);
const HARDWARE_BACKEND_HINTS = ['ledger'];

function normalizeWalletName(name: string): string {
  return name.trim().toLowerCase();
}

function hasFeature(wallet: WalletStandardWallet, feature: string): boolean {
  return Object.hasOwn(wallet.features, feature);
}

function isSolanaWallet(wallet: WalletStandardWallet): boolean {
  const walletChains = wallet.chains ?? [];
  const accountChains = wallet.accounts?.flatMap((account) => account.chains ?? []) ?? [];
  const chains = [...walletChains, ...accountChains];

  return chains.length === 0 || chains.some((chain) => chain === 'solana:mainnet');
}

function supportTierFor(normalizedName: string): OperatorWalletSupportTier | null {
  if (MERGE_GATE_WALLETS.has(normalizedName)) return 'merge-gate';
  if (BEST_EFFORT_WALLETS.has(normalizedName)) return 'best-effort';
  if (HARDWARE_BACKEND_HINTS.some((hint) => normalizedName.includes(hint))) return 'best-effort';

  return null;
}

export function detectSupportedOperatorWallets(
  wallets: readonly WalletStandardWallet[],
): SupportedOperatorWallet[] {
  return wallets.flatMap((wallet) => {
    const normalizedName = normalizeWalletName(wallet.name);
    const supportTier = supportTierFor(normalizedName);
    if (supportTier === null) return [];

    const canSignAndSendTransaction = hasFeature(wallet, OPERATOR_WALLET_SIGN_AND_SEND_FEATURE);
    const canSignTransaction = hasFeature(wallet, OPERATOR_WALLET_SIGN_TRANSACTION_FEATURE);
    const canConnect = hasFeature(wallet, OPERATOR_WALLET_CONNECT_FEATURE);
    const canSendMemoTransaction = canSignAndSendTransaction || canSignTransaction;

    if (!canConnect || !canSendMemoTransaction || !isSolanaWallet(wallet)) return [];

    return [
      {
        wallet,
        name: wallet.name,
        normalizedName,
        version: wallet.version ?? null,
        supportTier,
        canSignAndSendTransaction,
        canSignTransaction,
        canConnect,
      },
    ];
  });
}

export function discoverSupportedOperatorWallets(
  registry: WalletStandardRegistry,
): SupportedOperatorWallet[] {
  return detectSupportedOperatorWallets(registry.get());
}

export async function connectSelectedOperatorWallet(
  selectedWallet: SupportedOperatorWallet,
): Promise<ConnectedOperatorWallet> {
  const connectFeature = selectedWallet.wallet.features[OPERATOR_WALLET_CONNECT_FEATURE];
  if (!isConnectFeature(connectFeature)) {
    throw new Error(`${selectedWallet.name} does not expose Wallet Standard connect.`);
  }

  const result = await connectFeature.connect({ silent: false });
  const account = findSolanaAccount(result.accounts ?? selectedWallet.wallet.accounts ?? []);
  if (account === null) {
    throw new Error(`${selectedWallet.name} connected without a Solana account.`);
  }

  return {
    wallet: selectedWallet,
    account,
    walletPubkey: account.address ?? publicKeyToBase58(account.publicKey),
  };
}

/**
 * Sign AND send a serialized memo transaction with a connected
 * operator wallet, returning the broadcast transaction's base58
 * signature.
 *
 * Uses the `solana:signAndSendTransaction` Wallet Standard feature —
 * Phantom, Backpack, and Solflare all expose it. A wallet that only
 * exposes `solana:signTransaction` (sign-without-send) is rejected
 * with a clear message rather than silently mis-handled: v1's memo
 * flow needs a single sign-and-send call, and a separate broadcast
 * path is out of scope.
 */
export async function sendMemoTransaction(args: {
  connected: ConnectedOperatorWallet;
  transaction: Uint8Array;
  chain?: string;
}): Promise<string> {
  const feature = args.connected.wallet.wallet.features[OPERATOR_WALLET_SIGN_AND_SEND_FEATURE];
  if (!isSignAndSendFeature(feature)) {
    throw new Error(
      `${args.connected.wallet.name} does not expose Wallet Standard sign-and-send. Use Phantom, Backpack, or Solflare.`,
    );
  }
  const results = await feature.signAndSendTransaction({
    account: args.connected.account,
    transaction: args.transaction,
    chain: args.chain ?? OPERATOR_WALLET_SOLANA_CHAIN,
  });
  const signatureBytes = results[0]?.signature;
  if (signatureBytes === undefined || signatureBytes.length === 0) {
    throw new Error(`${args.connected.wallet.name} returned no transaction signature.`);
  }
  return encodeBase58(signatureBytes);
}

function isSignAndSendFeature(
  feature: WalletStandardFeature | undefined,
): feature is WalletStandardSignAndSendFeature {
  return (
    typeof (feature as WalletStandardSignAndSendFeature | undefined)?.signAndSendTransaction ===
    'function'
  );
}

export function createOperatorWalletSelectionState(
  discoveredWallets: readonly SupportedOperatorWallet[],
  selectedOptionId?: string | null,
): OperatorWalletSelectionState {
  const selectedId =
    selectedOptionId ??
    (discoveredWallets[0] === undefined ? null : operatorWalletOptionId(discoveredWallets[0], 0));

  const options = discoveredWallets.map((wallet, index): OperatorWalletSelectOption => {
    const id = operatorWalletOptionId(wallet, index);
    return {
      id,
      value: id,
      label: wallet.name,
      detail:
        wallet.version === null ? wallet.supportTier : `${wallet.version} · ${wallet.supportTier}`,
      supportTier: wallet.supportTier,
      wallet,
      selected: id === selectedId,
    };
  });

  const selectedOption = options.find((option) => option.selected) ?? null;

  return {
    options,
    selectedOption,
    selectedWallet: selectedOption?.wallet ?? null,
  };
}

function operatorWalletOptionId(wallet: SupportedOperatorWallet, index: number): string {
  const version = wallet.version ?? 'unknown';
  return `${wallet.normalizedName}:${version}:${index}`;
}

function isConnectFeature(
  feature: WalletStandardFeature | undefined,
): feature is WalletStandardConnectFeature {
  return typeof (feature as WalletStandardConnectFeature | undefined)?.connect === 'function';
}

function findSolanaAccount(
  accounts: readonly WalletStandardAccount[],
): WalletStandardAccount | null {
  return (
    accounts.find((account) => {
      const chains = account.chains ?? [];
      const hasSolanaChain = chains.length === 0 || chains.includes('solana:mainnet');
      return hasSolanaChain && (account.address !== undefined || account.publicKey !== undefined);
    }) ?? null
  );
}

function publicKeyToBase58(publicKey: Uint8Array | undefined): string {
  if (publicKey === undefined) {
    throw new Error('Connected wallet account is missing a public key.');
  }
  return encodeBase58(publicKey);
}
