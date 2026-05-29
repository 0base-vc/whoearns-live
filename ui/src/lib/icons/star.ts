/**
 * 8-point star geometry. Shared between:
 *
 *   - `VerifiedBadge.svelte` — solid star + checkmark, the "operator
 *     claimed" credential glyph (origin of the shape).
 *   - `TierBadge.svelte` — variable fill count (forge=8 / anvil=6 /
 *     hearth=4 / kindling=2 / unrated=0), so the SAME silhouette family
 *     reads as "achievement tier" without needing a fresh icon set.
 *   - `TenureBadge.svelte` — small accent on landmark badges (Cycle 1
 *     OG / Genesis), reusing the geometry as an ember pseudo-element.
 *
 * Why an 8-point star: it composes cleanly at 14-32px (the rendering
 * sweet spot for inline credential glyphs) and reads as "credential /
 * achievement" rather than "task complete," matching the X /
 * Instagram-verification iconography users already pattern-match
 * against. Hand-tuned in Figma to land anti-alias-symmetric at 14px.
 *
 * Coordinates are in a 16×16 user-space; the SVG `viewBox` should be
 * `0 0 16 16` and `width`/`height` whatever pixel size the consumer
 * wants. All `M` / `L` commands use absolute coordinates so a stroke
 * variant can re-use the same path.
 */
export const STAR_8_PATH_D =
  'M8 0L9.8 1.5L12 1.2L13 3.3L15 4.2L14.7 6.5L16 8L14.7 9.5L15 11.8L13 12.7L12 14.8L9.8 14.5L8 16L6.2 14.5L4 14.8L3 12.7L1 11.8L1.3 9.5L0 8L1.3 6.5L1 4.2L3 3.3L4 1.2L6.2 1.5L8 0Z';

/**
 * Per-tier fill count for `TierBadge`. The visual narrative ladders
 * from `forge` (full 8-point fill — top of the craft) down through
 * progressively-fewer-filled points to `unrated` (stroke-only — no
 * points filled). Reads "intensity of craft" without needing copy.
 *
 * `unrated` is 0 — paired with the stroke-only treatment in the
 * component so the badge is visible but visibly "in progress" /
 * "not yet measured" rather than visibly "failed."
 */
import type { NodeTier } from '../types.js';

export const TIER_STAR_FILL_COUNT: Record<NodeTier, number> = {
  forge: 8,
  anvil: 6,
  hearth: 4,
  kindling: 2,
  unrated: 0,
};
