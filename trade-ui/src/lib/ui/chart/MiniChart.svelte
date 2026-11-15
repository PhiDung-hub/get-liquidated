<script lang="ts">
  import { onMount } from 'svelte';
  import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
  import { ALL_INTERVALS, chartCandles, ivLabel, snapshotFrom, watchCandles, type Bar } from '$lib/market/candles';
  import { market, selectCoin } from '$lib/market/market.svelte';
  import { meta, nameOf } from '$lib/market/meta.svelte';
  import { persist, settings } from '$lib/settings/settings.svelte';
  import { fmtPx, pxDecimals } from '$lib/util/format';

  let { index }: { index: number } = $props();
  const pane = $derived(settings.chart.panes[index]);
  const info = $derived(meta.byName.get(pane.coin));
  let el: HTMLDivElement;
  let chart = $state<IChartApi>();
  let series = $state<ISeriesApi<'Candlestick'>>();
  let last = $state<Bar | null>(null);
  let status = $state('');
  let attempt = $state(0);
  const point = (b: Bar) => ({ time: (b.time / 1000) as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });

  onMount(() => {
    chart = createChart(el, { autoSize: true, timeScale: { timeVisible: true, borderVisible: false }, rightPriceScale: { borderVisible: false } });
    series = chart.addSeries(CandlestickSeries, { borderVisible: false });
    return () => chart?.remove();
  });
  $effect(() => {
    void settings.display.theme;
    if (!chart || !series) return;
    const css = getComputedStyle(document.documentElement), token = (name: string) => css.getPropertyValue(name).trim();
    chart.applyOptions({ layout: { background: { color: token('--panel') }, textColor: token('--dim') }, grid: { vertLines: { color: token('--line') }, horzLines: { color: token('--line') } } });
    series.applyOptions({ upColor: token('--buy'), downColor: token('--sell'), wickUpColor: token('--buy'), wickDownColor: token('--sell') });
  });
  $effect(() => {
    const s = series;
    const { coin, interval } = pane;
    void attempt;
    if (!s) return;
    let live = true;
    let newest = 0;
    last = null;
    status = 'Loading…';
    s.setData([]);
    chartCandles(coin, interval, snapshotFrom(interval, Date.now())).then((bars) => {
      if (!live) return;
      status = bars.length ? '' : 'No candles yet';
      if (!bars.length) return;
      const tail = bars[bars.length - 1];
      const d = pxDecimals(tail.close, meta.byName.get(coin)?.szDecimals ?? 0, meta.byName.get(coin)?.spot);
      s.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: 10 ** -d } });
      s.setData(bars.map(point));
      [newest, last] = [tail.time, tail];
    }, (e: Error) => live && (status = `Candles failed: ${e.message}`));
    // Live bars wait for the snapshot, which replaces the series; the feed repeats the open bar on its next trade.
    const off = watchCandles(coin, interval, (b) => {
      if (!live || !newest || b.time < newest) return;
      [newest, last] = [b.time, b];
      s.update(point(b));
    });
    return () => {
      live = false;
      off();
    };
  });

  /** This pane becomes the main chart, which takes its place here. */
  function swap() {
    const { coin, interval } = pane;
    const main = { coin: market.coin, interval: settings.chart.interval };
    selectCoin(coin);
    if (market.coin !== coin) return;
    settings.chart.panes[index] = main;
    settings.chart.interval = interval;
    persist();
  }
  function close() {
    settings.chart.panes.splice(index, 1);
    persist();
  }
</script>

<div class="mini" data-testid="mini-chart" data-coin={pane.coin} data-interval={pane.interval} data-loaded={!!last}>
  <header>
    <button class="coin" data-testid="mini-swap" title="Make this the main chart; the main chart moves here" onclick={(e) => (e.currentTarget.blur(), swap())}>{nameOf(pane.coin)} ⇄</button>
    <b class:down={!!last && last.close < last.open} data-testid="mini-price">{last ? fmtPx(last.close, info?.szDecimals ?? 0, info?.spot) : '—'}</b>
    <select class="ui-field" data-testid="mini-interval" aria-label="Interval of this chart" value={pane.interval} onchange={(e) => { pane.interval = e.currentTarget.value as typeof pane.interval; persist(); }}>
      {#each ALL_INTERVALS as i (i)}<option value={i}>{ivLabel(i)}</option>{/each}
    </select>
    <button data-testid="mini-close" aria-label="Close this chart" title="Close this chart" onclick={close}>×</button>
  </header>
  <div class="plot" bind:this={el}></div>
  {#if status}<p data-testid="mini-status">{status}{#if status.startsWith('Candles failed')} <button onclick={() => attempt++}>Retry</button>{/if}</p>{/if}
</div>

<style>
  .mini { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; background: var(--panel); }
  header { display: flex; align-items: center; gap: 8px; padding: 2px 8px; min-width: 0; }
  .coin { color: var(--bright); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  b { flex: 1; font-family: var(--mono); color: var(--buy); }
  b.down { color: var(--sell); }
  select { width: auto; height: auto; padding: 0 4px; }
  header button:last-child { color: var(--dim); font-size: 1.2em; }
  .plot { min-width: 0; min-height: 0; }
  p { position: absolute; inset: 50% 0 auto; margin: 0; text-align: center; color: var(--dim); }
  p button { color: var(--accent); }
</style>
