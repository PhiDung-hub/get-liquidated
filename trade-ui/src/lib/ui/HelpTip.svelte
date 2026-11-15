<script lang="ts">
  const HINT = 'abbr[title], [data-help][title]';
  const DELAY_MS = 250;
  let tip = $state<{ text: string; x: number; y: number; above: boolean } | null>(null);
  let box = $state<HTMLDivElement>();

  // The hint's title is lifted while shown, so the browser's own slow, unstyled tooltip never shows; it comes back on leave.
  // A mouse shows it after a short hover; a tap shows it at once, and a second tap or a tap elsewhere hides it.
  // Inside a dialog it opens upward: below the label it would sit over Confirm, and the tap that dismisses it would land there.
  $effect(() => {
    let el: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let mouse: { x: number; y: number } | null = null;
    const leave = () => {
      clearTimeout(timer);
      if (el?.dataset.helpText !== undefined) el.setAttribute('title', el.dataset.helpText), delete el.dataset.helpText;
      el = null;
      tip = null;
    };
    const show = (hit: HTMLElement, delay: number) => {
      el = hit;
      el.dataset.helpText = el.getAttribute('title') ?? '';
      el.removeAttribute('title');
      timer = setTimeout(() => {
        if (!el?.dataset.helpText) return;
        const r = el.getBoundingClientRect();
        tip = { text: el.dataset.helpText, x: r.left + r.width / 2, y: r.bottom + 6, above: r.bottom + 120 > innerHeight || !!el.closest('[role="dialog"]') };
        if (tip.above) tip.y = r.top - 6;
      }, delay);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      mouse = { x: e.clientX, y: e.clientY };
      const hit = (e.target as Element | null)?.closest?.<HTMLElement>(`${HINT}, [data-help-text]`) ?? null;
      if (hit === el) return;
      leave();
      if (hit) show(hit, DELAY_MS);
    };
    const tap = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      mouse = null;
      const hit = (e.target as Element | null)?.closest?.<HTMLElement>('abbr, [data-help]') ?? null;
      if (!hit || hit === el) return leave();
      leave();
      if (hit.hasAttribute('title')) show(hit, 0);
    };
    const moved = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') mouse = { x: e.clientX, y: e.clientY };
    };
    const scrolled = (e: Event) => {
      if (!el || (e.target instanceof Element && !e.target.contains(el))) return;
      leave();
      if (!mouse) return;
      const hit = document.elementFromPoint(mouse.x, mouse.y)?.closest<HTMLElement>(HINT);
      if (hit) show(hit, DELAY_MS);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointermove', moved);
    document.addEventListener('pointerup', tap);
    addEventListener('scroll', scrolled, true);
    addEventListener('blur', leave);
    return () => {
      leave();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointermove', moved);
      document.removeEventListener('pointerup', tap);
      removeEventListener('scroll', scrolled, true);
      removeEventListener('blur', leave);
    };
  });

  // Keeps the box inside the viewport once its width is known.
  const left = $derived.by(() => {
    if (!tip || !box) return tip?.x ?? 0;
    const w = box.offsetWidth;
    return Math.min(Math.max(8, tip.x - w / 2), innerWidth - w - 8);
  });
</script>

{#if tip}
  <div bind:this={box} class="help-tip" class:above={tip.above} role="tooltip" data-testid="help-tip" style:left="{left}px" style:top="{tip.y}px">{tip.text}</div>
{/if}

<style>
  .help-tip {
    position: fixed; z-index: 50; max-width: min(360px, calc(100vw - 16px)); padding: 8px 11px;
    background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 6px 20px #0006; font-size: max(8px, calc(var(--fs) * 0.95)); line-height: 1.45; white-space: pre-line; pointer-events: none;
  }
  .help-tip.above { transform: translateY(-100%); }
</style>
