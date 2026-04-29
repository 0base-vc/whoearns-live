<!--
  LocaleSwitcher — tiny EN/KO segmented toggle in the page header.

  Scope is intentionally narrow: only the bilingual content pages
  (About, Glossary, FAQ) read the locale. Product/data surfaces stay
  English-first. Switching does NOT reload — the
  store is reactive and content components re-render automatically.
-->
<script lang="ts">
  import { currentLocale, setLocale, type Locale } from '$lib/stores/locale.svelte';

  const locale = $derived(currentLocale());

  function pick(next: Locale) {
    if (next !== locale) setLocale(next);
  }
</script>

<!--
  `title` on the wrapping group spells out which surfaces consume
  the locale toggle. The component is only rendered on bilingual
  content routes, so the title can stay simple.
-->
<div
  role="group"
  aria-label="Language"
  title="Switch language for this content page"
  class="inline-flex items-center gap-0.5 rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] p-0.5 text-xs font-semibold"
>
  <!--
    Visible label is a 2-letter ISO code (compact for the header),
    but screen readers + hover get the full language name so the
    affordance isn't ambiguous to assistive tech (otherwise SR
    announces "E-N button" which is meaningless out of context).

    Tap target sizing: WCAG 2.5.5 / iOS HIG / Android Material all
    converge on ≥ 44×44 px for touch surfaces. The visible 2-letter
    label is small (12px font) because horizontal header real estate
    is precious; we hit the 44 px floor via padding (`min-h-11
    min-w-11`) so the actual hit-area covers the full chip even
    though the inked label looks compact. `gap-0.5` on the parent
    keeps adjacent EN/KO buttons from sharing a hit-region (was 0px
    before — fat-finger trap that selected the wrong locale).
  -->
  <button
    type="button"
    onclick={() => pick('en')}
    aria-pressed={locale === 'en'}
    title="English"
    lang="en"
    class="inline-flex min-h-11 min-w-11 items-center justify-center rounded px-3 transition-colors"
    class:bg-[color:var(--color-brand-500)]={locale === 'en'}
    class:text-white={locale === 'en'}
    class:text-[color:var(--color-text-muted)]={locale !== 'en'}
    class:hover:text-[color:var(--color-text-default)]={locale !== 'en'}
  >
    <span aria-hidden="true">EN</span>
    <span class="sr-only">English</span>
  </button>
  <button
    type="button"
    onclick={() => pick('ko')}
    aria-pressed={locale === 'ko'}
    title="한국어"
    lang="ko"
    class="inline-flex min-h-11 min-w-11 items-center justify-center rounded px-3 transition-colors"
    class:bg-[color:var(--color-brand-500)]={locale === 'ko'}
    class:text-white={locale === 'ko'}
    class:text-[color:var(--color-text-muted)]={locale !== 'ko'}
    class:hover:text-[color:var(--color-text-default)]={locale !== 'ko'}
  >
    <span aria-hidden="true">KO</span>
    <span class="sr-only">한국어</span>
  </button>
</div>
