<!--
  IconLink — github-link / external-attestation glyph. Two chain links.
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
  <path d="M6.5 4.5h-2A2.5 2.5 0 0 0 2 7v2A2.5 2.5 0 0 0 4.5 11.5h2" />
  <path d="M9.5 11.5h2A2.5 2.5 0 0 0 14 9V7a2.5 2.5 0 0 0-2.5-2.5h-2" />
  <path d="M5.5 8h5" />
</svg>
