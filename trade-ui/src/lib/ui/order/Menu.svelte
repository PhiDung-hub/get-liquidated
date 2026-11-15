<script lang="ts" module>
  /** Open menus; while any is, order keys are refused. */
  export const menus = { open: 0 };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  type Option = { value: string; label: string; testid?: string; description?: string; group?: string; pinned?: boolean; pinDisabled?: boolean };
  let { value, options, onpick, testid, text, align = 'right', ariaLabel, dropdown = false, onpin, pinHint }: {
    value: string; options: Option[]; onpick: (v: string) => void; testid?: string; text?: string; align?: 'left' | 'right'; ariaLabel?: string; dropdown?: boolean;
    onpin?: (value: string) => void; pinHint?: string;
  } = $props();

  let open = $state(false);
  let active = $state(0);
  let root = $state<HTMLDivElement>();
  let list = $state<HTMLUListElement>();
  let trigger = $state<HTMLButtonElement>();
  const phone = new MediaQuery('(max-width: 900px), (pointer: coarse) and (max-height: 500px)');
  const anchored = $derived(dropdown || phone.current);
  let at = $state({ top: 0, left: 0, maxHeight: 320, maxWidth: 0 });
  const helpId = $props.id();
  const shown = $derived(text ?? options.find((o) => o.value === value)?.label ?? value);

  function place() {
    if (!open || !anchored || !list || !trigger) return;
    const viewport = window.visualViewport;
    const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const r = trigger!.getBoundingClientRect();
    const below = Math.max(0, y + height - r.bottom - 10);
    const above = Math.max(0, r.top - y - 10);
    const content = list.scrollHeight + list.offsetHeight - list.clientHeight;
    const cap = Math.max(0, phone.current ? Math.min(320, height * 0.6) : height - 16);
    const up = Math.min(content, cap) > below && above > below;
    const maxHeight = Math.min(cap, up ? above : below);
    const size = Math.min(content, maxHeight);
    at = {
      top: Math.max(y + 8, Math.min(y + height - size - 8, up ? r.top - size - 2 : r.bottom + 2)),
      left: Math.max(x + 8, Math.min(x + width - list.offsetWidth - 8, align === 'right' ? r.right - list.offsetWidth : r.left)),
      maxHeight,
      maxWidth: Math.max(0, width - 16)
    };
  }

  async function show() {
    active = Math.max(0, options.findIndex((o) => o.value === value));
    const viewport = window.visualViewport;
    const r = trigger!.getBoundingClientRect();
    at = { top: r.bottom + 2, left: r.left, maxHeight: 320, maxWidth: Math.max(0, (viewport?.width ?? innerWidth) - 16) };
    open = true;
    await tick();
    place();
    await tick();
    list?.focus({ preventScroll: anchored });
    reveal();
  }

  function reveal() {
    const item = list?.querySelector<HTMLElement>('li.active');
    if (!list || !item) return;
    if (!anchored) return item.scrollIntoView({ block: 'nearest' });
    const header = options[active]?.group ? list.querySelector<HTMLElement>('li.group')?.offsetHeight ?? 0 : 0;
    if (item.offsetTop < list.scrollTop + header) list.scrollTop = Math.max(0, item.offsetTop - header);
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  }

  /** Esc and a pick put focus back on body so the hotkey dispatcher hears the next key; Tab leaves it on the button instead. */
  function close() {
    open = false;
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function pick(v: string) {
    close();
    onpick(v);
  }

  function focusPin() {
    list?.querySelector<HTMLButtonElement>(`li[data-i="${active}"] [data-pin]`)?.focus({ preventScroll: true });
  }

  function pin(index: number) {
    const option = options[index], menu = list;
    if (!onpin || !option || !menu || (option.pinDisabled && !option.pinned)) return;
    const top = menu.scrollTop;
    const button = menu.querySelector<HTMLButtonElement>(`li[data-i="${index}"] [data-pin]`);
    onpin(option.value);
    void tick().then(() => {
      if (!open || list !== menu) return;
      (button?.isConnected ? button : menu).focus({ preventScroll: true });
      menu.scrollTop = top;
    });
  }

  /** Keys pressed while the list is open never reach the hotkey listener on window. */
  function onkey(e: KeyboardEvent) {
    e.stopPropagation();
    const n = options.length;
    const onPin = onpin && e.target instanceof HTMLElement && e.target.hasAttribute('data-pin');
    if (onPin) active = Number((e.target as HTMLElement).closest('li')!.dataset.i);
    if (onPin && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (!e.repeat) pin(active);
      return;
    }
    if (e.key === 'ArrowDown' && n) { active = (active + 1) % n; if (onpin) list?.focus({ preventScroll: true }); }
    else if (e.key === 'ArrowUp' && n) { active = (active - 1 + n) % n; if (onpin) list?.focus({ preventScroll: true }); }
    else if (e.key === 'Home' && n) { active = 0; list?.focus({ preventScroll: true }); }
    else if (e.key === 'End' && n) { active = n - 1; list?.focus({ preventScroll: true }); }
    else if (onpin && e.key === 'ArrowRight') focusPin();
    else if (onpin && e.key === 'ArrowLeft') list?.focus({ preventScroll: true });
    else if ((e.key === 'Enter' || e.key === ' ') && options[active]) pick(options[active].value);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') (open = false), trigger?.focus();
    else return;
    e.preventDefault();
    void tick().then(reveal);
  }

  function clicked(e: MouseEvent) {
    const i = (e.target as HTMLElement).closest('li')?.dataset.i;
    if (i === undefined) return;
    // Inside a Field's <label> the click would go on to focus the label's input.
    e.preventDefault();
    const option = options[Number(i)];
    if (option) pick(option.value);
  }

  $effect(() => {
    if (!open) return;
    menus.open++;
    return () => void menus.open--;
  });

  $effect(() => {
    if (!open || !anchored || !list) return;
    const viewport = window.visualViewport;
    const observer = new ResizeObserver(place);
    observer.observe(list);
    window.addEventListener('resize', place);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  });

  const outside = (e: Event) => open && !root?.contains(e.target as Node) && close();
</script>

<!-- A user scroll elsewhere closes the list; a scroll event would also fire when focus reveals the list near an edge. -->
<svelte:window onpointerdowncapture={outside} onwheelcapture={outside} ontouchmovecapture={outside} onblur={() => open && close()} />

<div class="menu" class:open bind:this={root}>
  <button type="button" bind:this={trigger} data-testid={testid} aria-haspopup={onpin ? 'menu' : 'listbox'} aria-expanded={open} onclick={() => (open ? close() : show())}>
    {shown}
    <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true"><path d="M.5.5 4.5 4.5 8.5.5" fill="none" stroke="currentColor" /></svg>
  </button>
  {#if open}
    <ul role={onpin ? 'menu' : 'listbox'} tabindex="-1" aria-label={ariaLabel} aria-activedescendant={options[active] ? `${helpId}-option-${active}` : undefined} aria-describedby={[options[active]?.description ? helpId : '', onpin && pinHint ? `${helpId}-pins` : ''].filter(Boolean).join(' ') || undefined} class="ui-menu {align}" class:dropdown={anchored} style:top={anchored ? `${at.top}px` : null} style:left={anchored ? `${at.left}px` : null} style:max-height={anchored ? `${at.maxHeight}px` : null} style:max-width={anchored ? `${at.maxWidth}px` : null} bind:this={list} onkeydown={onkey} onclick={clicked}>
      {#if onpin && pinHint}<li role="presentation" class="pin-hint" id={`${helpId}-pins`}>{pinHint}</li>{/if}
      {#each options as o, i (o.value)}
        {#if o.group && o.group !== options[i - 1]?.group}<li role="presentation" class="group">{o.group}</li>{/if}
        {#if onpin}
          <li role="presentation" class="pin-row" class:active={i === active} data-i={i} onpointermove={(e) => e.pointerType === 'mouse' && (e.movementX || e.movementY) && (active = i)}>
            <button type="button" class="choice" role="menuitemradio" id={`${helpId}-option-${i}`} aria-checked={o.value === value} aria-describedby={i === active && o.description ? helpId : undefined} tabindex="-1" data-testid={o.testid} onfocus={() => active = i}>{o.label}</button>
            <button type="button" class="pin" class:pinned={o.pinned} role="menuitemcheckbox" aria-checked={!!o.pinned} aria-disabled={!!o.pinDisabled && !o.pinned} aria-label={`${o.pinned ? 'Unpin' : 'Pin'} ${o.label}`} tabindex="-1" data-pin data-testid={testid ? `${testid}-pin-${o.value}` : undefined} onfocus={() => active = i} onclick={(e) => { e.preventDefault(); e.stopPropagation(); pin(i); }}><span aria-hidden="true">{o.pinned ? '★' : '☆'}</span></button>
          </li>
        {:else}
          <li role="option" id={`${helpId}-option-${i}`} aria-selected={o.value === value} aria-describedby={i === active && o.description ? helpId : undefined} class:active={i === active} data-i={i} data-testid={o.testid} onpointermove={(e) => e.pointerType === 'mouse' && (e.movementX || e.movementY) && (active = i)}>{o.label}</li>
        {/if}
      {/each}
      {#if options[active]?.description}<li role="presentation" class="help"><div role="tooltip" id={helpId} data-testid={testid ? `${testid}-tooltip` : undefined}><strong>{options[active].label}</strong><span>{options[active].description}</span></div></li>{/if}
    </ul>
  {/if}
</div>

<style>
  .menu { position: relative; display: inline-flex; }
  button { display: inline-flex; align-items: center; gap: 6px; padding: 0; background: none; border: 0; border-radius: 0; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
  svg { color: var(--dim); transition: transform 0.3s; }
  .open svg { transform: rotate(180deg); }
  ul { position: absolute; top: calc(100% - 3px); z-index: 5; margin: 0; padding: 4px 8px; text-align: left; list-style: none; }
  ul.right { right: 0; }
  ul.left { left: 0; }
  li { height: max(24px, calc(var(--fs) * 2)); line-height: max(24px, calc(var(--fs) * 2)); color: var(--dim); white-space: nowrap; cursor: pointer; transition: color 0.2s; }
  li.active { color: var(--bright); }
  li[aria-selected='true'] { color: var(--accent); font-weight: 600; }
  .pin-row { display: flex; align-items: stretch; gap: 8px; }
  .choice { flex: 1; justify-content: flex-start; min-width: 0; min-height: 0; }
  .choice[aria-checked='true'] { color: var(--accent); font-weight: 600; }
  .pin { flex: none; justify-content: center; width: 32px; min-width: 32px; min-height: 0; color: var(--dim); }
  .pin.pinned { color: var(--accent); }
  .pin[aria-disabled='true'] { opacity: 0.45; cursor: not-allowed; }
  li.pin-hint { max-width: 232px; height: auto; padding: 3px 0 6px; font-size: max(8px, calc(var(--fs) * 0.857)); line-height: 1.4; white-space: normal; cursor: default; }
  ul li.group { height: auto; padding: 8px 0 2px; line-height: 1.4; font-size: max(8px, calc(var(--fs) * 0.857)); cursor: default; }
  ul li.group:not(:first-child) { margin-top: 4px; border-top: 1px solid var(--line); }
  li.help { height: auto; line-height: 1.5; white-space: normal; cursor: default; border-top: 1px solid var(--line); margin-top: 4px; padding: 10px 2px 6px; width: min(232px, calc(100vw - 48px)); }
  .help div { display: grid; gap: 4px; font-size: var(--fs); color: var(--text); }
  .help strong { color: var(--accent); }
  /* Fixed, so a scrolling bar such as the chart's intervals cannot clip it. */
  ul.dropdown { position: fixed; top: auto; box-sizing: border-box; max-width: calc(100vw - 16px); z-index: 30; overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; }
  ul.dropdown.right { right: auto; }
  ul.dropdown li.group { position: sticky; top: 0; z-index: 1; background: var(--panel); }
  ul.dropdown:has(.group) { scroll-padding-top: 30px; }
  @media (max-width: 900px), (pointer: coarse) {
    .dropdown li[role='option'], .dropdown li.pin-row { height: 40px; line-height: 40px; }
  }
</style>
