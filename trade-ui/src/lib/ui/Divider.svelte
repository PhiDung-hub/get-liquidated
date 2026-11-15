<script lang="ts">
  let { axis, label, value, style, start, move, end, reset }: {
    axis: 'x' | 'y'; label: string; value: number; style: string;
    start: () => void; move: (delta: number) => void; end: () => void; reset: () => void;
  } = $props();

  let origin = $state<number | null>(null);
  let tapped = 0;
  const at = (e: PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);
  const KEYS: Record<string, Record<string, number>> = { x: { ArrowLeft: -16, ArrowRight: 16 }, y: { ArrowUp: -16, ArrowDown: 16 } };

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    // Touch has no reliable dblclick, so a second tap within 300 ms resets.
    if (e.pointerType === 'touch') {
      if (e.timeStamp - tapped < 300) return void ((tapped = 0), reset());
      tapped = e.timeStamp;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    origin = at(e);
    start();
  }
  function drag(e: PointerEvent) {
    if (origin !== null) move(Math.round(at(e) - origin));
  }
  function up() {
    if (origin === null) return;
    origin = null;
    end();
  }
  function key(e: KeyboardEvent) {
    const step = KEYS[axis][e.key];
    if (!step) return;
    e.preventDefault();
    start();
    move(step);
    end();
  }
</script>

<!-- A focusable separator is an ARIA widget (it takes arrow keys), which Svelte's a11y lint does not know. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator" tabindex="0" aria-label={label} aria-valuenow={value} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
  class={axis} class:active={origin !== null} {style}
  onpointerdown={down} onpointermove={drag} onpointerup={up} onpointercancel={up} ondblclick={reset} onkeydown={key}
></div>

<style>
  div { position: absolute; z-index: 5; touch-action: none; user-select: none; outline: none; }
  div::after { content: ''; position: absolute; background: transparent; }
  div:hover::after, div:focus-visible::after, .active::after { background: var(--accent); }
  .x { top: 0; bottom: 0; width: 7px; cursor: col-resize; }
  .x::after { top: 0; bottom: 0; left: 3px; width: 1px; }
  .y { left: 0; height: 7px; cursor: row-resize; }
  .y::after { left: 0; right: 0; top: 3px; height: 1px; }
</style>
