<script lang="ts">
  import { onMount } from 'svelte';
  import { meta, nameOf, symOf } from '$lib/market/meta.svelte';
  import { selectCoin } from '$lib/market/market.svelte';
  import { MAX_QUICK, settings } from '$lib/settings/settings.svelte';
  import { addQuick, moveQuick, removeQuick, topChips } from '$lib/market/views.svelte';
  import { ui } from './state.svelte';
  import Coin from './Coin.svelte';
  import { isTouch } from './touch';

  let q = $state('');
  let left = $state(12);
  let input: HTMLInputElement;
  let dragged = -1;
  onMount(() => {
    const r = document.querySelector('[data-testid="quick-open"]')?.getBoundingClientRect();
    if (r) left = Math.max(12, Math.min(r.left, innerWidth - 332));
    if (!isTouch()) input.focus();
  });

  const bar = $derived(topChips());
  const vol = (c: string) => meta.ctxs.get(c)?.dayNtlVlm ?? 0;
  const found = $derived.by(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return [...meta.assets, ...meta.spot]
      .filter((a) => !a.isDelisted && !bar.includes(a.name) && [a.name, nameOf(a.name)].some((w) => w.toLowerCase().includes(s)))
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

<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<div class="ui-menu quick" role="dialog" aria-label="Quick-switch markets" data-testid="quick-picker" style:--left="{left}px">
  <div class="head">
    <span><span class="stars">★★</span> Quick switch <span class="dim" data-testid="quick-slots">{settings.superstars.length}/{MAX_QUICK}</span></span>
    <button class="x" aria-label="Close" onclick={() => (ui.overlay = null)}>✕</button>
  </div>
  <ol>
    {#each bar as c, i (c)}
      <li data-testid="quick-row" data-coin={c} draggable="true" ondragstart={() => (dragged = i)} ondragover={(e) => e.preventDefault()} ondrop={() => moveQuick(dragged, i)}>
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
  .quick { position: fixed; top: calc(48px + env(safe-area-inset-top)); left: var(--left); width: 320px; max-height: 70vh; overflow: auto; padding: 5px; z-index: 11; }
  .head { display: flex; justify-content: space-between; align-items: center; padding: 4px 4px 6px 8px; }
  .stars { color: var(--warn); }
  ol { list-style: none; margin: 0 0 6px; padding: 0; }
  li { display: flex; align-items: center; gap: 4px; padding: 2px 4px; border-radius: var(--radius); }
  li:hover { background: var(--surface); }
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
    .quick { left: 0; width: 100%; top: env(safe-area-inset-top); border-width: 0 0 1px; border-radius: 0; max-height: calc(92vh - env(safe-area-inset-top)); }
    li button:not(.name) { min-width: 36px; min-height: 36px; }
    .grip { display: none; }
    .scrim { background: #000b; }
  }
</style>
