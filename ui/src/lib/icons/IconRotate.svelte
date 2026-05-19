<!--
  IconRotate — re-claim / nonce-bump glyph. Circular arrow.
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
  <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
  <path d="M13 3v3h-3" />
  <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
  <path d="M3 13v-3h3" />
</svg>
