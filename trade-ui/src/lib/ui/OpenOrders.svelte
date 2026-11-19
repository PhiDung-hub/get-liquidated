<script module lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  /** Phone cards opened by a tap, kept across tab switches. */
  const expanded = new SvelteSet<string | number>();
</script>

<script lang="ts">
  import { isTrailing, openOrders, type OpenOrder } from '$lib/account/orders.svelte';
  import { orderMargin, type OrderMargin } from '$lib/account/orderMargin.svelte';
  import { cancelOpenOrder, chases, stopChase } from '$lib/orders/chase.svelte';
  import { session, viewAddress } from '$lib/session/session.svelte';
  import { isSpot, meta, nameOf } from '$lib/market/meta.svelte';
  import { fmtIn, fmtNum, fmtPx, fmtSz, fmtTime, fmtUsd, fmtWhen } from '$lib/util/format';
  import { market } from '$lib/market/market.svelte';
  import { toast } from './toast.svelte';
  import Coin from './Coin.svelte';
  import SortHead from './SortHead.svelte';
  import { cardFold, cardSort, cards, inFilter, Sorter, sweepOf } from './tables.svelte';
  import { editable, editOrder } from './order/EditOrderModal.svelte';

  const dec = (coin: string) => meta.byName.get(coin)?.szDecimals;
  const px = (coin: string, p: number) => fmtPx(p, dec(coin), isSpot(coin));
  const canTrade = $derived(!!session.agent && session.holdsSigner);
  const priceOf = (o: OpenOrder) => (isTrailing(o) || (o.isTrigger && o.orderType.includes('Market')) ? 'Market' : px(o.coin, o.limitPx));
  // A market trigger's limitPx is only Hyperliquid's slippage bound; it fills near the trigger.
  const valueOf = (o: OpenOrder) => (isTrailing(o) ? null : (o.isTrigger && o.orderType.includes('Market') ? o.triggerPx : o.limitPx) * o.sz);
  const valueText = (o: OpenOrder, whole = false) => { const v = valueOf(o); return v === null ? 'Market' : whole ? `$${fmtNum(v, 0)}` : fmtUsd(v); };
  const typeOf = (o: OpenOrder) => (isTrailing(o) ? 'Trailing Stop' : `${o.orderType}${o.tif ? ` ${o.tif}` : ''}`);
  // A position TP/SL closes the whole position: HL sends it with size 0.
  const whole = (o: OpenOrder) => o.isTrigger && !o.sz;
  const dirOf = (o: OpenOrder) => isSpot(o.coin) ? (o.side === 'B' ? 'Buy' : 'Sell') : o.reduceOnly ? (o.side === 'A' ? 'Close Long' : 'Close Short') : o.side === 'B' ? 'Long' : 'Short';
  const cardType = (o: OpenOrder) => (isTrailing(o) ? 'Trailing Stop' : `${o.orderType}${o.tif && !o.isTrigger && o.tif !== 'Gtc' ? ` ${o.tif}` : ''}`);
  const sizeText = (o: OpenOrder) => (whole(o) ? 'Whole position' : `${fmtSz(o.sz, dec(o.coin))}${o.sz !== o.origSz ? ` / ${fmtSz(o.origSz, dec(o.coin))}` : ''}`);
  const triggerOf = (o: OpenOrder) => (isTrailing(o) ? o.triggerCondition || '—' : o.isTrigger ? px(o.coin, o.triggerPx) : '—');
  const marginText = (margin: OrderMargin) => margin.value !== null ? `${margin.kind === 'estimate' ? '≈ ' : ''}${fmtIn(margin.value, margin.quote)}` : margin.kind === 'spot' ? 'N/A' : margin.kind === 'conditional' ? 'Not reserved' : '—';
  let cardWidth = $state(0);
  const fullDetails = $derived(cardWidth >= 600);
  const sorter = new Sorter<OpenOrder>([
    { key: 'time', label: 'Time (UTC)', value: (o) => o.timestamp },
    { key: 'coin', label: 'Coin', value: (o) => nameOf(o.coin) },
    { key: 'type', label: 'Type', value: typeOf },
    { key: 'side', label: 'Side', value: (o) => o.side === 'B' ? 'Buy' : 'Sell' },
    { key: 'price', label: 'Price', value: (o) => o.limitPx },
    { key: 'size', label: 'Size', value: (o) => o.sz },
    { key: 'value', label: 'Value', value: valueOf },
    { key: 'margin', label: 'Margin', value: (o) => orderMargin(o).value, title: 'Estimated initial margin, not an exact per-order collateral allocation.' },
    { key: 'trigger', label: 'Trigger', value: (o) => o.isTrigger && !isTrailing(o) ? o.triggerPx : null },
    { key: 'reduce', label: 'Reduce', value: (o) => Number(o.reduceOnly) }
  ], 'time', (a, b) => b.timestamp - a.timestamp || a.oid - b.oid);
  const matches = (o: { coin: string; isBuy?: boolean; side?: string }) => inFilter(o.coin, o.isBuy ?? (o.side === undefined ? undefined : o.side === 'B'));
  const rows = $derived(openOrders.list.filter(matches));
  // Phone cards sort as Hyperliquid's: the chart coin's orders first, then value high to low, coin A–Z or newest first.
  const list = $derived.by(() => {
    if (!cards.current) return sorter.sort(rows);
    const sorted = sorter.sort(rows, cardSort.orders, cardSort.orders !== 'coin');
    return [...sorted.filter((o) => o.coin === market.coin), ...sorted.filter((o) => o.coin !== market.coin)];
  });
  // A modify rests the order under a new oid and keeps its cloid.
  const foldKey = (o: OpenOrder) => o.cloid ?? o.oid;
  const toggle = (o: OpenOrder) => (expanded.has(foldKey(o)) ? expanded.delete(foldKey(o)) : expanded.add(foldKey(o)));
  const allOpen = $derived(list.every((o) => expanded.has(foldKey(o))));
  const toggleAll = () => (allOpen ? expanded.clear() : list.forEach((o) => expanded.add(foldKey(o))));
  $effect(() => {
    cardFold.open = fullDetails || allOpen;
    cardFold.run = cards.current && !fullDetails && list.length > 1 ? toggleAll : null;
    return () => void (cardFold.run = null);
  });
  const chaseList = $derived(chases.list.filter(matches).reverse());
  const act = (f: () => Promise<unknown>) => (e: MouseEvent) => {
    (e.currentTarget as HTMLElement).blur();
    f().catch((err) => toast.error(err?.message || 'failed'));
  };
  // A second press while the first cancel is in flight would sign a duplicate.
  const cancelling = new SvelteSet<number>();
  const cancel = (o: (typeof list)[number]) => act(() => (cancelling.add(o.oid), cancelOpenOrder(o).finally(() => cancelling.delete(o.oid))));
</script>

{#if chaseList.length && cards.current}
  <div class="cards trading-rows">
    {#each chaseList as c (c.id)}
      <div class="card" data-testid="chase-row">
        <div class="head"><span><Coin coin={c.coin} /> <b class:buy={c.isBuy} class:sell={!c.isBuy}>{c.isBuy ? 'Buy' : 'Sell'}</b> <span class="dim">Chase</span></span></div>
        <div class="grid">
          <div class="field"><span class="label">Price</span><span class="value num">{px(c.coin, c.px)}</span></div>
          <div class="field"><span class="label">Cap</span><span class="value num">{px(c.coin, c.cap)}</span></div>
          <div class="field"><span class="label">Filled</span><span class="value num">{fmtSz(c.filled, dec(c.coin))} / {fmtSz(c.sz, dec(c.coin))}</span></div>
        </div>
        <div class:warn={c.state === 'chasing'}>{c.state}{c.reason ? `: ${c.reason}` : ''}</div>
        {#if canTrade && c.state === 'chasing'}<div class="actions"><button class="cancel" onclick={act(() => stopChase(c.id, 'cancelled'))}>Stop</button></div>{/if}
      </div>
    {/each}
  </div>
{:else if chaseList.length}
  <table>
    <thead><tr><th>Chase</th><th>Side</th><th>Price</th><th>Cap</th><th>Filled</th><th>State</th><th></th></tr></thead>
    <tbody>
      {#each chaseList as c (c.id)}
        <tr data-testid="chase-row">
          <td><Coin coin={c.coin} /></td>
          <td class:buy={c.isBuy} class:sell={!c.isBuy}>{c.isBuy ? 'Buy' : 'Sell'}</td>
          <td class="num">{px(c.coin, c.px)}</td>
          <td class="num">{px(c.coin, c.cap)}</td>
          <td class="num">{fmtSz(c.filled, dec(c.coin))} / {fmtSz(c.sz, dec(c.coin))}</td>
          <td class:warn={c.state === 'chasing'}>{c.state}{c.reason ? `: ${c.reason}` : ''}</td>
          <td>{#if canTrade && c.state === 'chasing'}<button onclick={act(() => stopChase(c.id, 'cancelled'))}>Stop</button>{/if}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#snippet cancelAll()}<button class="sweep" data-testid="cancel-all-open" onclick={(e) => sweepOf(e, 'cancel', true)}>Cancel All</button>{/snippet}
{#snippet actions(o: OpenOrder)}{#if editable(o)}<button class="edit" data-testid="order-edit" onclick={(e) => (e.currentTarget.blur(), editOrder(o))}>Edit</button>{/if}<button class="cancel" disabled={cancelling.has(o.oid)} onclick={cancel(o)}>Cancel</button>{/snippet}

{#if !list.length}
  <p class="dim" data-testid="account-empty">{viewAddress() && !openOrders.loaded ? 'Loading orders…' : openOrders.list.length ? 'No open orders match the filter.' : 'No open orders.'}</p>
{:else if cards.current}
  <div class="cards trading-rows" bind:clientWidth={cardWidth}>
    {#each list as o (o.oid)}
      {@const open = fullDetails || expanded.has(foldKey(o))}
      {@const trigger = o.isTrigger || isTrailing(o)}
      {@const margin = orderMargin(o)}
      {@const time = fmtTime(o.timestamp)}
      <div class="card" class:open data-testid="order-row" data-oid={o.oid}>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="fold" onclick={(e) => !open && !(e.target as Element).closest('button, [data-help], abbr') && toggle(o)}>
        <div class="head">
          <span><Coin coin={o.coin} /> <b class:buy={o.side === 'B'} class:sell={o.side === 'A'}>{dirOf(o)}</b> <span class="dim">{cardType(o)}</span></span>
          <span class="time"><span class="num" class:dim={cardSort.orders === 'time'} title="{time} UTC" data-testid="order-value">{cardSort.orders === 'time' ? fmtWhen(o.timestamp) : whole(o) ? '—' : valueText(o, true)}</span>{#if !fullDetails} <button class="chevron" data-testid="order-expand" aria-expanded={open} aria-label="{open ? 'Hide' : 'Show'} {o.coin} order details" onclick={(e) => (toggle(o), e.currentTarget.blur())}>{open ? '▴' : '▾'}</button>{/if}</span>
        </div>
        <div class="sub">
          <span class="num">{trigger ? `Trigger ${triggerOf(o)} · ` : ''}{sizeText(o)} @ {priceOf(o)}</span>
          {#if canTrade}<span class="actions">{@render actions(o)}</span>{/if}
        </div>
        {#if open}
          <div class="grid">
            <div class="field"><span class="label">Time (UTC)</span><span class="value num">{time}</span></div>
            {#if trigger}<div class="field"><span class="label">Trigger</span><span class="value num">{triggerOf(o)}</span></div>{/if}
            <div class="field"><span class="label">Price</span><span class="value num">{priceOf(o)}</span></div>
            <div class="field"><span class="label">Size</span><span class="value num">{sizeText(o)}</span></div>
            <div class="field"><span class="label">Value</span><span class="value num">{whole(o) ? '—' : valueText(o)}</span></div>
            <div class="field" title={margin.note}><span class="label">Margin</span><span class="value num" data-testid="order-margin">{marginText(margin)}</span></div>
            {#if o.tif && !o.isTrigger}<div class="field"><span class="label">Time in force</span><span class="value">{o.tif}</span></div>{/if}
            <div class="field"><span class="label">Order ID</span><span class="value num">{o.oid}</span></div>
          </div>
        {/if}
        </div>
      </div>
    {/each}
  </div>
{:else}
  <table class="pin-last">
    <thead><tr>
      <SortHead {sorter} />
      <th>{#if canTrade}{@render cancelAll()}{/if}</th>
    </tr></thead>
    <tbody>
      {#each list as o (o.oid)}
        {@const margin = orderMargin(o)}
        <tr data-testid="order-row" data-oid={o.oid}>
          <td class="num dim">{fmtTime(o.timestamp)}</td>
          <td><Coin coin={o.coin} /></td>
          <td>{typeOf(o)}</td>
          <td class:buy={o.side === 'B'} class:sell={o.side === 'A'}>{o.side === 'B' ? 'Buy' : 'Sell'}</td>
          <td class="num">{priceOf(o)}</td>
          <td class="num">{sizeText(o)}</td>
          <td class="num">{whole(o) ? '—' : valueText(o)}</td>
          <td class="num" title={margin.note} data-testid="order-margin">{marginText(margin)}</td>
          <td class="num">{triggerOf(o)}</td>
          <td>{o.reduceOnly ? 'Yes' : 'No'}</td>
          <td class="row-actions">{#if canTrade}{@render actions(o)}{/if}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  p { padding: 12px; }
  .warn { color: var(--warn); }
  .row-actions { white-space: nowrap; }
  .row-actions button + button { margin-left: 4px; }
  .row-actions button { min-height: 24px; padding: 0 3px; }
  .fold { display: grid; gap: inherit; }
  .time { flex: none; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
  .chevron { min-width: 24px; min-height: 24px; padding: 0; background: none; color: var(--dim); }
  .head > span:first-child { min-width: 0; overflow-wrap: anywhere; }
  .card .actions { display: flex; justify-content: flex-end; gap: 6px; }
  .sub { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 2px 8px; color: var(--bright); font-size: max(8px, calc(var(--fs) * 0.917)); }
  .sub .actions { margin-left: auto; }
  .card .actions button { min-height: 28px; min-width: 0; padding: 2px 6px; font-size: 0.92em; font-weight: 500; text-decoration: none; background: none; }
  .card .edit { color: var(--bright); }
  .card .cancel { color: var(--sell-text); }
  .card .cancel:disabled { color: var(--dim); }
  .cards > .card[data-oid]:not(.open) { gap: 2px; padding: 4px 8px; }
  .card:not(.open) .fold { gap: 2px; }
  .card:not(.open) .time { gap: 4px; }
  .card:not(.open) .time > span { font-size: max(8px, 0.85em); }
</style>
