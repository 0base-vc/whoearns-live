<!--
  MaintainerMark — inline SVG of the 0base.vc operator symbol.

  Distinct from `BrandMark.svelte` (the WhoEarns product mark): this
  glyph identifies the *maintainer* of the deployment, not the
  product itself. Used in the /about page maintainer card to make
  the attribution visually unambiguous (icon + name = "the company
  behind this site"), and reserved for similar maintainer-context
  spots if any are added later (e.g. an "About 0base.vc" section in
  the footer).

  Why inline rather than `<img src="remote.svg">`:
  - No network hop, no CORS; renders instantly with the shell.
  - Inherits `color: currentColor` so the glyph re-colors via the
    parent's text-color — e.g. white inside a violet maintainer
    card, dark inside a neutral footer.
  - CSP-friendly (no external references).

  Source is `0base-vc/brand-kit svg/0base_vc_symbol.svg` at the
  viewBox shown; we've stripped the Korean layer metadata and
  hard-coded `fill="currentColor"` for themability. If the 0base
  brand updates, re-export from the kit and paste the single
  `<path>` block.

  Forks of this codebase deploying as a different maintainer should
  swap this file's `<path>` with their own attribution mark and
  update the maintainer copy in `/about`.
-->
<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }
  let { size = 28, class: extra = '' }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 400 400"
  xmlns="http://www.w3.org/2000/svg"
  class={extra}
  aria-hidden="true"
  focusable="false"
>
  <path
    fill="currentColor"
    d="M274.25,279.59c4.18-4.41,9-16.82,10.75-30.49,1.79-13.82,3.89-58.37,4.18-66.77,2.42-71-35.92-107.82-79.14-107.82s-93,36.81-95.47,107.82c-2,16.81-2.91,48.49-2.33,60s3.38,27,11,37.21H89.31L66,314.34H179l1.48-6.11c-10.72-2-15.55-10.16-18-19.61-2.29-8.71-2.18-46.78-.46-97,.64-18.83,4.11-38.15,7.62-53.06,5.24-22.26,18.63-39.33,39.54-39.05,13.36.19,26.94,13.07,30.09,34.55,2.35,16,1.39,37.46.7,57.56-1.6,47.06-5,78.95-11.33,92.93-5.27,11.66-19.31,21-33.67,23.6l-1.5,6.17H307.08l23.29-34.75Z"
  />
</svg>
