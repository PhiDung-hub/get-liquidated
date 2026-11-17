<script lang="ts">
  import { onMount } from 'svelte';
  import { createChart, CandlestickSeries, LineSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
  import { sma, type Bar } from './markets';

  export type Line = { price: number; title: string; tone: 'buy' | 'sell' | 'dim' };
  const MA_TONES = ['--accent', '--warn', '--sell'];
  let { bars, live = null, theme, epic = '', scope = '', averages = [], lines = [] }: { bars: Bar[]; live?: Bar | null; theme: string; epic?: string; scope?: string; averages?: number[]; lines?: Line[] } = $props();
  let el: HTMLDivElement, chart = $state<IChartApi>(), series = $state<ISeriesApi<'Candlestick'>>();
  let studies: ISeriesApi<'Line'>[] = [], drawn: IPriceLine[] = [], fitted = '';
  const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = $derived(live && bars.length && live.time >= bars[bars.length - 1].time ? [...bars.filter(b => b.time < live.time), live] : bars);
  onMount(() => {
    chart = createChart(el, { autoSize: true, timeScale: { timeVisible: true }, rightPriceScale: { borderVisible: false } });
    series = chart.addSeries(CandlestickSeries, { borderVisible: false });
    return () => chart?.remove();
  });
  $effect(() => {
    void theme;
    if (!chart || !series) return;
    chart.applyOptions({ layout: { background: { color: token('--panel') }, textColor: token('--dim') }, grid: { vertLines: { color: token('--line') }, horzLines: { color: token('--line') } } });
    series.applyOptions({ upColor: token('--buy'), downColor: token('--sell'), wickUpColor: token('--buy'), wickDownColor: token('--sell') });
  });
  $effect(() => {
    if (!chart || !series) return;
    const data = $state.snapshot(shown);
    series.setData(data.map(b => ({ ...b, time: b.time as UTCTimestamp })));
    for (const s of studies) chart.removeSeries(s);
    void theme;
    studies = averages.map((length, i) => {
      const s = chart!.addSeries(LineSeries, { color: token(MA_TONES[i % MA_TONES.length]), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(sma(data, length).map(p => ({ ...p, time: p.time as UTCTimestamp })));
      return s;
    });
    const key = `${epic}:${scope}:${data.length > 0}`;
    if (key !== fitted) { fitted = key; chart.timeScale().fitContent(); }
  });
  $effect(() => {
    if (!series) return;
    void theme;
    for (const line of drawn) series.removePriceLine(line);
    drawn = lines.map(l => series!.createPriceLine({ price: l.price, title: l.title, color: token(`--${l.tone}`), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true }));
  });
</script>

<div bind:this={el} class="chart" data-testid="ig-chart" data-epic={epic || undefined} data-bars={bars.length} data-averages={averages.join(' ') || undefined} data-lines={lines.map(l => l.title).join('|') || undefined}></div>

<style>
  .chart { height: 100%; width: 100%; }
</style>
