/**
 * Locale store for the bilingual (EN / KO) content pages.
 *
 * Scope: ONLY content pages (About, Glossary, FAQ) — the rest of
 * the UI (header chrome, leaderboard, compare, income, claim flow)
 * stays English. Full app i18n is out of
 * scope for this iteration; introducing a switch on every label
 * would be churn without a clear payoff.
 *
 * Persistence priority:
 *   1. URL param `?lang=en|ko` — wins so shareable links work as
 *      "click here for the Korean version".
 *   2. `localStorage.svi_locale` — sticky preference across visits
 *      and across pages within a visit.
 *   3. `navigator.language` (best-effort) — kor → ko, anything else
 *      → en. Avoids forcing English on a Korean visitor's first
 *      visit; not perfect (browsers lie about language headers) but
 *      a reasonable nudge.
 *   4. Hardcoded default `en`.
 *
 * The store is a Svelte 5 rune (`$state`). Read it directly via
 * `currentLocale` exported below; write via `setLocale(locale)` so
 * the URL + storage stay in sync.
 */
import { browser } from '$app/environment';

export type Locale = 'en' | 'ko';

const STORAGE_KEY = 'svi_locale';
const URL_PARAM = 'lang';

function readInitial(): Locale {
  if (!browser) return 'en';
  // 1. URL param
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(URL_PARAM);
    if (fromUrl === 'en' || fromUrl === 'ko') return fromUrl;
  } catch {
    // ignore
  }
  // 2. localStorage
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'ko') return stored;
  } catch {
    // ignore
  }
  // 3. navigator.language
  try {
    const browserLang = window.navigator.language ?? '';
    if (browserLang.toLowerCase().startsWith('ko')) return 'ko';
  } catch {
    // ignore
  }
  return 'en';
}

let _locale = $state<Locale>(readInitial());

/**
 * Read the current locale. Wrapped as a function (not a top-level
 * `$state` export) because Svelte 5 doesn't allow exporting raw rune
 * variables from a `.svelte.ts` module — the export must be a
 * function or accessor for reactivity to flow through.
 */
export function currentLocale(): Locale {
  return _locale;
}

/**
 * Update the locale. Persists to localStorage and updates the URL
 * (replaces, not pushes — toggling shouldn't pollute back-button
 * history) so the choice is shareable + sticky.
 */
export function setLocale(next: Locale): void {
  _locale = next;
  if (!browser) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(URL_PARAM, next);
    window.history.replaceState({}, '', url.toString());
  } catch {
    // ignore
  }
}

/**
 * Re-evaluate the locale from URL params on browser back/forward.
 * SvelteKit's client navigation doesn't fire `popstate` for
 * same-route history changes, so a visitor who switched from
 * `?lang=en` → `?lang=ko` and clicks back would see Korean content
 * with an English URL. Layout calls this from `afterNavigate` so the
 * rune stays in sync with the URL bar. Only updates if the URL param
 * is a recognised locale; otherwise leaves the current value (so
 * navigations to internal links without `?lang=` don't reset the
 * sticky preference).
 */
export function syncLocaleFromUrl(url: URL): void {
  const fromUrl = url.searchParams.get(URL_PARAM);
  if ((fromUrl === 'en' || fromUrl === 'ko') && fromUrl !== _locale) {
    _locale = fromUrl;
  }
}

/**
 * Pick between English and Korean copy. Useful inside `$derived`
 * blocks: `const text = $derived(t(en, ko))`. Trivially small
 * helper — most callers will inline the ternary themselves, but
 * this reads better when the same value is used in many places.
 *
 * Cross-fallback: if the active locale's string is empty (a
 * contributor-error footgun — e.g. a half-translated terminology
 * entry), fall back to the other side rather than rendering an
 * empty paragraph silently. Only blank/whitespace fallbacks across;
 * intentional `' '` spacing or empty-by-design strings still need
 * to be passed as non-empty (e.g. `'​'`).
 */
export function t(en: string, ko: string): string {
  const active = _locale === 'ko' ? ko : en;
  if (active.trim().length > 0) return active;
  const fallback = _locale === 'ko' ? en : ko;
  return fallback;
}
