<!--
  IconKey — claim event glyph. Hand-tuned at 16×16 to match the
  same line-weight family as the rest of `lib/icons/`. `currentColor`
  throughout so the consumer can tint via `text-[color:var(...)]`.
-->
<script lang="ts">
  interface Props {
    size?: number;
  }
  let { size = 16 }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 16 16"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <circle cx="6" cy="10" r="3" />
  <path d="M8.5 8 14 2.5" />
  <path d="M11.5 5 13 6.5" />
</svg>
