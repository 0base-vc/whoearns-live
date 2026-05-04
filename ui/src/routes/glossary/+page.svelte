<!--
  /glossary — bilingual definitions of the Solana terms used across
  this site.

  Why a glossary at all: the income/leaderboard pages are dense with
  Solana-specific vocabulary (epoch, slot, MEV, Jito, skip rate). For
  delegators new to validator analytics, the tooltips alone aren't
  enough — and for SEO, a structured set of definitions answers the
  long-tail "what is X on Solana" queries that funnel users in.

  The page uses a `FAQPage` JSON-LD with each term as a Question/
  Answer pair (Schema.org's pattern for definitional content). The
  visible content tracks the active locale; the JSON-LD also tracks
  locale so search engines see the actual content they'll display
  for the resolved page.
-->
<script lang="ts">
  import { currentLocale } from '$lib/stores/locale.svelte';
  import { SITE_NAME, SITE_URL } from '$lib/site';

  function serializeJsonLd(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  /**
   * Each term has English + Korean copy. Edit this array to add /
   * remove / clarify terms; the rendered list and the JSON-LD both
   * derive from the same source so they can't drift.
   *
   * Tone target: a curious delegator who's been holding SOL for a
   * year and wants to understand what a "validator skip rate" is.
   * Avoid implementation jargon (no SIMD numbers, no protocol
   * version specifics) unless it's the question itself.
   */
  const TERMS = [
    {
      term: 'Epoch',
      en: "Solana groups blocks into 'epochs' — fixed windows of 432,000 slots that take about 2 days to complete on mainnet. Most validator metrics on this site are reported per epoch: an epoch closes, and its numbers become final.",
      ko: 'Solana는 블록을 "에폭(epoch)"이라는 고정 윈도우로 묶습니다. 한 에폭은 432,000 슬롯이고 메인넷에서 약 2일이 걸립니다. 이 사이트의 대부분 지표는 에폭 단위로 집계되며, 에폭이 닫히면 그 숫자는 최종(final)이 됩니다.',
    },
    {
      term: 'Slot',
      en: "A slot is the smallest unit of Solana's leader rotation — about 400ms. Each slot has exactly one validator scheduled as the leader; if that validator produces a block in the slot, it earns the block's fees.",
      ko: '슬롯은 Solana 리더 로테이션의 최소 단위로 약 400ms입니다. 각 슬롯마다 정확히 한 명의 리더 validator가 스케줄되며, 해당 validator가 그 슬롯에서 블록을 생산하면 그 블록의 수수료를 받습니다.',
    },
    {
      term: 'Leader schedule',
      en: 'Before each epoch starts, Solana deterministically assigns leader slots to validators — biased by activated stake (more stake → more slots). The schedule is the source of truth for "which validator was supposed to produce block N".',
      ko: '각 에폭이 시작되기 전에 Solana는 리더 슬롯을 결정적으로 validator들에게 할당합니다 — 활성 스테이크에 비례해서요 (스테이크 많을수록 슬롯도 많아짐). 이 스케줄이 "블록 N을 누가 만들기로 되어 있었는가"의 기준입니다.',
    },
    {
      term: 'Skip rate',
      en: "The percentage of leader slots a validator failed to produce. 0% is perfect; consistently above ~5% usually means an unhealthy node or a misconfigured one. Skip rate is one of the cleanest signals of operator quality because it's stake-neutral.",
      ko: 'validator가 자신에게 할당된 리더 슬롯에서 블록을 만들지 못한 비율입니다. 0%가 완벽한 값이고, 지속적으로 ~5% 이상이면 노드가 불안정하거나 잘못 설정된 경우가 많습니다. Skip rate는 스테이크와 무관해서 운영 품질을 보는 가장 깨끗한 지표 중 하나입니다.',
    },
    {
      term: 'Block fee',
      en: "Total fees the leader receives for a block they produced. Decomposes into 'base fee' (a fixed 5,000 lamports per signature) and 'priority fee' (an optional extra users pay to outbid others for inclusion).",
      ko: '리더가 자신이 생산한 블록에서 받는 총 수수료입니다. "기본 수수료(base fee)"는 서명당 고정 5,000 lamports이고, "우선순위 수수료(priority fee)"는 사용자가 빠른 포함을 위해 추가로 내는 옵션 수수료입니다.',
    },
    {
      term: 'Priority fee',
      en: 'Optional extra users pay to outbid others for transaction inclusion in busy blocks. Since SIMD-96, 100% of priority fees go to the block leader (no burn).',
      ko: '혼잡한 블록에서 다른 트랜잭션보다 먼저 포함되기 위해 사용자가 추가로 내는 옵션 수수료입니다. SIMD-96 이후 우선순위 수수료의 100%가 블록 리더에게 가며 소각되지 않습니다.',
    },
    {
      term: 'MEV (Maximal Extractable Value)',
      en: "Profit traders extract by re-ordering, inserting, or front-running transactions in a block. On Solana, most MEV flows through the Jito block engine — searchers bid for inclusion, the leader collects 'tips' on-chain.",
      ko: '트레이더가 블록 안 트랜잭션을 재정렬, 삽입, 또는 앞지르기(front-run)해서 뽑아내는 수익입니다. Solana에서는 대부분의 MEV가 Jito 블록 엔진을 통해 흐릅니다 — 서처(searcher)가 입찰하고, 리더는 온체인으로 "팁(tip)"을 받습니다.',
    },
    {
      term: 'Jito tips',
      en: "On-chain SOL transfers to one of Jito's 8 tip accounts, deposited by traders to land bundles in this validator's blocks. This site derives MEV tips directly from produced block data.",
      ko: 'Jito의 8개 팁 계정 중 하나로 들어오는 온체인 SOL 송금입니다. 트레이더들이 이 validator의 블록에 번들을 넣기 위해 입금합니다. 이 사이트는 생산 블록 데이터에서 MEV tips를 직접 도출합니다.',
    },
    {
      term: 'Jito TipRouter',
      en: 'The on-chain program that distributes Jito MEV tips. It takes a protocol fee, then routes the rest to the validator and its delegators. WhoEarns reports the raw tips observed in produced blocks, not a delayed payout feed.',
      ko: 'Jito MEV 팁을 분배하는 온체인 프로그램입니다. 프로토콜 수수료를 떼고 나머지를 validator와 delegator들에게 분배합니다. WhoEarns는 지연 공개되는 페이아웃 피드가 아니라 생산 블록에서 관측한 원시 팁을 보여줍니다.',
    },
    {
      term: 'Lamport',
      en: 'The smallest unit of SOL. 1 SOL = 1,000,000,000 lamports. All raw on-chain amounts are lamports; this site shows both lamport (string for BigInt safety) and SOL (decimal) representations.',
      ko: 'SOL의 최소 단위입니다. 1 SOL = 1,000,000,000 lamports. 모든 원시 온체인 금액은 lamports이며, 이 사이트는 lamport(BigInt 안전을 위해 문자열)와 SOL(소수점) 두 형식을 모두 제공합니다.',
    },
    {
      term: 'Vote account',
      en: "The on-chain account stakers delegate to. A validator has exactly ONE vote account that lives across the lifetime of the validator — it's the canonical identifier and survives identity-key rotations.",
      ko: '스테이커가 위임하는 온체인 계정입니다. validator는 평생 정확히 하나의 vote account를 가지며, 이는 정체성(identity) 키 로테이션을 거치더라도 유지되는 표준 식별자입니다.',
    },
    {
      term: 'Identity pubkey',
      en: "The validator's hot key — signs blocks and votes. Operators may rotate this key periodically (common security practice) while keeping the same vote account.",
      ko: 'validator의 핫 키(hot key)입니다 — 블록 서명과 투표에 사용됩니다. 운영자는 보안 관행으로 이 키를 주기적으로 로테이션하면서 vote account는 그대로 유지하는 경우가 많습니다.',
    },
    {
      term: 'Activated stake',
      en: 'The total SOL currently delegated to a validator and "active" (delegations have a one-epoch warmup). Drives leader-slot allocation: more activated stake = more leader slots = more income.',
      ko: 'validator에게 위임되어 현재 활성화된 SOL의 총합입니다 (위임에는 한 에폭의 워밍업 기간이 있음). 리더 슬롯 배정의 기준이며, 활성 스테이크가 많을수록 리더 슬롯도 많아져 수입이 커집니다.',
    },
    {
      term: 'Commission',
      en: 'The percentage cut the validator takes from inflation rewards before passing the rest to delegators. NOTE: this site shows the OPERATOR side income — what the validator earns. Delegator yield = (1 - commission) × operator yield.',
      ko: 'validator가 인플레이션 보상에서 자신의 몫으로 떼는 비율입니다. 참고: 이 사이트는 운영자(OPERATOR) 측 수입을 보여줍니다. Delegator의 수익률은 = (1 - commission) × operator 수익률입니다.',
    },
    {
      term: 'APR / APY (operator)',
      en: 'Annualised return on activated stake from the operator side. Calculated as (block fees + on-chain Jito tips) / activated stake × ~182 epochs/year. Distinct from the delegator-facing APR which subtracts the validator commission.',
      ko: '활성 스테이크 대비 연환산 수익률(운영자 측)입니다. 계산식: (블록 수수료 + 온체인 Jito tips) / 활성 스테이크 × 약 182 에폭/년. Validator commission이 차감된 delegator APR과 구분됩니다.',
    },
  ];

  const locale = $derived(currentLocale());
  const titleText = $derived(locale === 'ko' ? '용어집' : 'Glossary');

  const pageTitle = $derived(`${titleText} — ${SITE_NAME}`);
  const pageDescription = $derived(
    locale === 'ko'
      ? 'Solana validator 분석 페이지에서 사용되는 용어 풀이. Epoch, MEV, Skip rate, Jito 등 핵심 개념을 한국어로 설명합니다.'
      : 'Plain-language definitions of the Solana validator terms used across this site — epoch, MEV, skip rate, Jito, and more.',
  );

  /**
   * FAQPage structured data — each term becomes a Question / Answer
   * pair. Schema.org's `FAQPage` type is the standard convention for
   * definitional content; SEO + GEO engines (Google rich-results,
   * Perplexity, ChatGPT browse) recognize this shape as citable
   * Q&A content.
   */
  const jsonLd = $derived({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: locale === 'ko' ? 'ko' : 'en',
    mainEntity: TERMS.map((t) => ({
      '@type': 'Question',
      // Korean Q-form sidesteps the `이란/란` 조사 (subject particle)
      // ambiguity — the right particle depends on whether the term
      // ends in a consonant (이란) or a vowel (란), and our terms
      // are mostly English loanwords whose phonetic ending isn't
      // obvious to the reader. `— 무엇인가요?` is universally
      // grammatical regardless of how the term is pronounced.
      name: locale === 'ko' ? `${t.term} — 무엇인가요?` : `What is ${t.term}?`,
      acceptedAnswer: {
        '@type': 'Answer',
        text: locale === 'ko' ? t.ko : t.en,
      },
    })),
  });
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={pageDescription} />
  <link rel="canonical" href={`${SITE_URL}/glossary`} />
  <link rel="alternate" hreflang="en" href={`${SITE_URL}/glossary?lang=en`} />
  <link rel="alternate" hreflang="ko" href={`${SITE_URL}/glossary?lang=ko`} />
  <link rel="alternate" hreflang="x-default" href={`${SITE_URL}/glossary`} />
  {@html `<script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>`}
</svelte:head>

<section class="relative">
  <p class="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-brand-500)]">
    {locale === 'ko' ? '용어집' : 'Glossary'}
  </p>
  <h1 class="mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
    {locale === 'ko' ? 'Solana Validator 용어집' : 'Solana Validator Glossary'}
  </h1>
  <p class="mt-4 max-w-2xl text-base text-[color:var(--color-text-muted)]">
    {locale === 'ko'
      ? '이 사이트에서 사용되는 Solana validator 관련 용어들을 평이한 한국어로 풀어 설명합니다. 화면 우측 상단의 EN/KO 토글로 영어 버전도 볼 수 있습니다.'
      : 'Plain-language definitions of the Solana validator terms used across this site. Use the EN/KO toggle in the header to switch languages.'}
  </p>
</section>

<!--
  Heading outline: `<h2>` (visually hidden) anchors the term list as
  a Section in the page outline so the rotor reads `H1 (page) → H2
  (Terms) → list of <dt>` instead of `H1 → list of <dt>` (which made
  the term entries the only structured landmarks under H1, then the
  DelegationCTA's H3 below appeared as a level skip). The `dt` itself
  stays as a definition term, not a heading — semantics preserved.
-->
<h2 id="terms-title" class="sr-only">{locale === 'ko' ? '용어 목록' : 'Terms'}</h2>
<dl class="mt-12 space-y-8" aria-labelledby="terms-title">
  {#each TERMS as term (term.term)}
    <div class="border-l-4 border-[color:var(--color-brand-500)] pl-5">
      <dt class="text-lg font-semibold tracking-tight">{term.term}</dt>
      <dd class="mt-1 max-w-3xl text-sm leading-relaxed text-[color:var(--color-text-muted)]">
        {locale === 'ko' ? term.ko : term.en}
      </dd>
    </div>
  {/each}
</dl>

<p class="mt-12 text-xs text-[color:var(--color-text-subtle)]">
  {locale === 'ko'
    ? '단어가 빠졌나요? GitHub에서 PR을 보내주시거나 0base.vc에 알려주세요.'
    : 'Missing a term? Send a PR on GitHub or ping 0base.vc.'}
</p>
