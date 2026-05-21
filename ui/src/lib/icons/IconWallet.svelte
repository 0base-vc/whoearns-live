<!--
  IconWallet — operator-wallet-register glyph. Simple wallet shape with
  a card-slot dot.
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
  <rect x="2" y="4" width="12" height="9" rx="1.5" />
  <path d="M2 6.5h10a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H2" />
  <circle cx="11" cy="8.5" r="0.75" fill="currentColor" stroke="none" />
</svg>
