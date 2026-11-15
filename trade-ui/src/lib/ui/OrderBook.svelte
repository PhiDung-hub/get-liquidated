<script lang="ts">
  import { onDestroy } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { bbo, book, currentBins, MAX_ROWS, type Level } from '$lib/market/book.svelte';
  import { fmtStep } from '$lib/market/bins';
  import { market } from '$lib/market/market.svelte';
  import { isSpot, meta, quoteOf, symOf } from '$lib/market/meta.svelte';
  import { persist, settings } from '$lib/settings/settings.svelte';
  import { fmtCompact, fmtNum, fmtPx, fmtSz } from '$lib/util/format';
  import { ticket } from '$lib/orders/ticket.svelte';
  import Menu from './order/Menu.svelte';

  /** totals: the Total column shows on a phone too (the full-width Market book). onpick: runs after a row tap sets the ticket price. */
  let { rowRange = [3, MAX_ROWS], totals = false, onpick }: { rowRange?: [number, number]; totals?: boolean; onpick?: () => void } = $props();
  let ladder = $state<HTMLDivElement>();
  let spreadRow = $state<HTMLDivElement>();
  let w = $state(11);
  let width = $state(0);
  const narrow = new MediaQuery('max-width: 900px');
  // A slim desktop column (under 240px) drops Total too, so the book can give the chart its width.
  const full = $derived(totals || (!narrow.current && (!width || width >= 240)));
  const quoteSize = $derived(settings.book.sizeUnit === 'usd');
  const sizeUnit = $derived(quoteSize ? quoteOf(market.coin) : symOf(market.coin));
  const unit = $derived(full ? ` (${sizeUnit})` : '');
  const dec = $derived(meta.byName.get(market.coin)?.szDecimals);
  // A row reads 4 significant figures, never more than the coin's own decimals: 0.00048 keeps them, 25.98245 reads 25.98.
  const depth = (n: number) => (dec === undefined ? fmtSz(n) : fmtSz(n, Math.min(dec, Math.max(0, 3 - Math.floor(Math.log10(Math.abs(n) || 1))))));
  const quoteDepth = (n: number) => Math.abs(n) >= 100000 ? fmtCompact(n) : fmtSz(n, Math.min(isSpot(market.coin) ? 8 : 6, Math.max(0, 3 - Math.floor(Math.log10(Math.abs(n) || 1)))));
  const sizeOptions = $derived([{ value: 'coin', label: symOf(market.coin), testid: 'book-unit-coin' }, { value: 'usd', label: quoteOf(market.coin), testid: 'book-unit-usd' }]);
  const options = $derived(currentBins());
  const active = $derived(book.bin ?? options[0]);
  const menu = $derived(options.map((o) => ({ value: String(o.step), label: fmtStep(o.step, o.decimals), testid: `book-bin-${o.step}` })));
  const withTotals = (levels: Level[]) => {
    let total = 0;
    let notional = 0;
    return levels.slice(0, w).map((l) => ({ ...l, total: (total += l.sz), notional: (notional += l.sz * l.px) }));
  };
  let shown = $state.raw({ bids: book.bids, asks: book.asks });
  let pending = { bids: book.bids, asks: book.asks };
  let frame = 0;
  $effect(() => {
    pending = { bids: book.bids, asks: book.asks };
    if (!pending.bids.length && !pending.asks.length) {
      cancelAnimationFrame(frame);
      frame = 0;
      shown = pending;
      return;
    }
    if (!frame) frame = requestAnimationFrame(() => { shown = pending; frame = 0; });
  });
  onDestroy(() => cancelAnimationFrame(frame));
  const asks = $derived(withTotals(shown.asks).reverse());
  const bids = $derived(withTotals(shown.bids));
  const amount = (level: (typeof bids)[number], cumulative = false) => quoteSize ? Number((cumulative ? level.notional : level.px * level.sz).toFixed(isSpot(market.coin) ? 8 : 6)) : cumulative ? level.total : level.sz;
  const formatAmount = (n: number) => quoteSize ? quoteDepth(n) : depth(n);
  const hasRows = $derived(asks.length + bids.length > 0);
  const max = $derived(Math.max(asks[0] ? amount(asks[0], true) : 0, bids.at(-1) ? amount(bids.at(-1)!, true) : 0) || 1);
  // Grouped buckets floor bids and ceil asks, so the live bbo inside the best bucket is the active price that row shows.
  const inBucket = (best: number, px: number, isBid: boolean) => !!book.bin && best > 0 && (isBid ? best >= px && best < px + book.bin.step : best <= px && best > px - book.bin.step);
  const bid = $derived(!book.bin ? bbo.bid : inBucket(bbo.bid, shown.bids[0]?.px ?? 0, true) ? bbo.bid : shown.bids[0]?.px ?? 0);
  const ask = $derived(!book.bin ? bbo.ask : inBucket(bbo.ask, shown.asks[0]?.px ?? 0, false) ? bbo.ask : shown.asks[0]?.px ?? 0);
  const rowPx = (l: Level, isBid: boolean) => (book.bin && l.px === (isBid ? shown.bids : shown.asks)[0]?.px ? (isBid ? bid : ask) : l.px);
  const spread = $derived(bid > 0 && ask > 0 ? ask - bid : NaN);
  const spreadPct = $derived(Math.max(0.001, (spread / ((ask + bid) / 2)) * 100));
  // Hovering a level sums every level from the mid out to it, as Hyperliquid's book does.
  let hovered = $state<{ side: 'ask' | 'bid'; px: number; x: number; y: number } | null>(null);
  const reach = $derived(hovered ? (hovered.side === 'ask' ? asks : bids).find((l) => l.px === hovered!.px) : undefined);
  const inReach = (side: 'ask' | 'bid', px: number) => hovered?.side === side && !!reach && (side === 'ask' ? px <= hovered.px : px >= hovered.px);
  function hover(e: PointerEvent, side: 'ask' | 'bid', px: number) {
    if (e.pointerType === 'touch') return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    hovered = { side, px, x: r.left, y: r.top + r.height / 2 };
  }
  const fmtRow = (px: number) => fmtPx(px, dec, isSpot(market.coin));

  // Rows per side that fit around the spread row (spec §1.2); the spread row is observed too, since it resizes with the text size.
  // Refit once rows first render: the ladder keeps its size, so the observer alone would keep a fit made with no row to measure.
  $effect(() => {
    if (!ladder || !spreadRow || !hasRows) return;
    const [el, mid] = [ladder, spreadRow];
    const fit = () => {
      const row = el.querySelector('.row');
      if (!row) return;
      const style = getComputedStyle(row);
      const rowH = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      w = Math.min(rowRange[1], Math.max(rowRange[0], Math.floor((el.clientHeight - mid.offsetHeight) / 2 / rowH)));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    ro.observe(mid);
    return () => ro.disconnect();
  });

  function chooseBin(v: string) {
    settings.book.bins[market.coin] = Number(v);
    persist();
  }

  function chooseSizeUnit(value: string) {
    if (value !== 'coin' && value !== 'usd') return;
    settings.book.sizeUnit = value;
    persist();
  }

  function pick(px: number) {
    ticket.px = String(px);
    if (ticket.kind === 'market') {
      ticket.kind = settings.panel.kind = 'limit';
      persist();
    }
    onpick?.();
  }
</script>

<div class="ob" class:totals bind:clientWidth={width} data-testid="book" data-time={book.time} data-coin={market.coin} data-unit={sizeUnit} data-rows={w}>
  <div class="head">
    <div class="bins">
      <Menu value={settings.book.sizeUnit} options={sizeOptions} text={quoteSize ? quoteOf(market.coin) : 'Native'} onpick={chooseSizeUnit} testid="book-unit" ariaLabel="Book size unit" dropdown />
      {#if active}<Menu value={String(active.step)} options={menu} onpick={chooseBin} testid="book-bins" ariaLabel="Book bins" />{/if}
    </div>
    <div class="cols"><span>Price</span><span>Size{unit}</span>{#if full}<span>Total{unit}</span>{/if}</div>
  </div>
  <div class="ladder" role="group" aria-label="Order book levels" class:filled={asks.length === w && bids.length === w} style:--rows={w} bind:this={ladder} onpointerleave={() => (hovered = null)}>
    {#each asks as l}
      <button class="row" class:reach={inReach('ask', l.px)} class:edge={hovered?.side === 'ask' && hovered.px === l.px} data-testid="book-ask" style="--w:{((amount(l, true) / max) * 100).toFixed(1)}%" onpointerenter={(e) => hover(e, 'ask', l.px)} onclick={(e) => (e.currentTarget.blur(), pick(rowPx(l, false)))}>
        <span class="num sell">{fmtRow(rowPx(l, false))}</span><span class="num" data-testid="book-size" title={`${amount(l)} ${sizeUnit}`}>{formatAmount(amount(l))}</span>{#if full}<span class="num dim" data-testid="book-total" title={`${amount(l, true)} ${sizeUnit}`}>{formatAmount(amount(l, true))}</span>{/if}
      </button>
    {/each}
    {#if !asks.length || !bids.length}<div class="depth-state" role="status">Waiting for {asks.length ? 'bids' : bids.length ? 'asks' : 'market depth'}…</div>{/if}
    <div class="spread num dim" data-testid="book-spread" bind:this={spreadRow}>
      <span>Spread</span><span>{Number.isFinite(spread) ? fmtNum(spread, options[0]?.decimals ?? 0) : '—'}</span><span>{Number.isFinite(spread) ? `${spreadPct.toFixed(3)}%` : ''}</span>
    </div>
    {#each bids as l}
      <button class="row bid" class:reach={inReach('bid', l.px)} class:edge={hovered?.side === 'bid' && hovered.px === l.px} data-testid="book-bid" style="--w:{((amount(l, true) / max) * 100).toFixed(1)}%" onpointerenter={(e) => hover(e, 'bid', l.px)} onclick={(e) => (e.currentTarget.blur(), pick(rowPx(l, true)))}>
        <span class="num buy">{fmtRow(rowPx(l, true))}</span><span class="num" data-testid="book-size" title={`${amount(l)} ${sizeUnit}`}>{formatAmount(amount(l))}</span>{#if full}<span class="num dim" data-testid="book-total" title={`${amount(l, true)} ${sizeUnit}`}>{formatAmount(amount(l, true))}</span>{/if}
      </button>
    {/each}
  </div>
  {#if hovered && reach}
    <div class="reach-tip" role="tooltip" data-testid="book-reach" style:right="{innerWidth - hovered.x + 8}px" style:top="{hovered.y}px">
      <span>Distance from Mid</span><b data-testid="book-reach-dist">{bid > 0 && ask > 0 ? `${((Math.abs(hovered.px - (bid + ask) / 2) / ((bid + ask) / 2)) * 100).toFixed(4)}%` : '—'}</b>
      <span>Average Price</span><b data-testid="book-reach-avg">{fmtPx(reach.notional / reach.total, dec, isSpot(market.coin))}</b>
      <span>Total ({symOf(market.coin)})</span><b data-testid="book-reach-size">{fmtSz(reach.total, dec)}</b>
      <span>Total ({quoteOf(market.coin)})</span><b data-testid="book-reach-usd">{fmtNum(reach.notional, 0)}</b>
    </div>
  {/if}
</div>

<style>
  .ob { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; font-size: var(--fs); }
  .bins { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 1.4em; padding: 2px 8px 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr 1fr; padding: 2px 8px 0; color: var(--dim); text-align: right; }
  .cols span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cols span:first-child { text-align: left; }
  .ladder { flex: 1; min-height: 0; display: grid; align-content: center; overflow: hidden; contain: strict; will-change: transform; }
  .ladder.filled { align-content: stretch; grid-template-rows: repeat(var(--rows), minmax(0, 1fr)) auto repeat(var(--rows), minmax(0, 1fr)); }
  .row {
    display: grid; grid-template-columns: 1fr 1fr 1fr; align-items: center; width: 100%; padding: 1px 8px; border-radius: 0; text-align: right;
    background: linear-gradient(to left, color-mix(in srgb, var(--sell) 7%, transparent) var(--w), transparent var(--w));
  }
  .row.bid { background: linear-gradient(to left, color-mix(in srgb, var(--buy) 7%, transparent) var(--w), transparent var(--w)); }
  .depth-state { color: var(--dim); padding: 8px; text-align: center; }
  .row span:first-child { text-align: left; }
  button.row:hover { outline: 1px solid var(--line); }
  .row.reach { background-color: color-mix(in srgb, var(--bright) 6%, transparent); }
  .row.edge > :nth-child(2) { font-weight: 700; color: var(--bright); }
  .row.edge { border-top: 1px dashed var(--dim); }
  .row.bid.edge { border-top: 0; border-bottom: 1px dashed var(--dim); }
  .reach-tip {
    position: fixed; z-index: 50; transform: translateY(-50%); display: grid; grid-template-columns: auto auto; gap: 8px 32px; padding: 10px 14px;
    background: var(--surface); color: var(--text); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 6px 20px #0006;
    font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none;
  }
  .reach-tip b { font-weight: 400; text-align: right; color: var(--bright); }
  .spread { display: flex; justify-content: center; gap: 24px; padding: 3px; border-block: 1px solid var(--gutter); }
  @media (max-width: 900px) {
    .ob { font-size: max(8px, calc(var(--fs) * 0.833)); }
    .cols, .row { grid-template-columns: 1fr auto; column-gap: 6px; padding-inline: 4px; }
    .totals :is(.cols, .row) { grid-template-columns: 1fr 1fr 1fr; }
    .bins { padding: 0 4px; }
    .spread > :first-child { display: none; }
    .spread { gap: 8px; }
  }
</style>
