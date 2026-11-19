<script lang="ts">
  const DETAIL = '[data-help-detail]';
  const HINT = `abbr[title], [data-help][title], ${DETAIL}`;
  const TITLE = '[title]:not([title=""])';
  const DELAY_MS = 250;
  let tip = $state<{ text: string; x: number; y: number; above: boolean; emphasizeNumbers: boolean } | null>(null);
  let box = $state<HTMLDivElement>();

  // An empty title on the hovered child prevents a native tooltip inherited from any ancestor.
  // A mouse shows it after a short hover; a tap shows it at once, and a second tap or a tap elsewhere hides it.
  // Inside a dialog it opens upward: below the label it would sit over Confirm, and the tap that dismisses it would land there.
  $effect(() => {
    let el: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let updates: MutationObserver | undefined;
    let mouse: { x: number; y: number } | null = null;
    let native: { target: Element; title: string | null } | null = null;
    const nativeChanges = new MutationObserver(() => {
      if (!native) return;
      const title = native.target.getAttribute('title');
      if (title === '') return;
      native.title = title;
      native.target.setAttribute('title', '');
    });
    const restoreNative = () => {
      if (!native) return;
      nativeChanges.disconnect();
      const { target, title } = native;
      if (target.getAttribute('title') === '') {
        if (title === null) target.removeAttribute('title');
        else target.setAttribute('title', title);
      }
      native = null;
    };
    const leave = () => {
      restoreNative();
      clearTimeout(timer);
      updates?.disconnect();
      if (el?.dataset.helpText !== undefined) el.setAttribute('title', el.dataset.helpText), delete el.dataset.helpText;
      el = null;
      tip = null;
    };
    const show = (hit: HTMLElement, delay: number) => {
      el = hit;
      if (hit.hasAttribute('title')) {
        hit.dataset.helpText = hit.getAttribute('title') ?? '';
        hit.removeAttribute('title');
      }
      timer = setTimeout(() => {
        const text = hit.dataset.helpDetail ?? hit.dataset.helpText;
        if (!text || !hit.isConnected || document.querySelector('[role=tooltip]:not(.help-tip)')) return;
        const r = hit.getBoundingClientRect();
        tip = { text, x: r.left + r.width / 2, y: r.bottom + 6, above: r.bottom + 120 > innerHeight || !!hit.closest('[role="dialog"]'), emphasizeNumbers: hit.hasAttribute('data-help-numbers') };
        if (tip.above) tip.y = r.top - 6;
        if (hit.matches(DETAIL)) {
          updates = new MutationObserver(() => { if (tip) tip.text = hit.dataset.helpDetail ?? ''; });
          updates.observe(hit, { attributes: true, attributeFilter: ['data-help-detail'] });
        }
      }, delay);
    };
    const hover = (target: Element | null) => {
      restoreNative();
      const hit = target?.closest<HTMLElement>(`${HINT}, [data-help-text]`) ?? target?.closest<HTMLElement>(TITLE) ?? null;
      if (hit !== el) {
        leave();
        if (hit) show(hit, DELAY_MS);
      }
      if (hit && target) {
        native = { target, title: target.getAttribute('title') };
        target.setAttribute('title', '');
        nativeChanges.observe(target, { attributes: true, attributeFilter: ['title'] });
      }
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      mouse = { x: e.clientX, y: e.clientY };
      hover(e.target instanceof Element ? e.target : null);
    };
    const tap = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      mouse = null;
      const hit = (e.target as Element | null)?.closest?.<HTMLElement>(`abbr, [data-help], ${DETAIL}`) ?? null;
      if (!hit || hit === el) return leave();
      leave();
      if (hit.hasAttribute('title') || hit.matches(DETAIL)) show(hit, 0);
    };
    const focus = (e: FocusEvent) => {
      const hit = e.target;
      if (!(hit instanceof HTMLElement) || !hit.matches(`${DETAIL}:focus-visible`) || hit === el) return;
      leave();
      show(hit, 0);
    };
    const unfocus = (e: FocusEvent) => { if (e.target === el && el?.matches(DETAIL)) leave(); };
    const dismiss = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !el?.matches(DETAIL)) return;
      leave();
      e.stopPropagation();
    };
    const moved = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') mouse = { x: e.clientX, y: e.clientY };
    };
    const scrolled = (e: Event) => {
      if (!el || (e.target instanceof Element && !e.target.contains(el))) return;
      leave();
      if (!mouse) return;
      hover(document.elementFromPoint(mouse.x, mouse.y));
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointermove', moved);
    document.addEventListener('pointerup', tap);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', unfocus);
    document.addEventListener('keydown', dismiss);
    addEventListener('scroll', scrolled, true);
    addEventListener('blur', leave);
    return () => {
      leave();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointermove', moved);
      document.removeEventListener('pointerup', tap);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', unfocus);
      document.removeEventListener('keydown', dismiss);
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
  <div bind:this={box} class="help-tip" class:above={tip.above} role="tooltip" data-testid="help-tip" style:left="{left}px" style:top="{tip.y}px">{#if tip.emphasizeNumbers}{#each tip.text.split(/(-?\d[\d,]*(?:\.\d+)?)/) as part, i}{#if i % 2}<strong class="num">{part}</strong>{:else}{part}{/if}{/each}{:else}{tip.text}{/if}</div>
{/if}

<style>
  .help-tip {
    position: fixed; z-index: 50; max-width: min(360px, calc(100vw - 16px)); padding: 8px 11px;
    background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 6px 20px #0006; font-size: max(8px, calc(var(--fs) * 0.95)); line-height: 1.45; white-space: pre-line; pointer-events: none;
  }
  .help-tip.above { transform: translateY(-100%); }
  strong { color: var(--bright); font-weight: 700; white-space: nowrap; }
</style>
