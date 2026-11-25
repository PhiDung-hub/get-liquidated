<script lang="ts">
  import { onMount } from 'svelte';
  import { meta, nameOf, strictMarket, symOf } from '$lib/market/meta.svelte';
  import { selectCoin } from '$lib/market/market.svelte';
  import { MAX_QUICK, settings } from '$lib/settings/settings.svelte';
  import { addQuick, moveQuick, removeQuick, topChips } from '$lib/market/views.svelte';
  import { ui } from './state.svelte';
  import Coin from './Coin.svelte';
  import { isTouch } from './touch';

  let q = $state('');
  let left = $state(12);
  let edge = $state(48);
  let above = $state(false);
  let input: HTMLInputElement;
  let dragged = $state<string | null>(null);
  let target = $state<{ coin: string; before: boolean } | null>(null);
  function locate() {
    const r = document.querySelector('[data-testid="quick-open"]')?.getBoundingClientRect();
    if (!r) return;
    left = Math.max(12, Math.min(r.left, innerWidth - 332));
    above = r.bottom > innerHeight * 0.65;
    edge = (above ? innerHeight - r.top : r.bottom) + 4;
  }
  onMount(() => {
    locate();
    if (!isTouch()) input.focus();
  });

  const bar = $derived(topChips());
  function start(e: DragEvent, coin: string) {
    dragged = coin;
    target = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', coin);
    }
  }
  function end() {
    dragged = null;
    target = null;
  }
  function over(e: DragEvent, coin: string) {
    if (dragged === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const from = bar.indexOf(dragged);
    const slot = bar.indexOf(coin) + (before ? 0 : 1);
    const to = slot - Number(from < slot);
    if (from < 0 || from === to) target = null;
    else if (target?.coin !== coin || target.before !== before) target = { coin, before };
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    if (dragged !== null && target) {
      const from = bar.indexOf(dragged);
      const anchor = bar.indexOf(target.coin);
      const slot = anchor + (target.before ? 0 : 1);
      if (anchor >= 0) moveQuick(from, slot - Number(from < slot));
    }
    end();
  }
  const vol = (c: string) => meta.ctxs.get(c)?.dayNtlVlm ?? 0;
  const found = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return [...meta.assets, ...meta.spot]
      .filter((a) => strictMarket(a) && !bar.includes(a.name) && [a.name, nameOf(a.name)].some((w) => w.toLowerCase().includes(s)))
      .map((a) => ({ c: a.name, exact: symOf(a.name).toLowerCase() === s ? 1 : 0 }))
      .sort((x, y) => y.exact - x.exact || vol(y.c) - vol(x.c))
      .slice(0, 8)
      .map((r) => r.c);
  });
  function add(coin: string) {
    addQuick(coin);
    q = '';
    input.focus();
  }
  function go(coin: string) {
    selectCoin(coin);
    ui.overlay = null;
  }
</script>

<svelte:window onresize={locate} />
<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<div class="ui-menu quick" class:above role="dialog" aria-label="Quick-switch markets" data-testid="quick-picker" style:--left="{left}px" style:--edge="{edge}px">
  <div class="head">
    <span><span class="stars">★★</span> Quick switch <span class="dim" data-testid="quick-slots">{settings.superstars.length}/{MAX_QUICK}</span></span>
    <button class="x" aria-label="Close" onclick={() => (ui.overlay = null)}>✕</button>
  </div>
  <ol ondragleave={(e) => { if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) target = null; }}>
    {#each bar as c, i (c)}
      <li data-testid="quick-row" data-coin={c} class:drag-source={dragged === c} data-drop={target?.coin === c ? (target.before ? 'before' : 'after') : undefined} draggable="true" ondragstart={(e) => start(e, c)} ondragend={end} ondragover={(e) => over(e, c)} ondrop={drop}>
        <span class="grip dim" aria-hidden="true">⠿</span>
        <button class="name" title="Switch to {nameOf(c)}" onclick={() => go(c)}><Coin coin={c} /></button>
        <button aria-label="Move {nameOf(c)} up" data-testid="quick-up" disabled={i === 0} onclick={() => moveQuick(i, i - 1)}>↑</button>
        <button aria-label="Move {nameOf(c)} down" data-testid="quick-down" disabled={i === bar.length - 1} onclick={() => moveQuick(i, i + 1)}>↓</button>
        <button class="x" aria-label="Remove {nameOf(c)}" data-testid="quick-remove" onclick={() => removeQuick(c)}>✕</button>
      </li>
    {:else}
      <li class="dim">No quick-switch markets yet.</li>
    {/each}
  </ol>
  <input bind:this={input} bind:value={q} onkeydown={(e) => e.key === 'Enter' && found[0] && add(found[0])} placeholder={settings.superstars.length >= MAX_QUICK ? 'Full: remove one to add' : 'Add a market'} aria-label="Add a quick-switch market" data-testid="quick-input" />
  {#each found as c (c)}
    <button class="found" data-testid="quick-found" data-coin={c} onclick={() => add(c)}><Coin coin={c} /><span class="dim">+ add</span></button>
  {/each}
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 10; }
  .quick { position: fixed; top: var(--edge); left: var(--left); width: 320px; max-height: min(70vh, calc(100dvh - var(--edge) - 8px)); overflow: auto; padding: 5px; z-index: 11; }
  .above { top: auto; bottom: var(--edge); }
  .head { display: flex; justify-content: space-between; align-items: center; padding: 4px 4px 6px 8px; }
  .stars { color: var(--warn); }
  ol { list-style: none; margin: 0 0 6px; padding: 0; }
  li { position: relative; display: flex; align-items: center; gap: 4px; padding: 2px 4px; border-radius: var(--radius); }
  li:hover { background: var(--surface); }
  .drag-source { opacity: 0.55; }
  li[data-drop]::after { content: ''; position: absolute; inset-inline: 4px; height: 2px; background: var(--accent); border-radius: var(--radius); pointer-events: none; z-index: 1; }
  li[data-drop='before']::after { top: 0; }
  li[data-drop='after']::after { bottom: 0; }
  .grip { cursor: grab; }
  .name { flex: 1; text-align: left; background: none; color: var(--bright); font-weight: 600; padding: 6px 4px; }
  li button:not(.name) { background: none; color: var(--dim); padding: 4px 7px; }
  li button:not(.name):hover:enabled, .head .x:hover { color: var(--bright); background: var(--bg); }
  li button:disabled { opacity: 0.3; }
  li .x:hover:enabled { color: var(--sell); }
  .head .x { background: none; color: var(--dim); padding: 2px 7px; }
  input { width: 100%; }
  .found { display: flex; justify-content: space-between; width: 100%; background: none; text-align: left; padding: 7px 8px; color: var(--bright); }
  .found:hover, .found:focus-visible { background: var(--surface); }
  @media (max-width: 900px) {
    .quick { left: 0; width: 100%; top: env(safe-area-inset-top); bottom: auto; border-width: 0 0 1px; border-radius: 0; max-height: calc(92vh - env(safe-area-inset-top)); }
    li button:not(.name) { min-width: 36px; min-height: 36px; }
    .grip { display: none; }
    .scrim { background: #000b; }
  }
</style>
