<!--
  IconWarning — identity-rotation reclaim glyph. Triangle + exclamation.
  Used in place of ⚠ emoji to keep the audit log in the site's
  monochrome icon family + ensure cross-platform consistency.
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
  <path d="M8 2 14.5 13.5h-13z" />
  <path d="M8 6.5v3" />
  <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
</svg>
