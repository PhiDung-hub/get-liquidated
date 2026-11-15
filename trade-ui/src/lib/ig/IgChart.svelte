<script lang="ts">
  import { onMount } from 'svelte';
  import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
  import type { Bar } from './markets';

  let { bars, theme, epic = '' }: { bars: Bar[]; theme: string; epic?: string } = $props();
  let el: HTMLDivElement, chart = $state<IChartApi>(), series = $state<ISeriesApi<'Candlestick'>>();
  onMount(() => {
    chart = createChart(el, { autoSize: true, timeScale: { timeVisible: true }, rightPriceScale: { borderVisible: false } });
    series = chart.addSeries(CandlestickSeries, { borderVisible: false });
    return () => chart?.remove();
  });
  $effect(() => {
    void theme;
    if (!chart || !series) return;
    const css = getComputedStyle(document.documentElement), token = (name: string) => css.getPropertyValue(name).trim();
    chart.applyOptions({ layout: { background: { color: token('--panel') }, textColor: token('--dim') }, grid: { vertLines: { color: token('--line') }, horzLines: { color: token('--line') } } });
    series.applyOptions({ upColor: token('--buy'), downColor: token('--sell'), wickUpColor: token('--buy'), wickDownColor: token('--sell') });
  });
  $effect(() => {
    if (!series) return;
    series.setData($state.snapshot(bars).map(b => ({ ...b, time: b.time as UTCTimestamp })));
    chart?.timeScale().fitContent();
  });
</script>

<div bind:this={el} class="chart" data-testid="ig-chart" data-epic={epic || undefined} data-bars={bars.length}></div>

<style>
  .chart { height: 100%; width: 100%; }
</style>
