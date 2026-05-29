/**
 * Shared scaffolding for satori-rendered image routes (OG, SVG badge,
 * and future variants).
 *
 * Concerns this module owns:
 *   - Brand color tokens (single source of truth across image surfaces).
 *   - Generic time-bounded LRU cache (insertion-order eviction).
 *   - Pubkey shortening helper used by every per-validator card.
 *
 * The per-image bits (JSX-as-object tree, dimensions, output format,
 * route registration) deliberately stay in each route file because
 * they encode the visual contract and shouldn't be hidden behind an
 * abstraction.
 */

// Brand violet matches the UI's `--color-brand-500` token. Keep this
// in sync with `ui/src/app.css` if the brand colour ever changes.
export const BRAND_TOKENS = {
  brand: '#7C3AED',
  bgDark: '#1A1033',
  textPrimary: '#FFFFFF',
  textMuted: '#C4B5FD',
} as const;

export interface ImageLruCache<T> {
  get(key: string): T | null;
  set(key: string, value: T): void;
  clear(): void;
}

interface CacheEntry<T> {
  value: T;
  ts: number;
}

/**
 * Time-bounded LRU cache backed by a Map. Map iterates in insertion
 * order so the first key in `keys()` is the least-recently-used; a
 * cache hit re-inserts the entry (delete + set) to bump its position.
 *
 * Generic so the OG route can cache `Buffer` and the badge route can
 * cache `string` with one implementation.
 */
export function createImageLruCache<T>(max: number, ttlMs: number): ImageLruCache<T> {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | null {
      const hit = map.get(key);
      if (!hit) return null;
      if (Date.now() - hit.ts > ttlMs) {
        map.delete(key);
        return null;
      }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key: string, value: T): void {
      if (map.size >= max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { value, ts: Date.now() });
    },
    clear(): void {
      map.clear();
    },
  };
}

export function shortenPubkey(pubkey: string, head = 6, tail = 4): string {
  if (pubkey.length <= head + tail + 1) return pubkey;
  return `${pubkey.slice(0, head)}…${pubkey.slice(-tail)}`;
}
