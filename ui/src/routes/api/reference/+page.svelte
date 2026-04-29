<script lang="ts">
  import { onMount } from 'svelte';
  import { SITE_NAME, SITE_URL } from '$lib/site';

  type ScalarApiReference = {
    createApiReference: (selector: string, config: Record<string, unknown>) => void;
  };

  const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';
  const SCRIPT_SELECTOR = 'script[data-scalar-api-reference]';
  const SCRIPT_LOAD_TIMEOUT_MS = 15_000;

  let isReady = $state(false);
  let loadError = $state<string | null>(null);

  function scalarGlobal(): ScalarApiReference | undefined {
    return (window as Window & { Scalar?: ScalarApiReference }).Scalar;
  }

  function loadScalarScript(): Promise<void> {
    if (scalarGlobal()?.createApiReference) return Promise.resolve();

    // A stale script tag can survive SPA navigation without replaying
    // load/error events, which would leave the page in permanent
    // "Loading" state. Reinsert it unless the Scalar global is ready.
    for (const existing of document.querySelectorAll<HTMLScriptElement>(SCRIPT_SELECTOR)) {
      existing.remove();
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCALAR_CDN;
      script.async = true;
      script.dataset.scalarApiReference = 'true';
      script.crossOrigin = 'anonymous';

      let settled = false;
      const timer = window.setTimeout(() => {
        script.dataset.failed = 'true';
        script.remove();
        finish(new Error('Scalar script timed out'));
      }, SCRIPT_LOAD_TIMEOUT_MS);

      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }

      script.addEventListener(
        'load',
        () => {
          script.dataset.loaded = 'true';
          finish();
        },
        { once: true },
      );
      script.addEventListener(
        'error',
        () => {
          script.dataset.failed = 'true';
          finish(new Error('Scalar script failed to load'));
        },
        { once: true },
      );
      document.head.appendChild(script);
    });
  }

  onMount(() => {
    let cancelled = false;

    async function mountScalar(): Promise<void> {
      try {
        await loadScalarScript();
        const scalar = scalarGlobal();
        if (!scalar?.createApiReference) {
          throw new Error('Scalar runtime did not initialize');
        }
        if (cancelled) return;

        scalar.createApiReference('#scalar-api-reference', {
          url: '/openapi.yaml',
          proxyUrl: 'https://proxy.scalar.com',
          hideClientButton: true,
          layout: 'modern',
          theme: 'purple',
          pageTitle: `${SITE_NAME} API Reference`,
          metaData: {
            title: `${SITE_NAME} API Reference`,
            description: `${SITE_NAME} public OpenAPI reference`,
          },
        });
        isReady = true;
      } catch (error) {
        if (!cancelled) {
          loadError = error instanceof Error ? error.message : 'Scalar failed to load';
        }
      }
    }

    void mountScalar();

    return () => {
      cancelled = true;
    };
  });
</script>

<svelte:head>
  <title>{`Interactive API reference — ${SITE_NAME}`}</title>
  <meta
    name="description"
    content={`Interactive Scalar API reference for ${SITE_NAME}. Loads the canonical OpenAPI document from /openapi.yaml.`}
  />
  <link rel="canonical" href={`${SITE_URL}/api/reference`} />
</svelte:head>

<section class="min-h-[calc(100vh-12rem)]">
  <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
        Public API
      </p>
      <h1 class="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
        Interactive <span class="text-[color:var(--color-brand-500)]">reference</span>
      </h1>
      <p class="mt-2 max-w-2xl text-sm text-[color:var(--color-text-muted)]">
        Scalar renders the canonical OpenAPI document served by this deployment.
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <a
        href="/api/docs"
        class="inline-flex items-center rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 text-sm font-semibold hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
      >
        API docs
      </a>
      <a
        href="/openapi.yaml"
        rel="external"
        class="inline-flex items-center rounded-lg bg-[color:var(--color-brand-500)] px-3 py-2 text-sm font-semibold text-white hover:bg-[color:var(--color-brand-600)]"
      >
        Download openapi.yaml
      </a>
    </div>
  </div>

  {#if loadError}
    <div
      class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      Scalar could not load from the CDN. The OpenAPI document is still available at
      <a href="/openapi.yaml" rel="external" class="font-semibold underline">/openapi.yaml</a>.
    </div>
  {/if}

  <div
    class="relative min-h-[75vh] overflow-hidden rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)]"
    aria-busy={!isReady && !loadError}
  >
    {#if !isReady && !loadError}
      <div
        class="absolute inset-0 z-10 flex items-center justify-center bg-[color:var(--color-surface)] text-sm text-[color:var(--color-text-muted)]"
      >
        Loading Scalar reference...
      </div>
    {/if}
    <div id="scalar-api-reference" class="min-h-[75vh]"></div>
  </div>
</section>
