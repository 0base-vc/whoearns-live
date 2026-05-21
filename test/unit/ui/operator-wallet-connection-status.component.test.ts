import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

interface OperatorWalletConnectionStatusProps {
  connecting?: boolean;
  walletName?: string | null;
  walletPubkey?: string | null;
}

async function renderConnectionStatus(props: OperatorWalletConnectionStatusProps): Promise<string> {
  const require = createRequire(import.meta.url);
  const internalServerUrl = pathToFileURL(require.resolve('svelte/internal/server')).href;
  const source = await readFile(
    'ui/src/lib/components/OperatorWalletConnectionStatus.svelte',
    'utf8',
  );
  const compiled = compile(source, {
    filename: 'OperatorWalletConnectionStatus.svelte',
    generate: 'server',
  });
  const code = compiled.js.code.replace(
    "from 'svelte/internal/server'",
    `from '${internalServerUrl}'`,
  );
  // The component is compiled + loaded from a data: URL, so its prop
  // type is opaque here — type the dynamic import's `default` as a
  // `Component` over the known prop shape so `render` accepts it.
  const module = (await import(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`
  )) as {
    default: Component<OperatorWalletConnectionStatusProps>;
  };

  return render(module.default, { props }).body;
}

describe('OperatorWalletConnectionStatus', () => {
  it('renders the disconnected browser wallet state', async () => {
    const html = await renderConnectionStatus({ walletName: 'Phantom' });

    expect(html).toContain('Wallet not connected');
    expect(html).toContain('Connect a supported browser wallet to use its public key.');
  });

  it('renders the in-progress connection state for the selected wallet', async () => {
    const html = await renderConnectionStatus({ connecting: true, walletName: 'Backpack' });

    expect(html).toContain('role="status"');
    expect(html).toContain('Connecting Backpack...');
    expect(html).toContain('Approve the Wallet Standard connection request in your wallet.');
  });

  it('renders the connected operator wallet public key', async () => {
    const walletPubkey = '7Zb1w7QLhT1vJZcmtw7vQxCuAq2k5rUyqXMeZWG7SxYh';
    const html = await renderConnectionStatus({
      walletName: 'Phantom',
      walletPubkey,
    });

    expect(html).toContain('Connected: Phantom');
    expect(html).toContain('7Zb1w7QL...ZWG7SxYh');
    expect(html).toContain(`Connected operator wallet public key: ${walletPubkey}`);
  });
});
