<!--
  /about — public-goods positioning.

  Written for three audiences at once:
    1. A first-time visitor asking "what is this?" — answered in the hero.
    2. Solana Foundation / stake-pool operators doing ecosystem-contribution
       due diligence — answered via mission, license, open-data promise, and
       the self-hosting instructions.
    3. Would-be integrators — pointed at the public API docs.

  Bilingual (EN / KO) so a Korean visitor doing operator due diligence
  doesn't bounce on a wall of English. Pattern matches /glossary, /faq,
  /compare — `t(en, ko)` per string, `inLanguage` JSON-LD, and full
  hreflang `en` / `ko` / `x-default` alternates so search engines can
  surface the right SERP for each audience.
-->
<script lang="ts">
  // The maintainer-card glyph is the 0base.vc operator symbol —
  // distinct from the WhoEarns product BrandMark. Two glyphs, two
  // concerns: product brand vs maintainer attribution.
  import MaintainerMark from '$lib/components/MaintainerMark.svelte';
  import { SITE_NAME, SITE_URL } from '$lib/site';
  import { currentLocale, t } from '$lib/stores/locale.svelte';

  const GITHUB_URL = 'https://github.com/0base-vc/whoearns-live';

  const locale = $derived(currentLocale());

  // Principle cards: each has bilingual title + body + a brand-violet
  // pill badge that stays as an English short-form (MIT / CC0 / Helm)
  // because those are proper nouns / standardised acronyms — translating
  // them would obscure the badge's recognisability rather than aid it.
  const principles = $derived([
    {
      title: t('Open code', '오픈 코드'),
      badge: 'MIT',
      body: t(
        'The indexer, API, and UI are open-source under the MIT license. Fork the project, self-host it, read the SQL.',
        '인덱서, API, UI — 화면에 보이는 모든 수치를 만들어내는 코드 전체가 MIT 라이선스로 공개돼 있습니다. 포크해도 되고, 직접 호스팅해도 되고, SQL을 직접 읽어봐도 됩니다.',
      ),
    },
    {
      title: t('Open data', '오픈 데이터'),
      badge: 'CC0',
      body: t(
        'All derived validator statistics served by the API are released into the public domain. Embed them, republish them, build your own dashboards.',
        'API가 제공하는 밸리데이터 통계는 모두 퍼블릭 도메인(CC0)으로 공개됩니다. 내장하셔도 되고, 재배포하셔도 되고, 직접 대시보드를 만드셔도 됩니다.',
      ),
    },
    {
      title: t('Self-hostable', '직접 호스팅'),
      badge: 'Helm',
      body: t(
        'One Helm chart, one StatefulSet, embedded Postgres. If the hosted site ever goes down, the chart + the public RPC are enough to rebuild it anywhere.',
        'Helm 차트 하나, StatefulSet 하나, 임베디드 Postgres. 운영 사이트가 멈춰도 차트와 퍼블릭 RPC만 있으면 어디서든 재구축할 수 있습니다.',
      ),
    },
  ]);

  const pageTitle = $derived(t(`About — ${SITE_NAME}`, `소개 — ${SITE_NAME}`));
  const pageDescription = $derived(
    t(
      `${SITE_NAME} — a public good for the Solana validator ecosystem. Open-source, open-data, self-hostable. Maintained by 0base.vc.`,
      `${SITE_NAME} — Solana 밸리데이터 생태계를 위한 공공재. 오픈소스, 오픈 데이터, 직접 호스팅 가능. 0base.vc가 운영합니다.`,
    ),
  );
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={pageDescription} />
  <link rel="canonical" href={`${SITE_URL}/about`} />
  <!--
    hreflang alternates so a Korean searcher's SERP surfaces the KO
    URL and an English searcher's surfaces the EN URL. `x-default`
    points at the unparameterised URL which respects the visitor's
    localStorage / `navigator.language` preference. Same pattern as
    /glossary, /faq, /compare.
  -->
  <link rel="alternate" hreflang="en" href={`${SITE_URL}/about?lang=en`} />
  <link rel="alternate" hreflang="ko" href={`${SITE_URL}/about?lang=ko`} />
  <link rel="alternate" hreflang="x-default" href={`${SITE_URL}/about`} />
  <meta property="og:title" content={pageTitle} />
  <meta property="og:description" content={pageDescription} />
  <meta property="og:locale" content={locale === 'ko' ? 'ko_KR' : 'en_US'} />
</svelte:head>

<section aria-labelledby="about-title" class="relative">
  <div
    aria-hidden="true"
    class="pointer-events-none absolute inset-x-0 -top-10 -z-10 h-64 bg-gradient-to-b from-[color:var(--color-brand-100)]/60 via-transparent to-transparent dark:from-[color:var(--color-brand-900)]/25"
  ></div>

  <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
    {t('Public good', '공공재')}
  </p>
  <h1 id="about-title" class="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
    {#if locale === 'ko'}
      <span class="text-[color:var(--color-brand-500)]">Solana 커뮤니티</span>를 위해 만들었습니다.
    {:else}
      Built for the
      <span class="text-[color:var(--color-brand-500)]">Solana community.</span>
    {/if}
  </h1>
  <p class="mt-4 max-w-2xl text-base text-[color:var(--color-text-muted)]">
    {#if locale === 'ko'}
      <span lang="en">{SITE_NAME}</span>은 Solana 밸리데이터의 epoch별 경제 활동 — 블록 수수료, MEV
      보상, 슬롯 생산량, 클러스터 벤치마크 — 를 들여다보는 오픈 대시보드입니다. Solana 메인넷
      밸리데이터 운영자인 0base.vc가 운영하며, 생태계에 대한 OSS 기여로 공개합니다.
    {:else}
      {SITE_NAME} is an open dashboard for inspecting per-epoch Solana validator economics — block fees,
      on-chain Jito tips, slot production, and cluster benchmarks. It's maintained by 0base.vc, operator
      of a Solana mainnet validator, and shipped as an OSS contribution to the ecosystem.
    {/if}
  </p>
</section>

<!-- Mission / principles -->
<section aria-labelledby="principles-title" class="mt-14">
  <h2
    id="principles-title"
    class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-text-subtle)]"
  >
    {t('Principles', '원칙')}
  </h2>
  <div class="mt-4 grid gap-4 sm:grid-cols-3">
    {#each principles as p (p.badge)}
      <div
        class="rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
      >
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold">{p.title}</h3>
          <span
            class="rounded-md bg-[color:var(--color-brand-50)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-brand-600)] dark:bg-[color:var(--color-brand-950)] dark:text-[color:var(--color-brand-300)]"
            >{p.badge}</span
          >
        </div>
        <p class="mt-2 text-sm leading-relaxed text-[color:var(--color-text-muted)]">{p.body}</p>
      </div>
    {/each}
  </div>
</section>

<!-- What it's for -->
<section aria-labelledby="what-title" class="mt-14">
  <h2 id="what-title" class="text-lg font-semibold">{t("What it's for", '용도')}</h2>
  <div class="mt-4 grid gap-6 text-sm text-[color:var(--color-text-muted)] sm:grid-cols-2">
    <div>
      <h3 class="text-base font-semibold text-[color:var(--color-text-default)]">
        {t('For delegators', '위임자에게')}
      </h3>
      <p class="mt-2">
        {#if locale === 'ko'}
          밸리데이터 수익을 한눈에 비교하세요. 블록 수수료 확보나 MEV 참여에서 클러스터 중앙값을
          꾸준히 앞서는 운영자를 식별할 수 있습니다. 홈페이지의 <a
            href="/"
            class="font-medium text-[color:var(--color-brand-500)] hover:underline">리더보드</a
          >를 확인하세요.
        {:else}
          Compare validator earnings side by side. Identify operators who consistently beat the
          cluster median on block-fee capture or MEV participation. Open the
          <a href="/" class="font-medium text-[color:var(--color-brand-500)] hover:underline"
            >leaderboard</a
          > on the homepage.
        {/if}
      </p>
    </div>
    <div>
      <h3 class="text-base font-semibold text-[color:var(--color-text-default)]">
        {t('For operators', '운영자에게')}
      </h3>
      <p class="mt-2">
        {t(
          'Benchmark your validator against the top-100 cluster sample for every closed epoch. Identify when a configuration change actually lifted your median block fee vs. when you were riding a cluster-wide uplift.',
          '닫힌 epoch마다 본인의 밸리데이터를 top-100 클러스터 샘플과 벤치마크하세요. 설정 변경이 실제로 중앙 블록 수수료를 끌어올렸는지, 아니면 클러스터 전체의 상승세에 편승한 것인지 구분할 수 있습니다.',
        )}
      </p>
    </div>
    <div>
      <h3 class="text-base font-semibold text-[color:var(--color-text-default)]">
        {t('For integrators', '통합 개발자에게')}
      </h3>
      <p class="mt-2">
        {#if locale === 'ko'}
          이 사이트의 모든 데이터는 퍼블릭 JSON API에서 옵니다. 자체 대시보드에 임베드하거나,
          Prometheus exporter에 연결하거나, 웹훅 트리거로 사용할 수 있습니다. <a
            href="/api/docs"
            class="font-medium text-[color:var(--color-brand-500)] hover:underline">API 문서</a
          >를 참고하세요.
        {:else}
          Everything on this site comes from a public JSON API. Embed it in your own dashboard, feed
          it to a Prometheus exporter, or use it to drive a webhook. See
          <a
            href="/api/docs"
            class="font-medium text-[color:var(--color-brand-500)] hover:underline">API docs</a
          >.
        {/if}
      </p>
    </div>
    <div>
      <h3 class="text-base font-semibold text-[color:var(--color-text-default)]">
        {t('For the ecosystem', '생태계에')}
      </h3>
      <p class="mt-2">
        {t(
          "Solana's validator economics are public data that has historically lived behind gated APIs or vendor-specific dashboards. This project's job is to make them plainly visible, freely queryable, and trivially forkable.",
          'Solana 밸리데이터 경제 데이터는 본래 공개 데이터지만, 그동안 게이팅된 API나 벤더 종속 대시보드 뒤에 숨어 있었습니다. 이 프로젝트의 목적은 그 데이터를 누구나 명확하게 보고, 자유롭게 쿼리하고, 손쉽게 포크할 수 있게 만드는 것입니다.',
        )}
      </p>
    </div>
  </div>
</section>

<!-- Run your own -->
<section aria-labelledby="run-title" class="mt-14">
  <h2 id="run-title" class="text-lg font-semibold">
    {t('Run your own instance', '직접 호스팅하기')}
  </h2>
  <p class="mt-2 text-sm text-[color:var(--color-text-muted)]">
    {#if locale === 'ko'}
      운영 환경에서 실제로 돌리는 스택을 그대로 한 번의 <code class="font-mono">helm install</code
      >로 띄울 수 있습니다. Kubernetes 클러스터와 Solana RPC 엔드포인트만 있으면 차트가 Postgres,
      마이그레이션, API, 워커, 정적 UI 번들까지 알아서 처리합니다.
    {:else}
      The same stack we run in production is one <code class="font-mono">helm install</code> away. Bring
      a Kubernetes cluster and a Solana RPC endpoint; the chart handles Postgres, migrations, the API,
      the worker, and the static UI bundle.
    {/if}
  </p>
  <pre
    class="mt-4 overflow-x-auto rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface-muted)] p-4 font-mono text-xs leading-relaxed"
    lang="en"><code
      >git clone {GITHUB_URL}.git
cd whoearns-live
helm upgrade --install whoearns-live deploy/helm/whoearns-live \
  --set config.solanaRpcUrl='https://your-rpc-endpoint/' \
  --set config.validatorsWatchList='Vote111...,Vote222...'</code
    ></pre>
  <p class="mt-3 text-xs text-[color:var(--color-text-subtle)]">
    {#if locale === 'ko'}
      Ingress, external-dns, persistence 옵션은 차트의
      <a
        href={`${GITHUB_URL}/tree/main/deploy/helm/whoearns-live`}
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-[color:var(--color-brand-500)] hover:underline">README</a
      >를 확인하세요.
    {:else}
      See the chart
      <a
        href={`${GITHUB_URL}/tree/main/deploy/helm/whoearns-live`}
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-[color:var(--color-brand-500)] hover:underline">README</a
      > for ingress, external-dns, and persistence options.
    {/if}
  </p>
</section>

<!-- Maintainer -->
<section aria-labelledby="maintainer-title" class="mt-14">
  <h2 id="maintainer-title" class="text-lg font-semibold">{t('Maintainer', '운영자')}</h2>
  <div
    class="mt-4 flex items-center gap-4 rounded-xl border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-5"
  >
    <span
      class="flex size-14 shrink-0 items-center justify-center rounded-xl bg-[color:var(--color-brand-500)] text-white"
    >
      <MaintainerMark size={36} />
    </span>
    <div class="flex-1">
      <p class="text-sm text-[color:var(--color-text-muted)]">
        {#if locale === 'ko'}
          <a
            href="https://0base.vc"
            target="_blank"
            rel="noopener noreferrer"
            class="font-semibold text-[color:var(--color-brand-500)] hover:underline">0base.vc</a
          > — Solana 밸리데이터 운영자가 운영합니다. 이 도구가 도움이 되셨다면, 위임 풀 배분이나 신규
          위임 시 저희를 고려해주세요.
        {:else}
          Maintained by <a
            href="https://0base.vc"
            target="_blank"
            rel="noopener noreferrer"
            class="font-semibold text-[color:var(--color-brand-500)] hover:underline">0base.vc</a
          >, a Solana validator operator. If this tool helps you, consider us for your stake pool
          allocation or new delegation.
        {/if}
      </p>
    </div>
  </div>
</section>
