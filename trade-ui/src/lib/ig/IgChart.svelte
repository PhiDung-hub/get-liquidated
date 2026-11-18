<script lang="ts">
  import { onMount } from 'svelte';
  import { createChart, CrosshairMode, CandlestickSeries, LineSeries, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
  import { sma, type Bar } from './markets';

  /** key marks a line the user may drag; releasing it calls onmove and sends nothing. */
  export type Line = { price: number; title: string; tone: 'buy' | 'sell' | 'dim' | 'accent'; key?: string };
  const MA_TONES = ['--accent', '--warn', '--sell'];
  let { bars, live = null, theme, epic = '', scope = '', averages = [], lines = [], onmove }: { bars: Bar[]; live?: Bar | null; theme: string; epic?: string; scope?: string; averages?: number[]; lines?: Line[]; onmove?: (key: string, price: number) => void } = $props();
  let el: HTMLDivElement, chart = $state<IChartApi>(), series = $state<ISeriesApi<'Candlestick'>>();
  let studies: ISeriesApi<'Line'>[] = [], drawn: IPriceLine[] = [], fitted = '';
  const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = $derived(live && bars.length && live.time >= bars[bars.length - 1].time ? [...bars.filter(b => b.time < live.time), live] : bars);
  onMount(() => {
    chart = createChart(el, { autoSize: true, crosshair: { mode: CrosshairMode.Normal }, timeScale: { timeVisible: true }, rightPriceScale: { borderVisible: false } });
    series = chart.addSeries(CandlestickSeries, { borderVisible: false });
    return () => chart?.remove();
  });
  $effect(() => {
    void theme;
    if (!chart || !series) return;
    chart.applyOptions({ layout: { background: { color: token('--panel') }, textColor: token('--chart-axis'), fontFamily: token('--mono') }, grid: { vertLines: { color: token('--gutter') }, horzLines: { color: token('--gutter') } } });
    series.applyOptions({ upColor: token('--chart-up'), downColor: token('--chart-down'), wickUpColor: token('--chart-up'), wickDownColor: token('--chart-down') });
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
    located();
  });
  $effect(() => {
    void theme; void lines;
    if (series && dragging < 0) draw();
  });
  function draw() {
    if (!series) return;
    for (const line of drawn) series.removePriceLine(line);
    drawn = lines.map(l => series!.createPriceLine({ price: l.price, title: l.title, color: token(`--${l.tone}`), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true }));
    located();
  }
  let dragging = -1, near = $state(false);
  /** Where each draggable line sits, for browser tests. */
  const located = () => setTimeout(() => { if (el) el.dataset.drag = lines.flatMap(l => l.key ? [`${l.key}@${Math.round(series?.priceToCoordinate(l.price) ?? -1)}`] : []).join('|'); }, 50);
  const y = (e: PointerEvent) => e.clientY - el.getBoundingClientRect().top;
  /** The draggable line within 6px of the pointer, or -1. */
  function hit(e: PointerEvent) {
    if (!series || !onmove || e.clientX - el.getBoundingClientRect().left > el.clientWidth - 70) return -1;
    return lines.findIndex(l => l.key && Math.abs((series!.priceToCoordinate(l.price) ?? -99) - y(e)) <= 6);
  }
  function down(e: PointerEvent) {
    dragging = e.button === 0 ? hit(e) : -1;
    if (dragging < 0) return;
    e.stopPropagation(); el.setPointerCapture(e.pointerId);
    chart?.applyOptions({ handleScroll: false, handleScale: false });
  }
  function move(e: PointerEvent) {
    near = dragging >= 0 || hit(e) >= 0;
    const price = dragging >= 0 ? series?.coordinateToPrice(y(e)) : null;
    if (price != null && price > 0) drawn[dragging]?.applyOptions({ price });
  }
  function up(e: PointerEvent) {
    if (dragging < 0) return;
    const line = lines[dragging], price = series?.coordinateToPrice(y(e)), moved = !!line && Math.abs((series?.priceToCoordinate(line.price) ?? 0) - y(e)) > 3;
    dragging = -1; chart?.applyOptions({ handleScroll: true, handleScale: true });
    draw();
    if (moved && price != null && price > 0) onmove?.(line.key!, price);
  }
</script>

<div bind:this={el} class="chart" class:near role="presentation" onpointerdowncapture={down} onpointermove={move} onpointerup={up} onpointercancel={up} data-testid="ig-chart" data-epic={epic || undefined} data-bars={bars.length} data-averages={averages.join(' ') || undefined} data-lines={lines.map(l => l.title).join('|') || undefined}></div>

<style>
  .chart { height: 100%; width: 100%; } .near, .near :global(*) { cursor: ns-resize !important; }
</style>
