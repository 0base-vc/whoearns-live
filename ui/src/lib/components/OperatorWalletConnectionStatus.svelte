<script lang="ts">
  interface Props {
    connecting?: boolean;
    walletName?: string | null;
    walletPubkey?: string | null;
  }

  let { connecting = false, walletName = null, walletPubkey = null }: Props = $props();

  const trimmedPubkey = $derived(walletPubkey?.trim() ?? '');
  const connected = $derived(trimmedPubkey.length > 0);
  const providerLabel = $derived(walletName ?? 'Browser wallet');

  function shorten(value: string): string {
    if (value.length <= 18) return value;
    return `${value.slice(0, 8)}...${value.slice(-8)}`;
  }
</script>

<div
  class="rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] px-3 py-2 text-xs"
  data-testid="operator-wallet-connection-status"
>
  {#if connecting}
    <p role="status" class="font-semibold text-[color:var(--color-text-default)]">
      Connecting {providerLabel}...
    </p>
    <p class="mt-1 text-[color:var(--color-text-subtle)]">
      Approve the Wallet Standard connection request in your wallet.
    </p>
  {:else if connected}
    <p role="status" class="font-semibold text-[color:var(--color-status-ok-fg)]">
      Connected: {providerLabel}
    </p>
    <p class="mt-1 font-mono text-[color:var(--color-text-subtle)]" title={trimmedPubkey}>
      {shorten(trimmedPubkey)}
    </p>
    <p class="sr-only">Connected operator wallet public key: {trimmedPubkey}</p>
  {:else}
    <p class="font-semibold text-[color:var(--color-text-default)]">Wallet not connected</p>
    <p class="mt-1 text-[color:var(--color-text-subtle)]">
      Connect a supported browser wallet to use its public key.
    </p>
  {/if}
</div>
