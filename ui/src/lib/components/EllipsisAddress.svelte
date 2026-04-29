<!--
  EllipsisAddress — single-line address renderer with elastic
  middle-truncation and copy-preserving full-pubkey clipboard.

  Visual mechanism (pure CSS layout, no JS measurement):
    - parent `flex max-w-full` — flex container, width-bound by
      whatever parent imposes.
    - first span (head, pubkey minus the last `tailLen` chars) is
      a flex item with `min-w-0 truncate`. Tailwind's `truncate`
      = `overflow: hidden; text-overflow: ellipsis; white-space:
      nowrap`. The `min-w-0` defuses flex's default `min-width:
      auto` (which would refuse to shrink below intrinsic content
      width); without it, `truncate` is a no-op inside a flex row.
    - second span (tail, last `tailLen` chars) is `shrink-0` —
      reserves its width unconditionally so the suffix is always
      visible regardless of how narrow the container gets.
    - When the container is wide enough for the full pubkey both
      spans render unchanged and read as one continuous string;
      head + tail concatenated = pubkey, by construction.
    - When the container is narrow the head shrinks with the
      browser-rendered `…` at its right edge while the tail
      stays put. Visually identical to "5BAi9YGCip…C6uBPZ"
      middle-truncation, with zero JS measurement and zero
      ResizeObserver overhead.

  Copy semantics: the `oncopy` handler intercepts ClipboardEvent
  and writes the full pubkey to text/plain. Selection-based copy,
  right-click → Copy, mobile long-press → Copy all yield the full
  44-char pubkey regardless of the visible truncation. Even
  partial selection of the visible glyphs yields the full pubkey
  — the user asking for "this address" doesn't depend on whether
  they highlighted the entire visible string.

  A11y: `aria-label={pubkey}` exposes the full pubkey to screen
  readers independently of the visible text.

  Why this is simpler than ResizeObserver + binary search:
  the browser's flex layout engine already measures the container
  on every reflow and shrinks/grows flex items accordingly —
  doing it ourselves in JS just duplicated work the engine was
  going to do anyway. The previous binary-search version computed
  an "optimal" head/tail count per width, but the visual
  difference vs a fixed `tailLen` is below human-perceptible
  threshold for monospace text.
-->
<script lang="ts">
  interface Props {
    pubkey: string;
    /**
     * Trailing characters always kept visible. Default 6 leaves a
     * recognisable suffix ("…C6uBPZ") on every viewport without
     * crowding the head's truncation budget on narrow screens.
     */
    tailLen?: number;
    /**
     * Extra classes on the wrapping flex container. Pass
     * typography (`font-mono text-xs`), color, background, and
     * padding here.
     */
    class?: string;
  }
  let { pubkey, tailLen = 6, class: extra = '' }: Props = $props();

  // Static split. `head + tail = pubkey`, always — so when the
  // container is wide enough to render both fully there's no
  // visible discontinuity. `Math.max(0, …)` defends against
  // pubkeys shorter than `tailLen` (degenerate input — head
  // becomes empty, tail renders the whole thing, no truncation).
  const head = $derived(pubkey.slice(0, Math.max(0, pubkey.length - tailLen)));
  const tail = $derived(pubkey.slice(-tailLen));

  /**
   * Override clipboard payload on copy: visible truncation does
   * not affect what gets copied. Even partial selection of the
   * visible truncated string yields the full pubkey by design.
   */
  function onCopy(e: ClipboardEvent) {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', pubkey);
  }
</script>

<span oncopy={onCopy} aria-label={pubkey} class="flex max-w-full {extra}">
  <span class="min-w-0 truncate">{head}</span>
  <span class="shrink-0">{tail}</span>
</span>
