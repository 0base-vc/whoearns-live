<!--
  /faq — bilingual frequently-asked questions about Solana validator
  income, this site's data, and how to act on it.

  This is the highest-leverage GEO surface on the site: GenAI engines
  (Perplexity, ChatGPT browse, Claude search) preferentially excerpt
  FAQPage-marked content when answering open-ended questions like
  "how do Solana validators earn money". A well-structured FAQ page
  is what gets cited.
-->
<script lang="ts">
  import { currentLocale } from '$lib/stores/locale.svelte';
  import { SITE_NAME, SITE_URL } from '$lib/site';

  /**
   * Each Q&A is bilingual. Editing tips:
   *   - Each answer should stand alone — GenAI engines extract them
   *     in isolation, so internal references like "as mentioned above"
   *     break.
   *   - Lead with the answer, then the reasoning. Don't bury the lede.
   *   - Concrete numbers (5,000 lamports, 3% TipRouter, ~2-day epoch)
   *     are quotable and citation-friendly.
   */
  const QA = [
    {
      q_en: 'How do Solana validators earn income?',
      q_ko: 'Solana validator는 어떻게 수입을 얻나요?',
      a_en: "Three streams: (1) base fees — a fixed 5,000 lamports per transaction signature, paid by every transaction; (2) priority fees — optional extra users pay to outbid others for inclusion (100% to the leader since SIMD-96, no burn); (3) Jito MEV tips — on-chain SOL transfers from traders bidding to land bundles in the validator's blocks. Inflation/staking rewards exist on top but aren't covered by this site.",
      a_ko: '세 가지 수입 흐름이 있습니다. (1) 기본 수수료(base fee) — 트랜잭션 서명당 고정 5,000 lamports로 모든 트랜잭션이 지불; (2) 우선순위 수수료(priority fee) — 빠른 포함을 위한 선택적 추가 수수료(SIMD-96 이후 100% 리더에게, 소각 없음); (3) Jito MEV 팁 — 트레이더가 validator 블록에 번들을 넣기 위해 보내는 온체인 SOL. 인플레이션/스테이킹 보상은 별도이며 이 사이트는 다루지 않습니다.',
    },
    {
      q_en: 'What is "skip rate" and what\'s a good number?',
      q_ko: '"Skip rate"는 무엇이고 얼마면 좋은가요?',
      a_en: "Skip rate is the percentage of leader slots a validator was scheduled to produce but failed to. 0% is perfect; under 2% is excellent; consistently above 5% suggests an unhealthy node, misconfigured peering, or undersized hardware. Skip rate is one of the cleanest validator-quality signals because it's stake-neutral — small and large validators are graded on the same scale.",
      a_ko: 'Skip rate는 validator에게 할당된 리더 슬롯 중 블록을 만들지 못한 비율입니다. 0%가 완벽, 2% 이하는 우수, 지속적으로 5% 이상이면 노드 불안정, 피어링 설정 오류, 하드웨어 부족을 의심해야 합니다. Skip rate는 스테이크와 무관해서 작은 validator와 큰 validator를 같은 잣대로 평가할 수 있는 깨끗한 지표입니다.',
    },
    {
      q_en: 'What is MEV and how does Jito pay validators?',
      q_ko: 'MEV가 무엇이고 Jito는 어떻게 validator에게 지급하나요?',
      a_en: "MEV (Maximal Extractable Value) is profit traders extract by reordering, inserting, or front-running transactions. On Solana, most MEV flows through Jito's block engine: searchers send bundles with on-chain SOL tips deposited to one of 8 tip accounts. This site reports those raw on-chain tips from each produced block, so the running epoch can update before any post-epoch payout publication.",
      a_ko: 'MEV(Maximal Extractable Value)는 트레이더가 트랜잭션 재정렬, 삽입, 앞지르기로 뽑아내는 수익입니다. Solana에서는 대부분 MEV가 Jito 블록 엔진을 거칩니다: 서처(searcher)가 8개 팁 계정 중 하나에 온체인 SOL 팁을 입금하면서 번들을 보냅니다. 이 사이트는 각 생산 블록에서 관측한 원시 온체인 팁을 집계하므로, 에폭 종료 후 페이아웃 공개를 기다리지 않고 진행 중 에폭도 갱신할 수 있습니다.',
    },
    {
      q_en: 'How fresh is the data on this site?',
      q_ko: '이 사이트의 데이터는 얼마나 최신인가요?',
      a_en: 'Slot production updates every ~60 seconds during the running epoch. Block fees and on-chain Jito tips update every ~30 seconds as produced blocks are ingested. Closed-epoch rows have isFinal=true; running-epoch rows are lower bounds that grow until the epoch closes (every ~2 days). hasSlots and hasIncome tell callers whether each family has been ingested.',
      a_ko: '슬롯 생산 데이터는 진행 중 에폭에서 ~60초마다 갱신됩니다. 블록 수수료와 온체인 Jito tips는 생산 블록 ingest에 맞춰 ~30초마다 갱신됩니다. 종료된 에폭 행은 isFinal=true이고, 진행 중 에폭 숫자는 에폭이 닫힐 때까지(~2일) 계속 증가하는 하한값입니다. hasSlots와 hasIncome으로 각 데이터가 수집됐는지 판단할 수 있습니다.',
    },
    {
      q_en: 'Are these income numbers before or after commission?',
      q_ko: '이 수입 숫자는 commission 차감 전인가요, 후인가요?',
      a_en: 'BEFORE commission. This site reports the OPERATOR side — the raw income the validator collects from block production and on-chain Jito tips. Delegator-facing yield is roughly (1 - commission) × the numbers shown here, modulo whatever fee structure the specific validator uses. Use this site to evaluate operator skill; use a delegator-staking dashboard for your own expected yield.',
      a_ko: 'Commission 차감 전입니다. 이 사이트는 운영자(OPERATOR) 측 — validator가 블록 생산과 온체인 Jito tips에서 받는 원시 수입을 보여줍니다. Delegator 입장의 수익률은 대략 (1 - commission) × 여기 숫자입니다 (validator 별 수수료 구조에 따라 다를 수 있음). 이 사이트는 운영자 능력 평가용이고, 본인 예상 수익률은 delegator-staking 대시보드를 사용하세요.',
    },
    {
      q_en: "What's the difference between a vote account and an identity pubkey?",
      q_ko: 'Vote account와 identity pubkey의 차이가 무엇인가요?',
      a_en: "The vote account is the on-chain account stakers delegate to — it lives across the validator's lifetime as the canonical identifier. The identity pubkey is the validator's hot key, used to sign blocks and votes; operators rotate it periodically for security while keeping the same vote account. This site accepts both as input on /income/{pubkey} and resolves either to the same validator's history.",
      a_ko: 'Vote account는 스테이커가 위임하는 온체인 계정이며 validator 평생 표준 식별자로 유지됩니다. Identity pubkey는 validator의 핫 키(hot key)로 블록 서명과 투표에 사용되며, 운영자는 보안을 위해 주기적으로 로테이션하면서 vote account는 그대로 둡니다. 이 사이트의 /income/{pubkey} 페이지는 두 형식 모두 입력으로 받아 같은 validator의 history로 안내합니다.',
    },
    {
      q_en: 'What does "performance" mean on the leaderboard?',
      q_ko: '리더보드의 "performance"는 무엇을 의미하나요?',
      a_en: "Performance = (block fees + on-chain Jito tips) / slots assigned — the income earned PER SCHEDULED BLOCK. It's stake-neutral (a 100k-SOL validator and a 10M-SOL one can be compared directly) and commission-neutral (commission applies after block production). It's the cleanest answer to 'who actually runs their validator well' versus 'who has the most stake'.",
      a_ko: 'Performance = (블록 수수료 + 온체인 Jito tips) / 할당 슬롯 수 — 스케줄된 블록당 수익입니다. 스테이크 중립적(100k-SOL validator와 10M-SOL validator를 직접 비교 가능)이고 commission 중립적(commission은 블록 생산 후에 적용)입니다. "누가 스테이크가 많은가"가 아니라 "누가 실제로 validator를 잘 운영하는가"에 가장 깨끗한 답입니다.',
    },
    {
      q_en: "Why doesn't my favorite validator appear in the leaderboard?",
      q_ko: '제가 좋아하는 validator가 왜 리더보드에 안 보이나요?',
      a_en: "The leaderboard ranks the most recently CLOSED epoch only — running-epoch numbers aren't included. Validators with very few assigned slots in that epoch (under 4) are de-emphasized to avoid noisy per-slot metrics. If the validator is brand-new or wasn't scheduled, you can still pull their history directly: visit /income/{vote-or-identity-pubkey}.",
      a_ko: '리더보드는 가장 최근 종료된 에폭만 랭킹합니다 — 진행 중 에폭 숫자는 포함되지 않습니다. 그 에폭에서 할당 슬롯이 매우 적은 validator(4개 미만)는 슬롯당 지표 노이즈를 피하기 위해 약하게 표시됩니다. 신규 validator거나 스케줄되지 않은 경우, /income/{vote-또는-identity-pubkey} 페이지에서 직접 히스토리를 볼 수 있습니다.',
    },
    {
      q_en: 'Can I use this data in my own dashboard or research?',
      q_ko: '이 데이터를 제 대시보드나 연구에 사용해도 되나요?',
      a_en: "Yes — the underlying data is released under CC0 (public domain), the code is MIT-licensed, and there's a public HTTP API at /v1/* with an OpenAPI spec at /openapi.yaml. There's also an MCP server at /mcp for AI agents and an llms.txt at /llms.txt for crawlers. The site rate-limits at 60 requests/minute/IP; for higher volumes self-host via the Helm chart.",
      a_ko: '네 — 기본 데이터는 CC0(퍼블릭 도메인)로 공개되어 있고, 코드는 MIT 라이선스이며, /v1/* 의 공개 HTTP API와 /openapi.yaml의 OpenAPI 스펙이 제공됩니다. AI agent용 MCP 서버는 /mcp, 크롤러용 llms.txt는 /llms.txt에서 받을 수 있습니다. IP당 60req/min 제한이 있으므로, 대량 사용은 Helm 차트로 셀프 호스팅하세요.',
    },
    {
      q_en: 'How does this site differ from solanabeach.io / validators.app / stakewiz.com?',
      q_ko: '이 사이트는 solanabeach.io / validators.app / stakewiz.com과 무엇이 다른가요?',
      a_en: 'Three differences: (1) every metric is contextualized against the top-100 cluster median for the same epoch, so you can tell if a validator is over- or under-performing peers; (2) MEV tips are derived from each produced block, so current-epoch income can update in near real time; (3) all derived data is CC0 with a documented public API. Other dashboards typically gate this behind login or vendor-specific endpoints.',
      a_ko: '세 가지 차이가 있습니다. (1) 모든 지표를 같은 에폭의 top-100 클러스터 median과 비교 표시 — 피어 대비 잘하는지 못하는지 즉시 판단 가능; (2) MEV tips를 각 생산 블록에서 도출하므로 진행 중 에폭 수입도 거의 실시간으로 갱신 가능; (3) 모든 파생 데이터가 CC0이고 공개 API로 제공. 타 대시보드는 보통 로그인이나 벤더 엔드포인트 뒤에 둡니다.',
    },
    {
      q_en: "I'm a validator operator — how do I claim my profile here?",
      q_ko: '저는 validator 운영자입니다 — 여기서 제 프로필을 어떻게 인증하나요?',
      a_en: 'Visit /claim/{your-vote-pubkey}. The flow asks you to sign a short challenge with your validator identity keypair (`solana sign-offchain-message`); the site verifies the Ed25519 signature on-chain. After claiming you can edit a small profile (Twitter handle, footer-CTA mute, narrative paragraph). A claimed validator earns a verified-badge ✓ next to its name on the leaderboard and income hero.',
      a_ko: '/claim/{본인-vote-pubkey}로 들어가세요. validator identity 키페어로 짧은 챌린지에 서명하면(`solana sign-offchain-message`), 사이트가 Ed25519 서명을 온체인 검증합니다. 인증 후 작은 프로필(Twitter 핸들, footer CTA 숨김, narrative 문단)을 편집할 수 있습니다. 인증된 validator는 리더보드와 income 페이지에서 이름 옆에 인증 뱃지 ✓가 표시됩니다.',
    },
    {
      q_en: 'How can I stake with a validator I found here?',
      q_ko: '여기서 찾은 validator에게 어떻게 스테이킹하나요?',
      a_en: "This site is read-only — it does not handle wallets or staking transactions. To stake, copy the validator's vote pubkey, then use a wallet (Phantom, Solflare, Backpack) or a staking dashboard (Solana Compass, Marinade, Jito) to delegate. Stake activations take one full epoch (~2 days) before they earn rewards.",
      a_ko: '이 사이트는 읽기 전용입니다 — 지갑이나 스테이킹 트랜잭션을 처리하지 않습니다. 스테이킹하려면 validator의 vote pubkey를 복사한 뒤, 지갑(Phantom, Solflare, Backpack)이나 스테이킹 대시보드(Solana Compass, Marinade, Jito)에서 위임하세요. 스테이크 활성화는 한 에폭(~2일)이 지나야 보상이 시작됩니다.',
    },
  ];

  const locale = $derived(currentLocale());
  const titleText = $derived(locale === 'ko' ? '자주 묻는 질문' : 'FAQ');

  const pageTitle = $derived(`${titleText} — ${SITE_NAME}`);
  const pageDescription = $derived(
    locale === 'ko'
      ? 'Solana validator 수입, MEV, Jito, skip rate, commission에 대한 자주 묻는 질문과 답.'
      : 'Frequently asked questions about Solana validator income, MEV, Jito, skip rate, commission, and how to interpret the data on this site.',
  );

  const jsonLd = $derived({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale === 'ko' ? 'ko' : 'en',
    mainEntity: QA.map((qa) => ({
      '@type': 'Question',
      name: locale === 'ko' ? qa.q_ko : qa.q_en,
      acceptedAnswer: {
        '@type': 'Answer',
        text: locale === 'ko' ? qa.a_ko : qa.a_en,
      },
    })),
  });
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={pageDescription} />
  <link rel="canonical" href={`${SITE_URL}/faq`} />
  <link rel="alternate" hreflang="en" href={`${SITE_URL}/faq?lang=en`} />
  <link rel="alternate" hreflang="ko" href={`${SITE_URL}/faq?lang=ko`} />
  <link rel="alternate" hreflang="x-default" href={`${SITE_URL}/faq`} />
  {@html `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`}
</svelte:head>

<section class="relative">
  <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
    FAQ
  </p>
  <h1 class="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
    {locale === 'ko' ? '자주 묻는 질문' : 'Frequently Asked Questions'}
  </h1>
  <p class="mt-4 max-w-2xl text-base text-[color:var(--color-text-muted)]">
    {locale === 'ko'
      ? 'Solana validator 수입, MEV, 데이터 신선도, 스테이킹 방법까지 — 자주 받는 질문에 답합니다. 헤더의 EN/KO 토글로 영어 버전을 볼 수 있습니다.'
      : 'How Solana validator income works, what MEV means, how fresh the data is, and how to act on it. Use the EN/KO toggle in the header to switch languages.'}
  </p>
</section>

<dl class="mt-12 space-y-10">
  {#each QA as qa, i (i)}
    <div>
      <dt class="text-lg font-semibold tracking-tight">
        {locale === 'ko' ? qa.q_ko : qa.q_en}
      </dt>
      <dd class="mt-2 max-w-3xl text-sm leading-relaxed text-[color:var(--color-text-muted)]">
        {locale === 'ko' ? qa.a_ko : qa.a_en}
      </dd>
    </div>
  {/each}
</dl>

<p class="mt-12 text-xs text-[color:var(--color-text-subtle)]">
  {locale === 'ko'
    ? '답이 안 보이는 질문이 있나요? GitHub 이슈를 열거나 0base.vc로 연락주세요.'
    : 'Question we missed? Open a GitHub issue or ping 0base.vc.'}
</p>
