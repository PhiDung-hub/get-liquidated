<script lang="ts">
  import { onMount } from 'svelte';
  import { loadNotes, meta, nameOf, strictMarket, symOf, watchPickerPrices, type Asset } from '$lib/market/meta.svelte';
  import { market, selectCoin } from '$lib/market/market.svelte';
  import { MAX_COMPARE, settings, persist } from '$lib/settings/settings.svelte';
  import { fmtIn, fmtNum, fmtPct, fmtPx, fmtUsdShort, pxDecimals } from '$lib/util/format';
  import { ui } from './state.svelte';
  import Coin from './Coin.svelte';
  import { compared, toggleCompare } from './chart/compare.svelte';
  import { isTouch } from './touch';

  /** compare: a pick adds or removes a compared market on the chart and the picker stays open. */
  let { compare = false }: { compare?: boolean } = $props();

  type Tab = 'all' | 'perps' | 'spot' | 'tradfi' | 'hip3';
  const TABS: [Tab, string][] = [['all', 'All'], ['perps', 'Perps'], ['spot', 'Spot'], ['tradfi', 'Tradfi'], ['hip3', 'HIP-3']];
  // perpCategories spells a few categories two ways.
  const TRADFI: [string, string, string[]][] = [
    ['stocks', 'Stocks', ['stocks', 'stock']], ['indices', 'Indices', ['indices']], ['commodities', 'Commodities', ['commodities']],
    ['fx', 'FX', ['fx']], ['preipo', 'Pre-IPO', ['preipo']]
  ];

  let q = $state('');
  let tab = $state<Tab>('all');
  let sub = $state('');
  let starredOnly = $state(false);
  let pickerTop = $state<string>();
  let input: HTMLInputElement;
  let rows: HTMLDivElement;
  onMount(() => {
    if (!compare && !document.querySelector('[data-testid="chart"].fullscreen')) {
      const trigger = document.querySelector('[data-testid="market-summary"] [data-testid="market-button"]');
      const bounds = trigger?.getBoundingClientRect();
      if (bounds?.height) pickerTop = `${bounds.bottom + 8}px`;
    }
    if (!isTouch()) input.focus();
    void loadNotes();
    return watchPickerPrices();
  });

  const quotes = $derived([...new Set(meta.spot.filter(strictMarket).map((a) => a.collateral))]);
  const subs = $derived<[string, string][]>(
    tab === 'tradfi' ? TRADFI.map(([k, label]) => [k, label])
    : tab === 'hip3' ? [['', 'All'], ...meta.dexes.map((d): [string, string] => [d.name, d.name])]
    : tab === 'spot' ? [['', 'All'], ...quotes.map((q): [string, string] => [q, q])]
    : []
  );
  function pickTab(t: Tab) {
    tab = t;
    sub = t === 'tradfi' ? 'stocks' : '';
    if (!isTouch()) input.focus();
  }
  function pickSub(s: string) {
    sub = s;
    if (!isTouch()) input.focus();
  }

  const metrics = [['change', '24h change'], ['volume', 'Volume'], ['oi', 'Open interest']] as const;
  type Metric = typeof metrics[number][0];
  let sort = $state<Metric | null>(null);
  let descending = $state(true);
  function sortBy(metric: Metric) {
    descending = sort === metric ? !descending : true;
    sort = metric;
    rows.scrollTop = 0;
  }
  function metricValue(a: Asset, metric: Metric) {
    const c = meta.ctxs.get(a.name);
    if (!c) return null;
    if (metric === 'volume') return c.dayNtlVlm;
    if (metric === 'oi') return c.openInterest === null ? null : c.openInterest * c.markPx;
    return c.prevDayPx > 0 ? (c.markPx - c.prevDayPx) / c.prevDayPx : null;
  }
  const fav = (c: string) => Number(settings.favourites.includes(c));
  const vol = (c: string) => meta.ctxs.get(c)?.dayNtlVlm ?? 0;
  const volText = (a: Asset) => (a.spot && a.collateral !== 'USDC' ? fmtIn(vol(a.name), a.collateral) : fmtUsdShort(vol(a.name)));
  // Spot has no open interest.
  const oiText = (a: Asset) => {
    const c = meta.ctxs.get(a.name);
    return c?.openInterest != null ? fmtUsdShort(c.openInterest * c.markPx) : '—';
  };
  const changeText = (a: Asset) => {
    const c = meta.ctxs.get(a.name);
    if (!c) return '—';
    const diff = c.markPx - c.prevDayPx;
    return `${diff >= 0 ? '+' : '-'}${fmtNum(Math.abs(diff), pxDecimals(c.markPx, a.szDecimals, a.spot))} / ${fmtPct(diff / c.prevDayPx)}`;
  };
  const inTab = (a: Asset) => {
    if (tab === 'perps') return !a.spot;
    if (tab === 'hip3') return a.dex !== '' && (!sub || a.dex === sub);
    if (tab === 'spot') return !sub || a.collateral === sub;
    if (tab === 'tradfi') return !!TRADFI.find(([k]) => k === sub)?.[2].includes(meta.notes.get(a.name)?.category ?? '');
    return true;
  };
  const words = (a: Asset) => {
    const n = meta.notes.get(a.name);
    return [a.name, n?.displayName ?? '', ...(n?.keywords ?? []), ...(a.spot ? [a.base, a.fullName ?? '', nameOf(a.name)] : [])].map((w) => w.toLowerCase());
  };
  const list = $derived.by(() => {
    const s = q.trim().toLowerCase();
    // Spot pairs join All ranked by volume, as on HL; the perp tabs keep to perps.
    const pool = tab === 'spot' ? meta.spot : tab === 'all' ? [...meta.assets, ...meta.spot] : meta.assets;
    return pool
      .filter((a) => strictMarket(a) && (compare || !starredOnly || fav(a.name) > 0) && inTab(a) && !(compare && a.name === market.coin))
      .map((a) => ({ a, w: words(a) }))
      .filter((r) => !s || r.w.some((w) => w.includes(s)))
      .map(({ a, w }) => ({ a, value: sort ? metricValue(a, sort) : null, exact: s && (symOf(a.name).toLowerCase() === s || w.includes(s)) ? 1 : 0 }))
      .sort((x, y) => {
        if (!sort) return fav(y.a.name) - fav(x.a.name) || y.exact - x.exact || vol(y.a.name) - vol(x.a.name);
        if (x.value === null || y.value === null) return Number(x.value === null) - Number(y.value === null);
        return descending ? y.value - x.value : x.value - y.value;
      })
      .map((r) => r.a);
  });
  // Rows render 60 first, then 80 a frame, so opening, a tab or a keystroke paints at once; a new filter starts over.
  let limit = $derived.by(() => (void [q, tab, sub, starredOnly], 60));
  $effect(() => {
    if (limit >= list.length) return;
    const f = requestAnimationFrame(() => (limit += 80));
    return () => cancelAnimationFrame(f);
  });
  let highlightedCoin = $derived.by(() => (void [q, tab, sub, starredOnly, sort, descending], ''));
  const hi = $derived(Math.max(0, list.findIndex((a) => a.name === highlightedCoin)));

  function choose(coin: string) {
    if (compare) return void (toggleCompare(coin), !isTouch() && input.focus());
    selectCoin(coin);
    ui.overlay = null;
  }
  function toggleFav(coin: string) {
    settings.favourites = settings.favourites.includes(coin) ? settings.favourites.filter((c) => c !== coin) : [...settings.favourites, coin];
    persist();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(list.length - 1, hi + (e.key === 'ArrowDown' ? 1 : -1)));
      highlightedCoin = list[next]?.name ?? '';
      rows.querySelectorAll('tbody tr')[next]?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && list[hi] && !(compare && compared().includes(list[hi].name))) choose(list[hi].name);
    if (e.key !== 'Escape') return;
    // Closing here and letting Esc reach the hotkeys would also exit zen.
    e.stopPropagation();
    ui.overlay = null;
  }
</script>

<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<div class="picker" role="dialog" aria-label={compare ? `Compare with ${market.coin}` : 'Markets'} data-mode={compare ? 'compare' : 'select'} style:--picker-top={pickerTop}>
  {#if compare}
    <div class="cmp" data-testid="compare-list">
      <span class="dim">Compare {market.coin} with ({compared().length}/{MAX_COMPARE})</span>
      {#each compared() as c (c)}
        <button class="chip" data-testid="compare-chip" data-coin={c} title="Remove {nameOf(c)}" onclick={() => toggleCompare(c)}>{nameOf(c)} ×</button>
      {/each}
    </div>
  {/if}
  <div class="search">
    <input bind:this={input} bind:value={q} onkeydown={onKey} placeholder={compare ? 'Add a market to compare' : 'Search markets'} data-testid="picker-input" />
    <button class="x" aria-label="Close" data-testid="picker-close" onclick={() => (ui.overlay = null)}>✕</button>
  </div>
  <nav class="tabs" aria-label="Market groups">
    {#each TABS as [id, label] (id)}
      <button class="ui-tab" class:on={tab === id} aria-pressed={tab === id} data-testid="picker-tab-{id}" onclick={() => pickTab(id)}>{label}</button>
    {/each}
    {#if !compare}
    <button class="ui-tab star-filter" class:on={starredOnly} aria-label="Starred markets" aria-pressed={starredOnly} onclick={() => starredOnly = !starredOnly}>★</button>
    {/if}
  </nav>
  {#if subs.length}
    <nav class="tabs subs" aria-label="{tab === 'hip3' ? 'Dexes' : tab === 'spot' ? 'Quotes' : 'Categories'}">
      {#each subs as [id, label] (id)}
        <button class="ui-tab" class:on={sub === id} aria-pressed={sub === id} data-testid="picker-sub-{id || 'all'}" onclick={() => pickSub(id)}>{label}</button>
      {/each}
    </nav>
  {/if}
  {#if tab === 'hip3' && meta.hip3 !== 'on'}
    <p class="dim" data-testid="picker-hip3-state">{meta.hip3 === 'loading' ? 'Loading HIP-3 markets…' : 'HIP-3 markets are off.'}</p>
  {/if}
  {#if tab === 'spot' && meta.spotState !== 'on'}
    <p class="dim" data-testid="picker-spot-state">{meta.spotState === 'loading' ? 'Loading spot markets…' : 'Spot markets are off.'}</p>
  {/if}
  {#snippet sortButton(key: Metric, label: string)}
    <button class="ui-tab" class:on={sort === key} aria-label={`Sort by ${label}, ${sort === key && descending ? 'ascending' : 'descending'}`} onclick={() => sortBy(key)}>{label}{sort === key ? descending ? ' ↓' : ' ↑' : ''}</button>
  {/snippet}
  <nav class="mobile-sort" aria-label="Sort markets">
    {#each metrics as [key, label]}{@render sortButton(key, label)}{/each}
  </nav>
  <div class="rows" bind:this={rows}>
  <table>
    <thead><tr>{#if !compare}<th></th>{/if}<th>Market</th><th class="num">Price</th>{#each metrics as [key, label]}<th class="num wide" aria-sort={sort === key ? descending ? 'descending' : 'ascending' : undefined}>{@render sortButton(key, label)}</th>{/each}</tr></thead>
    <tbody>
      {#each list.slice(0, limit) as a, i (a.name)}
        {@const c = meta.ctxs.get(a.name)}
        {@const on = settings.favourites.includes(a.name)}
        <tr data-testid="picker-row" data-coin={a.name} class:picked={compare && compared().includes(a.name)} class:hi={i === hi} onclick={() => choose(a.name)}>
          {#if !compare}<td class="stars">
            <button class="star" class:on aria-pressed={on} aria-label="Favourite {a.name}" title="Favourite" onclick={(e) => (e.stopPropagation(), toggleFav(a.name))}>★</button>
          </td>{/if}
          <!-- A phone shows each row on two lines: volume and OI under the market, the 24h change under the price. -->
          <td><Coin coin={a.name} quote={a.collateral} lev={a.maxLeverage} /><span class="line2 dim" data-testid="picker-vol-oi">Vol {volText(a)}{a.spot ? '' : ` · OI ${oiText(a)}`}</span></td>
          <td class="num"><span data-testid="picker-px">{c ? fmtPx(c.markPx, a.szDecimals, a.spot) : '—'}</span><span class="line2" class:buy={c && c.markPx >= c.prevDayPx} class:sell={c && c.markPx < c.prevDayPx}>{changeText(a)}</span></td>
          <td class="num wide" data-testid="picker-change" class:buy={c && c.markPx >= c.prevDayPx} class:sell={c && c.markPx < c.prevDayPx}>{changeText(a)}</td>
          <td class="num wide" data-testid="picker-vol">{volText(a)}</td>
          <td class="num wide" data-testid="picker-oi">{oiText(a)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !list.length && q.trim()}<p class="dim" data-testid="picker-empty">No markets match “{q.trim()}”</p>{/if}
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 10; }
  .picker { position: fixed; top: var(--picker-top, calc(var(--fs) * 4)); left: 12px; width: min(920px, calc(100vw - 24px)); max-height: min(80vh, calc(100dvh - var(--picker-top, var(--fs) * 4) - 8px)); display: flex; flex-direction: column; overflow: hidden; background: var(--panel); border: 1px solid var(--line); z-index: 11; padding: 8px; }
  .picker > * { flex: none; }
  .search { display: flex; gap: 6px; margin-bottom: 6px; }
  .search input { flex: 1; min-width: 0; }
  .x { background: none; color: var(--dim); }
  .x:hover { color: var(--bright); }
  .picker > .rows { flex: 0 1 auto; min-height: 0; overflow: auto; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--panel); }
  tbody tr { scroll-margin-top: 2.2em; }
  .tabs { display: flex; flex-wrap: wrap; gap: 2px; border-bottom: 1px solid var(--gutter); }
  .tabs button { flex: none; padding: 5px 10px; }
  .subs { border-bottom: 0; margin-bottom: 4px; }
  .subs button { font-size: max(8px, calc(var(--fs) * 0.917)); padding: 3px 8px; }
  p { margin: 8px; }
  th.num, td.num { text-align: right; }
  tr { cursor: pointer; }
  tr:hover td, tr.hi td { background: var(--surface); }
  .star { display: block; background: none; padding: 0 4px; color: var(--faint); line-height: 1.2; }
  .stars { width: 1px; text-align: center; }
  th, td { padding: 4px 8px; white-space: nowrap; }
  .mobile-sort { display: none; }
  .line2 { display: none; font-size: max(8px, calc(var(--fs) * 0.857)); }
  .star.on { color: var(--warn); }
  .tabs .star-filter { margin-left: auto; }
  .cmp { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 6px; }
  .cmp .chip { padding: 2px 6px; }
  tr.picked td { background: var(--surface); color: var(--bright); }
  @media (max-width: 900px) {
    .picker { top: env(safe-area-inset-top); left: 0; width: 100%; max-height: calc(92vh - env(safe-area-inset-top)); border-width: 0 0 1px; }
    .mobile-sort { display: flex; gap: 4px; }
    .mobile-sort button { padding: 5px 8px; }
    .wide { display: none; }
    .line2 { display: block; }
    th, td { padding: 4px; }
    td { white-space: normal; }
  }
</style>
