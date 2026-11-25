<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { entryPxOf, entrySizeOf, fills, netPnl, type Fill } from '$lib/account/fills.svelte';
  import { fillProgress } from '$lib/account/orders.svelte';
  import { entryOf } from '$lib/exchange/ledger.svelte';
  import { isSpot, meta, quoteOf } from '$lib/market/meta.svelte';
  import { fmtNum, fmtPx, fmtSz, fmtTime, fmtUsd, fmtWhen } from '$lib/util/format';
  import { settings } from '$lib/settings/settings.svelte';
  import Coin from './Coin.svelte';
  import Pepe from './Pepe.svelte';
  import { play } from './Fx.svelte';
  import SortHead from './SortHead.svelte';
  import { cardFold, cards, inFilter, Sorter } from './tables.svelte';

  const dec = (coin: string) => meta.byName.get(coin)?.szDecimals;
  // As Hyperliquid: a liquidated fill shows the mark price that triggered it, with the execution price in its tip.
  const shownPx = (f: Fill) => (f.liquidation && f.liqMarkPx !== null ? f.liqMarkPx : f.px);
  const px = (f: Fill, p: number) => fmtPx(p, dec(f.coin), isSpot(f.coin));
  const liqNote = (f: Fill) => f.backstop
    ? `This was a backstop liquidation that triggered when the mark price hit ${px(f, f.liqMarkPx!)} and was unable to be liquidated against the book. This position was taken over by the protocol at a clearance price of ${px(f, f.px)}.`
    : `The liquidation was sent to the book when the mark price reached ${px(f, f.liqMarkPx!)}. The order executed at ${px(f, f.px)}.`;
  const IMPROVED = "This fill price was more favorable to you than the price chart at that time, because your order provided liquidity to another user's liquidation.";
  const liqLabel = (f: Fill) => f.dir.startsWith('Liquidated ') ? ['Backstop Liquidation', f.dir.slice(11)] : f.liquidation ? ['Market Order Liquidation', f.dir] : null;
  const sorter = new Sorter<Fill>([
    { key: 'time', label: 'Time (UTC)', value: (f) => f.time },
    { key: 'coin', label: 'Coin', value: (f) => f.coin },
    { key: 'dir', label: 'Direction', value: (f) => f.dir },
    { key: 'price', label: 'Price', value: shownPx },
    { key: 'entry', label: 'Entry', value: (f) => { const px = entryPxOf(f, isSpot(f.coin)); return Number.isFinite(px) ? px : null; }, title: 'Average entry of the size this fill closed' },
    { key: 'size', label: 'Size', value: (f) => f.sz },
    { key: 'value', label: 'Value', value: (f) => shownPx(f) * f.sz },
    { key: 'fee', label: 'Fee', value: (f) => f.fee },
    { key: 'pnl', label: 'PnL (net of fee)', value: (f) => netPnl(f), title: 'net of USDC fees; fees in other tokens are shown in Fee only' }
  ], 'time', (a, b) => b.time - a.time);
  // Phone cards are always newest first, as Hyperliquid's; the desktop table sorts by its headers.
  const rows = $derived.by(() => {
    const shown = fills.list.filter((f) => inFilter(f.coin, f.side === 'B'));
    return (cards.current ? sorter.sort(shown, 'time', true) : sorter.sort(shown)).slice(0, 500);
  });
  const net = $derived(rows.reduce((s, f) => s + netPnl(f), 0));

  const keyOf = (f: Fill) => `${f.coin}:${f.tid}:${f.oid}`;
  const expanded = new SvelteSet<string>();
  const toggle = (k: string) => (expanded.has(k) ? expanded.delete(k) : expanded.add(k));
  const allOpen = $derived(rows.every((f) => expanded.has(keyOf(f))));
  const toggleAll = () => (allOpen ? expanded.clear() : rows.forEach((f) => expanded.add(keyOf(f))));
  $effect(() => {
    cardFold.open = allOpen;
    cardFold.run = cards.current && rows.length > 1 ? toggleAll : null;
    return () => void (cardFold.run = null);
  });

  const CARD_STEP = 50;
  let cardsShown = $state(CARD_STEP);

  const CARD_H = 320;
  let liq = $state<{ f: Fill; x: number; y: number; above: boolean } | null>(null);
  let card = $state<HTMLDivElement>();
  const showLiq = (f: Fill, el: Element) => {
    if (!settings.display.lol) return;
    const r = el.getBoundingClientRect();
    const above = r.top > CARD_H + 8;
    if (liq?.f.tid !== f.tid) play('liquidated');
    liq = { f, x: r.left + r.width / 2, y: above ? r.top - 6 : r.bottom + 6, above };
  };
  const tapLiq = (e: PointerEvent, f: Fill) => {
    const marker = e.pointerType === 'touch' && (e.target as Element).closest('[data-testid=liq-marker]');
    if (!marker || !f.liquidation) return;
    if (liq?.f.tid === f.tid) liq = null;
    else showLiq(f, marker);
  };
  const left = $derived.by(() => {
    if (!liq || !card) return liq?.x ?? 0;
    const w = card.offsetWidth;
    return Math.min(Math.max(8, liq.x - w / 2), innerWidth - w - 8);
  });
  $effect(() => {
    if (!liq) return;
    const hide = () => (liq = null);
    const away = (e: PointerEvent) => !(e.target as Element | null)?.closest?.('[data-testid=liq-marker]') && hide();
    document.addEventListener('pointerdown', away);
    addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      removeEventListener('scroll', hide, true);
    };
  });
</script>

{#if cards.current}
  <div class="bar">
    <abbr class="dim" data-testid="fills-help" title="{fills.seeded ? '~77 days kept by Hyperliquid. ' : ''}TWAP slice fills are not listed. Net of USDC fees.">{fills.seeded ? `${fills.list.length} fills` : 'loading history…'}</abbr>
    <span class="num" class:buy={net >= 0} class:sell={net < 0}>{fmtUsd(net)}</span>
  </div>
{:else}
  <div class="bar">
    <span class="dim">{fills.seeded ? `${fills.list.length} fills · ~77 days kept by Hyperliquid` : 'loading history…'}</span>
    <span class="num" class:buy={net >= 0} class:sell={net < 0}>shown: {fmtUsd(net)} net of fee</span>
    <span class="dim">TWAP slice fills are not listed.</span>
  </div>
{/if}
{#snippet dir(f: Fill, partial = false)}{@const label = liqLabel(f)}{#if label}<span class="liq" class:hover={settings.display.lol && f.liquidation} data-testid="liq-marker">{label[0]}</span>: {label[1]}{:else}{f.dir}{#if f.priceImproved}{' '}<abbr data-testid="price-improved" title={IMPROVED}>(Price Improved)</abbr>{/if}{/if}{#if partial}{' · '}<span class="partial">Partial fill</span>{/if}{/snippet}
{#snippet price(f: Fill)}{#if f.liquidation && f.liqMarkPx !== null}<abbr data-testid="liq-price" data-help-numbers title={liqNote(f)}>{px(f, shownPx(f))}</abbr>{:else}{px(f, f.px)}{/if}{/snippet}
{#snippet value(f: Fill)}{isSpot(f.coin) ? `${fmtNum(shownPx(f) * f.sz, 2)} ${quoteOf(f.coin)}` : fmtUsd(shownPx(f) * f.sz)}{/snippet}
{#snippet entry(f: Fill)}{@const px = entryPxOf(f, isSpot(f.coin))}{Number.isFinite(px) ? fmtPx(px, dec(f.coin)) : '—'}{/snippet}
{#snippet fee(f: Fill)}{f.feeToken === 'USDC' ? fmtNum(f.fee, 4) : fmtSz(f.fee)} {f.feeToken}{/snippet}

{#if !rows.length}
  <p class="dim" data-testid="account-empty">{fills.seeded ? 'No fills.' : 'Loading fills…'}</p>
{:else if cards.current}
  <div class="cards">
    {#each rows.slice(0, cardsShown) as f (keyOf(f))}
      {@const k = keyOf(f)}
      {@const open = expanded.has(k)}
      {@const progress = entrySizeOf(f) > 0 ? fillProgress(f) : null}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="card fill" class:open data-testid="fill-row" onclick={(e) => !(e.target as Element).closest(settings.display.lol ? 'button, abbr, [data-testid=liq-marker]' : 'button, abbr') && toggle(k)} onpointerenter={(e) => f.liquidation && e.pointerType !== 'touch' && showLiq(f, e.currentTarget)} onpointerleave={(e) => e.pointerType !== 'touch' && liq?.f.tid === f.tid && (liq = null)} onpointerup={(e) => tapLiq(e, f)}>
        <div class="head">
          <span class="fill-identity"><Coin coin={f.coin} /> <b class:buy={f.side === 'B'} class:sell={f.side === 'A'}>{@render dir(f)}</b></span>
          <span class="net">
            <span class="num" title="Closed PnL, net of USDC fees" data-testid="fill-pnl" class:buy={netPnl(f) >= 0} class:sell={netPnl(f) < 0}>{fmtUsd(netPnl(f))}</span>
            <button class="chevron" data-testid="fill-expand" aria-expanded={open} aria-label="{open ? 'Hide' : 'Show'} fill details" onclick={() => toggle(k)}>{open ? '▴' : '▾'}</button>
          </span>
        </div>
        <div class="sub">
          <span><span class="num" data-testid="fill-size">{fmtSz(f.sz, dec(f.coin))}</span> @ <span class="num" data-testid="fill-price">{@render price(f)}</span></span>
          <span class="num dim" title="{fmtTime(f.time)} UTC">{fmtWhen(f.time)}</span>
        </div>
        {#if progress?.partial}<div class="fill-progress" data-testid="fill-progress"><span class="partial">Partial fill</span><span class="num">{fmtSz(progress.filled, dec(f.coin))} / {fmtSz(progress.total, dec(f.coin))}</span></div>{/if}
        {#if open}
          <dl class="fill-details" data-testid="fill-details">
            <div><dt>Time (UTC)</dt><dd class="num">{fmtTime(f.time)}</dd></div>
            <div><dt>Entry</dt><dd class="num" data-testid="fill-entry">{@render entry(f)}</dd></div>
            <div><dt>Trade value</dt><dd class="num quote">{@render value(f)}</dd></div>
            <div><dt>Fee</dt><dd class="num">{@render fee(f)}</dd></div>
            <div><dt>Role</dt><dd>{f.crossed ? 'taker' : 'maker'}</dd></div>
            {#if progress?.partial}<div><dt>{progress.working ? 'Remaining' : 'Unfilled'}</dt><dd class="num" data-testid="fill-remaining">{fmtSz(progress.remaining, dec(f.coin))}</dd></div>{/if}
          </dl>
        {/if}
      </div>
    {/each}
    {#if rows.length > cardsShown}<button class="more" data-testid="fills-more" onclick={() => (cardsShown += CARD_STEP)}>Show more</button>{/if}
  </div>
{:else}
  <table class="fills-table">
    <colgroup>
      <col style:width="11%" />
      <col style:width="8%" />
      <col style:width="20%" />
      <col style:width="8%" />
      <col style:width="8%" />
      <col style:width="9%" />
      <col style:width="8%" />
      <col style:width="9%" />
      <col style:width="10%" />
      <col style:width="5%" />
      <col style:width="4%" />
    </colgroup>
    <thead><tr><SortHead {sorter} /><th>Type</th><th>Role</th></tr></thead>
    <tbody>
      {#each rows as f (`${f.coin}:${f.tid}:${f.oid}`)}
        <tr data-testid="fill-row" onpointerenter={(e) => f.liquidation && e.pointerType !== 'touch' && showLiq(f, e.currentTarget)} onpointerleave={(e) => e.pointerType !== 'touch' && liq?.f.tid === f.tid && (liq = null)} onpointerup={(e) => tapLiq(e, f)}>
          <td class="num dim">{fmtTime(f.time)}</td>
          <td class="fill-coin"><Coin coin={f.coin} /></td>
          <td class="direction" class:buy={f.side === 'B'} class:sell={f.side === 'A'}>{@render dir(f, entrySizeOf(f) > 0 && !!fillProgress(f)?.partial)}</td>
          <td class="num" data-testid="fill-price">{@render price(f)}</td>
          <td class="num dim" data-testid="fill-entry">{@render entry(f)}</td>
          <td class="num">{fmtSz(f.sz, dec(f.coin))}</td>
          <td class="num quote">{@render value(f)}</td>
          <td class="num dim quote">{@render fee(f)}</td>
          <td class="num" class:buy={netPnl(f) >= 0} class:sell={netPnl(f) < 0}>{fmtUsd(netPnl(f))}</td>
          <td class="dim fill-type">{entryOf(f.cloid ?? '')?.kind ?? '—'}</td>
          <td class="dim">{f.crossed ? 'taker' : 'maker'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
{#if liq}
  {@const f = liq.f}
  <div bind:this={card} class="liq-card" class:above={liq.above} role="tooltip" data-testid="liq-card" style:left="{left}px" style:top="{liq.y}px">
    <Pepe kind="liq" />
    <b class="sell">LIQUIDATED</b>
    <span class="loss"><Coin coin={f.coin} /> <b class="num" data-testid="liq-card-pnl">{fmtUsd(netPnl(f))}</b></span>
  </div>
{/if}

<style>
  .fills-table { table-layout: fixed; min-width: 100em; }
  .fill-coin, .direction, .fill-type, .quote { white-space: normal; }
  .fill-coin, .direction, .fill-type { overflow-wrap: anywhere; }
  .bar { display: flex; gap: 14px; align-items: center; padding: 6px 8px; font-size: max(8px, calc(var(--fs) * 0.917)); flex-wrap: wrap; }
  p { padding: 12px; }
  .bar:has(abbr) { justify-content: space-between; }
  .more { align-self: center; padding: 4px 10px; background: none; color: var(--dim); }
  .fill { gap: 2px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .fill .head { flex-wrap: wrap; align-items: center; gap: 4px 12px; }
  .fill-identity { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
  .net { display: flex; flex: none; align-items: baseline; gap: 6px; margin-left: auto; }
  .sub { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 2px 8px; color: var(--bright); font-size: max(10px, calc(var(--fs) * 0.857)); }
  .fill-details dt { color: var(--dim); font-size: max(10px, calc(var(--fs) * 0.857)); font-weight: 400; }
  .fill-details dd { color: var(--bright); font-weight: 500; }
  .fill-progress { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; padding: 4px 0; color: var(--bright); font-size: max(10px, calc(var(--fs) * 0.857)); }
  .partial { color: var(--warn); }
  .fill-details { display: grid; gap: 10px; margin: 4px 0 2px; padding-top: 10px; border-top: 1px solid var(--line); }
  .fill-details > div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); align-items: baseline; gap: 16px; }
  .fill-details dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  .fill .chevron { min-width: 0; min-height: 0; padding: 0; background: none; color: var(--dim); }
  .liq { color: var(--sell-text); font-weight: 600; }
  .liq.hover { cursor: pointer; text-decoration: underline dashed; text-underline-offset: 3px; }
  .liq-card {
    position: fixed; z-index: 50; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 10px; max-width: calc(100vw - 16px);
    background: var(--panel); color: var(--text); border: 1px solid color-mix(in srgb, var(--sell) 55%, var(--line)); border-radius: var(--radius); box-shadow: 0 6px 20px color-mix(in srgb, #000 40%, transparent);
    font-size: max(8px, calc(var(--fs) * 0.95)); text-align: center; pointer-events: none;
  }
  .liq-card.above { transform: translateY(-100%); }
  .liq-card > b { margin-top: 4px; letter-spacing: 0.12em; }
  .loss { display: flex; align-items: baseline; gap: 10px; color: var(--bright); font-weight: 600; font-size: calc(var(--fs) * 1.2); }
  .loss b { color: var(--sell); font: 700 36px/1.1 var(--mono); text-shadow: 0 0 14px color-mix(in srgb, var(--sell) 55%, #5a0010); }
  :global(:root[data-theme='paper']) .loss b { text-shadow: none; }
</style>
