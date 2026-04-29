<!--
  Tooltip — reusable info popover for explaining metrics in plain language.

  Why a custom component instead of the native `title` attribute:
    - `title` is hover-only. ~50% of dashboard traffic is mobile/touch
      where the title never surfaces — the explanation effectively does
      not exist for those readers.
    - `title` is invisible until hover. Users can't tell which labels
      have help text. A small `(i)` trigger icon advertises "more info
      here" so curiosity actually leads somewhere.

  Behaviour:
    - Hover (mouse) and focus (keyboard) → show
    - Click / tap → toggle (lets touch users persist it open)
    - Escape OR click-outside → close
    - SR users get `role="tooltip"` + `aria-describedby` linkage so the
      popover content is announced when the trigger is focused.

  Positioning:
    - Default `top`: popover sits above the trigger, horizontally centred.
      Good for inline labels in a body row.
    - `bottom`: for triggers near the top of a card / table header where
      the top-positioned popover would clip outside the container.
    - `align="left" | "center" | "right"` controls horizontal anchor.
      Use `right` when the trigger sits near the right edge of a row
      and a centred popover would overflow the viewport.

  Sizing:
    - Popover has a hard `max-w-xs` (20rem ≈ 320px). Long explanations
      wrap; very long ones get re-edited shorter. Tooltips that need a
      paragraph belong in a docs page, not a tooltip.
-->
<script lang="ts">
  interface Props {
    /** The friendly explanation. Plain text only — no HTML. */
    content: string;
    /** Vertical placement relative to the trigger icon. */
    placement?: 'top' | 'bottom';
    /** Horizontal anchor of the popover relative to the trigger. */
    align?: 'left' | 'center' | 'right';
    /**
     * Accessible name for the trigger button. Visible to screen readers
     * but not on screen — defaults to a generic "More info" so triggers
     * scattered across a page don't all read identically. Override with
     * the metric name (e.g. "About performance").
     */
    label?: string;
  }

  let { content, placement = 'top', align = 'center', label = 'More info' }: Props = $props();

  /**
   * Per-instance unique id for `aria-describedby` linkage. Math.random
   * is overkill for this (collision probability ~10^-12) but cheap and
   * avoids a module-level counter that has to survive Vite HMR resets.
   */
  const popoverId = `tt-${Math.random().toString(36).slice(2, 10)}`;

  /**
   * Position classes assembled at runtime. We build the class string
   * here rather than using Svelte's `class:NAME={cond}` directive
   * because Tailwind's positioning utilities include slashes
   * (`left-1/2`, `-translate-x-1/2`) which the directive parser
   * rejects as invalid identifiers.
   */
  const popoverClasses = $derived.by(() => {
    const vert = placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2';
    const horiz =
      align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'left' ? 'left-0' : 'right-0';
    return `${vert} ${horiz}`;
  });

  let trigger: HTMLButtonElement | undefined = $state();
  let open = $state(false);

  function show() {
    open = true;
  }
  function hide() {
    open = false;
  }
  function toggle(e: MouseEvent) {
    // Stop the click from bubbling into the click-outside listener
    // we attach below; otherwise the toggle that opens the tooltip
    // would also be the click that closes it.
    e.stopPropagation();
    open = !open;
  }

  /**
   * Click-outside + Escape dismissal. Listeners are attached lazily
   * (only while the tooltip is open) so a closed tooltip costs nothing
   * at runtime. The `setTimeout(0)` ensures the click that opened the
   * popover doesn't fire the outside-click handler immediately.
   */
  $effect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (trigger && !trigger.contains(e.target as Node)) {
        open = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    const handle = setTimeout(() => {
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(handle);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

<span class="relative inline-flex items-center">
  <!--
    Tap target sizing: the visible `(i)` chip stays 14×14 px (visually
    quiet next to label text, doesn't fight the metric for attention)
    BUT the actual hit-area extends to ≥ 44×44 px via a transparent
    `::before` pseudo-element so touch users can comfortably tap the
    chip without precise aim. WCAG 2.5.5 / iOS HIG / Material all
    converge on 44/48dp; expanding the chip itself would crowd the
    leaderboard rows (each row carries ~6 chips), so the invisible
    hit-area pattern is the right trade-off.
  -->
  <button
    bind:this={trigger}
    type="button"
    class="relative ml-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[color:var(--color-border-default)] text-[9px] font-bold leading-none text-[color:var(--color-text-muted)] transition-colors before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:border-[color:var(--color-brand-500)] hover:bg-[color:var(--color-brand-500)] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-brand-500)]"
    aria-label={label}
    aria-describedby={open ? popoverId : undefined}
    aria-expanded={open}
    onmouseenter={show}
    onmouseleave={hide}
    onfocus={show}
    onblur={hide}
    onclick={toggle}
  >
    <span aria-hidden="true">i</span>
  </button>

  {#if open}
    <span
      id={popoverId}
      role="tooltip"
      class="pointer-events-none absolute z-50 w-max max-w-xs whitespace-normal rounded-md border border-[color:var(--color-border-default)] bg-[color:var(--color-surface)] px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-[color:var(--color-text-default)] shadow-lg {popoverClasses}"
    >
      {content}
    </span>
  {/if}
</span>
