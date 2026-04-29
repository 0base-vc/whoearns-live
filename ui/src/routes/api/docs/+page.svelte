<!--
  /api/docs — hand-rolled API reference.

  Deliberately thin: lists every endpoint with its query params, a
  click-to-copy example URL, and a pointer to the canonical spec at
  `/openapi.yaml`. Rich interactivity lives on `/api/reference`, a
  separate Scalar route loaded only when someone asks for it, so this
  endpoint catalog stays fast and crawler-friendly.
-->
<script lang="ts">
  import { SITE_NAME, SITE_URL } from '$lib/site';

  interface Endpoint {
    method: 'GET';
    path: string;
    summary: string;
    description: string;
    params?: { name: string; type: string; required?: boolean; description: string }[];
    example: string;
  }

  const endpoints: Endpoint[] = [
    {
      method: 'GET',
      path: '/healthz',
      summary: 'Liveness + readiness probe',
      description:
        'Reports DB connectivity + RPC heartbeat freshness. Returns 200 with body `{status: "ok" | "degraded"}`. Used by k8s probes.',
      example: `${SITE_URL}/healthz`,
    },
    {
      method: 'GET',
      path: '/v1/epoch/current',
      summary: 'Current Solana epoch snapshot',
      description:
        'First/last/current slot, `slotsElapsed`, and `isClosed` for the running epoch. Updated every `EPOCH_WATCH_INTERVAL_MS` tick.',
      example: `${SITE_URL}/v1/epoch/current`,
    },
    {
      method: 'GET',
      path: '/v1/leaderboard',
      summary: 'Top-N validators by a chosen ranking metric',
      description:
        'Ranked list for the most recent closed epoch. Five sort modes: `performance` (DEFAULT — `(block_fees + block_tips) / slots_assigned` DESC, stake-neutral + commission-neutral skill), `total_income` (block_fees + block_tips DESC, stake-biased), `income_per_stake` (operator revenue per stake, DESC), `skip_rate` (ASC, reliability), `median_fee` (DESC, per-block packing). Rows without ingested fee data are filtered out; rows without a stake snapshot fall out of `income_per_stake` only. Rows with `slots_assigned < 30` are included but flagged as low-sample.',
      params: [
        {
          name: 'limit',
          type: 'integer',
          description: 'How many rows to return. Clamped server-side to 500. Default 100.',
        },
        {
          name: 'epoch',
          type: 'integer',
          description:
            'Override target epoch. Defaults to the most recent closed epoch. 404 if the epoch is unknown.',
        },
        {
          name: 'sort',
          type: 'enum',
          description:
            '`performance` | `total_income` | `income_per_stake` | `skip_rate` | `median_fee`. Default `performance`. 400 on unknown values.',
        },
      ],
      example: `${SITE_URL}/v1/leaderboard?limit=25&sort=performance`,
    },
    {
      method: 'GET',
      path: '/v1/validators/{idOrVote}/current-epoch',
      summary: "A validator's running-epoch stats",
      description:
        'Same row as the history endpoint filtered to the current epoch. `idOrVote` accepts either a vote pubkey or an identity pubkey; the resolver picks whichever matches our `validators` table.',
      example: `${SITE_URL}/v1/validators/5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ/current-epoch`,
    },
    {
      method: 'GET',
      path: '/v1/validators/{idOrVote}/epochs/{epoch}',
      summary: "A validator's stats for one epoch",
      description:
        'Same record shape as `current-epoch`, but pinned to the requested epoch. `idOrVote` accepts either a vote pubkey or an identity pubkey.',
      example: `${SITE_URL}/v1/validators/5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ/epochs/963`,
    },
    {
      method: 'GET',
      path: '/v1/validators/{idOrVote}/history',
      summary: 'Per-epoch history for a validator',
      description:
        'Rows returned newest-first. Each row carries `isFinal`, `hasSlots`, `hasIncome`, and an optional `cluster` block for median comparison context.',
      params: [
        {
          name: 'limit',
          type: 'integer',
          description: 'Row count. Clamped server-side to 200. Default 50.',
        },
      ],
      example: `${SITE_URL}/v1/validators/5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ/history?limit=20`,
    },
  ];

  let copied = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      copied = url;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied = null;
      }, 1400);
    } catch {
      /* clipboard blocked — silent */
    }
  }
</script>

<svelte:head>
  <title>{`API reference — ${SITE_NAME}`}</title>
  <meta
    name="description"
    content={`Public HTTP API for ${SITE_NAME} — per-epoch Solana validator stats, cluster medians, and the homepage leaderboard. Free, versioned, data licensed CC0.`}
  />
  <link rel="canonical" href={`${SITE_URL}/api/docs`} />
</svelte:head>

<section class="mb-8">
  <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
    Public API
  </p>
  <h1 class="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
    API <span class="text-[color:var(--color-brand-500)]">reference</span>
  </h1>
  <p class="mt-3 max-w-2xl text-sm text-[color:var(--color-text-muted)]">
    Every number on this site comes from this API. Versioned, rate-limited (60 req/min/IP), and
    shipped under
    <a
      href="https://creativecommons.org/publicdomain/zero/1.0/"
      target="_blank"
      rel="noopener noreferrer"
      class="font-medium text-[color:var(--color-brand-500)] hover:underline">CC0</a
    > for the data.
  </p>

  <div class="mt-5 flex flex-wrap gap-2">
    <a
      href="/openapi.yaml"
      rel="external"
      class="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-brand-500)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[color:var(--color-brand-600)]"
    >
      Download openapi.yaml
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14" />
      </svg>
    </a>
    <a
      href="/api/reference"
      class="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-4 py-2 text-sm font-semibold hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
    >
      Open in Scalar
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M7 17L17 7M17 7H8M17 7V16" />
      </svg>
    </a>
    <a
      href="https://github.com/0base-vc/whoearns-live"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-4 py-2 text-sm font-semibold hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
    >
      Source on GitHub
    </a>
  </div>
</section>

<!-- Auth + base URL note -->
<section
  class="mb-10 rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-5 text-sm"
>
  <h2 class="text-base font-semibold">Conventions</h2>
  <dl class="mt-3 grid gap-3 sm:grid-cols-2">
    <div>
      <dt
        class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
      >
        Base URL
      </dt>
      <dd class="mt-1 font-mono text-[13px]">{SITE_URL}</dd>
    </div>
    <div>
      <dt
        class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
      >
        Auth
      </dt>
      <dd class="mt-1 text-[color:var(--color-text-muted)]">None — public, read-only.</dd>
    </div>
    <div>
      <dt
        class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
      >
        Rate limit
      </dt>
      <dd class="mt-1 text-[color:var(--color-text-muted)]">
        60 requests / min / IP. Exceeding returns <code>429 Too Many Requests</code>.
      </dd>
    </div>
    <div>
      <dt
        class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
      >
        Errors
      </dt>
      <dd class="mt-1 text-[color:var(--color-text-muted)]">
        JSON: <code>{`{ error: { code, message, requestId, details? } }`}</code>.
      </dd>
    </div>
  </dl>
</section>

<!-- Endpoints -->
<section aria-labelledby="endpoints-title">
  <h2 id="endpoints-title" class="text-lg font-semibold">Endpoints</h2>
  <ul class="mt-4 space-y-4">
    {#each endpoints as ep (ep.path)}
      <li
        class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
      >
        <div class="flex flex-wrap items-baseline gap-2">
          <span
            class="rounded bg-[color:var(--color-brand-50)] px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-brand-600)] dark:bg-[color:var(--color-brand-950)] dark:text-[color:var(--color-brand-300)]"
            >{ep.method}</span
          >
          <code class="font-mono text-sm font-medium">{ep.path}</code>
          <span class="ml-auto text-xs text-[color:var(--color-text-subtle)]">{ep.summary}</span>
        </div>
        <p class="mt-3 text-sm leading-relaxed text-[color:var(--color-text-muted)]">
          {ep.description}
        </p>

        {#if ep.params}
          <details class="mt-3 text-sm">
            <summary class="cursor-pointer font-medium text-[color:var(--color-text-muted)]">
              Query parameters ({ep.params.length})
            </summary>
            <dl class="mt-2 space-y-1.5 pl-4 text-xs">
              {#each ep.params as p (p.name)}
                <div>
                  <dt class="inline font-mono font-semibold">{p.name}</dt>
                  <span class="text-[color:var(--color-text-subtle)]"
                    >({p.type}{p.required ? ', required' : ''})</span
                  >
                  <dd class="mt-0.5 pl-4 text-[color:var(--color-text-muted)]">
                    {p.description}
                  </dd>
                </div>
              {/each}
            </dl>
          </details>
        {/if}

        <!--
          Example URL row: `break-all` on mobile so a long path like
          `/v1/validators/<pubkey>/history` wraps to 2-3 lines instead
          of getting silently clipped (the trailing path segments are
          the meaningful part). On `sm:` and up the row is wide
          enough to keep `truncate` semantics if a URL ever exceeds
          the slot — it almost never does at desktop, so `truncate`
          there is defensive only.
        -->
        <div
          class="mt-4 flex items-start gap-2 rounded-lg border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] px-3 py-2 sm:items-center"
        >
          <code class="flex-1 break-all font-mono text-[11px] sm:truncate">{ep.example}</code>
          <button
            type="button"
            class="shrink-0 rounded-md border border-[color:var(--color-border-default)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-text-muted)] hover:border-[color:var(--color-brand-500)] hover:text-[color:var(--color-brand-500)]"
            onclick={() => copy(ep.example)}
            aria-label={`Copy ${ep.path} example URL`}
          >
            {copied === ep.example ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </li>
    {/each}
  </ul>
</section>

<section
  class="mt-10 rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-5"
>
  <h2 class="text-base font-semibold">Need more detail?</h2>
  <p class="mt-2 text-sm text-[color:var(--color-text-muted)]">
    Full response shapes, field-level docs, and enum values live in the OpenAPI 3.1 spec at
    <a
      href="/openapi.yaml"
      rel="external"
      class="font-medium text-[color:var(--color-brand-500)] hover:underline">/openapi.yaml</a
    >. Paste that URL into
    <a
      href="https://hoppscotch.io/"
      target="_blank"
      rel="noopener noreferrer"
      class="font-medium text-[color:var(--color-brand-500)] hover:underline">Hoppscotch</a
    >,
    <a
      href="https://scalar.com/"
      target="_blank"
      rel="noopener noreferrer"
      class="font-medium text-[color:var(--color-brand-500)] hover:underline">Scalar</a
    >, or your own OpenAPI viewer for a full interactive reference.
  </p>
</section>
