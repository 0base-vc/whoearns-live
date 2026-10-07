import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';

type StatusProps = { status: 'loading' | 'error' | 'unavailable'; onRetry: () => void };

async function renderStatus(status: StatusProps['status']): Promise<string> {
  const require = createRequire(import.meta.url);
  const internalServerUrl = pathToFileURL(require.resolve('svelte/internal/server')).href;
  const source = await readFile('ui/src/lib/components/IncomeScoringStatus.svelte', 'utf8');
  const compiled = compile(source, { filename: 'IncomeScoringStatus.svelte', generate: 'server' });
  const code = compiled.js.code.replace(
    "from 'svelte/internal/server'",
    `from '${internalServerUrl}'`,
  );
  const module = (await import(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`
  )) as {
    default: Component<StatusProps>;
  };
  return render(module.default, { props: { status, onRetry: () => undefined } }).body;
}

describe('income scoring status', () => {
  it('announces that optional tier and commission details are still loading', async () => {
    const html = await renderStatus('loading');
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading tier and commission details');
    expect(html).not.toContain('<button');
  });

  it('shows the failure and offers retry while keeping history available', async () => {
    const html = await renderStatus('error');
    expect(html).toContain("couldn't be loaded");
    expect(html).toContain('Income history is still available');
    expect(html).toContain('Retry details');
    expect(html).toContain('type="button"');
  });

  it('describes missing scoring separately from failure', async () => {
    const html = await renderStatus('unavailable');
    expect(html).toContain("aren't available for this validator yet");
    expect(html).not.toContain('couldn');
    expect(html).not.toContain('<button');
  });
});
