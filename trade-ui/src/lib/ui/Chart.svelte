<script module lang="ts">
  export type ChartCmd = 'reset' | 'back' | 'forward' | 'zoomIn' | 'zoomOut' | 'zoomInBoth' | 'zoomOutBoth' | 'log' | 'percent' | 'invert' | 'up' | 'down' | 'indicators' | 'fullscreen';
  let active: ((cmd: ChartCmd) => void) | undefined;
  export const chartCmd = (cmd: ChartCmd) => active?.(cmd);
</script>

<script lang="ts">
  import { flushSync, onMount, tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { createChart, CandlestickSeries, CrosshairMode, HistogramSeries, PriceScaleMode, TickMarkType, type AutoscaleInfo, type Time, type IChartApi, type ISeriesApi, type Logical, type MouseEventParams, type UTCTimestamp } from 'lightweight-charts';
  import { positionOf } from '$lib/account/inventory.svelte';
  import Coin from './Coin.svelte';
  import MarketPicker from './MarketPicker.svelte';
  import { market } from '$lib/market/market.svelte';
  import { meta, nameOf, isSpot } from '$lib/market/meta.svelte';
  import { ALL_INTERVALS, MS, candleSnapshot, chartCandles, ivGroup, ivLabel, ivName, keepCandles, snapshotFrom, watchCandles, type Bar, type Interval } from '$lib/market/candles';
  import { withHistory, type Flow, type Hist } from '$lib/market/flow';
  import { CHUNK, oldestChunk, fundingHistory, fundingValues, predictedFunding, publishedHour, type FundingHistory, type Prediction } from '$lib/market/fundingHistory';
  import { flow } from '$lib/market/watch.svelte';
  import { MAX_PANES, settings, persist } from '$lib/settings/settings.svelte';
  import { fmtCompact, fmtNum, fmtPct, fmtPx, fmtSz, pxDecimals } from '$lib/util/format';
  import { toast } from './toast.svelte';
  import { rateLimited, socket } from '$lib/transport/ws.svelte';
  import { modal, openSettings, ui } from './state.svelte';
  import { chartFont } from './display.svelte';
  import Menu from './order/Menu.svelte';
  import { cancelLine, lineLabels, positionLines, signed, toggleGroup } from './chart/positionLines.svelte';
  import { bindingsFor, keyLabel, type ActionId } from '$lib/hotkeys/keymap';
  import { session } from '$lib/session/session.svelte';
  import { inZen, setZen } from './zen';
  import { chartTools, escapeChart, pickSelected } from './chart/tools.svelte';
  import { measure } from './chart/measure.svelte';
  import { armTool, clearDrawings, deleteSelected, drawings } from './chart/drawings.svelte';
  import { timeToLogical } from './chart/geometry';
  import GoTo from './chart/GoTo.svelte';
  import Toasts from './Toasts.svelte';
  import { RANGES, rangeInterval, reachInterval, today, zoned } from './chart/ranges';
  import { compareLines, compareView, compared, leftWidth, toggleCompare } from './chart/compare.svelte';
  import { aiMarks, aiView } from './chart/aiMarks.svelte';
  import { agent, annotationChat, askBlocked, noAi, type Selection } from '$lib/agent/agent.svelte';
  import { load as loadStored, save as saveStored } from '$lib/util/storage';
  import AiPanel from '$lib/ui/ai/AiPanel.svelte';
  import AnnotationChat from './ai/AnnotationChat.svelte';
  import { coach, demoLevels } from './ai/setups.svelte';
  import { collectSelection } from './chart/selection';
  import { fillHover, fillMarkers } from './chart/fillMarkers.svelte';
  import { DEFS, inputsText, plotName, plotStyle, type Study } from '$lib/market/studies';
  import { buildStudies, drawStudy, removeStudies, styleStudy, valueDigits, volumeAxis, type Inst } from './chart/studyLayer';
  import Indicators, { addStudy, removeStudy, toggleStudy } from './chart/Indicators.svelte';
  import StudySettings from './chart/StudySettings.svelte';
  const SCALES = [['log', 'log', 'Log scale', 'chartLog'], ['percent', 'pct', 'Percent scale', 'chartPercent'], ['invert', 'inv', 'Invert scale', 'chartInvert']] as const;
  const MODES = { log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage };
  let scaleMenu = $state(false);
  const regularOr = (m: keyof typeof MODES) => { if (scale.mode !== MODES[m]) command(m); };
  const RETRY_MS = [2000, 5000, 15000, 30000];
  const keys = (id: ActionId) => bindingsFor(id).map(keyLabel).join(' / ') || 'no key';
  const keyed = (id: ActionId, rest: string) => (bindingsFor(id).length ? `${keys(id)}; ${rest}` : rest);
  const TOOLS = [['h', 'M2 9h5.5m3 0H16M7.5 9a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0', 'Horizontal line', 'drawH'], ['v', 'M9 2v5.5m0 3V16M9 7.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3', 'Vertical line', 'drawV'], ['trend', 'M4.1 13.9 13.9 4.1M1.5 15a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M13.5 3a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0', 'Trend line', 'drawTrend'], ['fib', 'M2 3h14M2 7h9M2 11h11M2 15h14', 'Fib retracement', 'drawFib']] as const;
  const commonZones = ['UTC', 'Asia/Singapore', 'Asia/Ho_Chi_Minh', 'Asia/Tokyo', 'Europe/London', 'America/New_York'];
  let now = $state(0);
  let localZone = $state('UTC');
  let allZones = $state<string[]>([]);
  const timezone = $derived(settings.chart.timezone === 'local' ? localZone : settings.chart.timezone);
  const zoneFormats = $derived({
    clock: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    seconds: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    full: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }),
    parts: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    day: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric' }),
    month: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, month: 'short' }),
    year: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric' }),
    offset: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeZoneName: 'shortOffset' })
  });
  // Zone offsets change on a quarter hour (Lord Howe's DST starts at :30 UTC), so the label is recomputed only then.
  const quarterNow = $derived(Math.floor(now / 900_000));
  const offsetAt = (format: Intl.DateTimeFormat, at: number) =>
    format.formatToParts(at).find((part) => part.type === 'timeZoneName')!.value.replace('GMT', 'UTC').replace(/^UTC[+-]0$/, 'UTC');
  const clockOffset = $derived(offsetAt(zoneFormats.offset, quarterNow * 900_000));
  const otherZones = $derived([...new Set([...allZones, settings.chart.timezone])].filter((zone) => zone !== 'local' && !commonZones.includes(zone)).sort());
  let offsets = $state.raw(new Map<string, string>());
  let offsetsQuarter = -1;
  function prepareZoneOffsets() {
    const at = Date.now();
    const quarter = Math.floor(at / 900_000);
    if (quarter === offsetsQuarter && offsets.has(settings.chart.timezone)) return;
    const labels = new Map<string, string>();
    for (const zone of ['local', ...commonZones, ...otherZones]) {
      const format = new Intl.DateTimeFormat('en-GB', { timeZone: zone === 'local' ? undefined : zone, timeZoneName: 'shortOffset' });
      const offset = offsetAt(format, at);
      labels.set(zone, offset === 'UTC' ? 'UTC+0' : offset);
    }
    offsetsQuarter = quarter;
    // Native select popups can open on pointerdown before Svelte flushes pending text.
    flushSync(() => (offsets = labels));
  }
  const zoneLabel = (zone: string) => {
    const offset = offsets.get(zone);
    if (zone === 'local') return `Local (${localZone.replaceAll('_', ' ')}${offset ? `, ${offset}` : ''})`;
    const name = zone.replaceAll('_', ' ');
    return offset ? `${name} (${offset})` : name;
  };
  const timeMs = (value: Time) => typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value + 'T00:00:00Z') : Date.UTC(value.year, value.month - 1, value.day);
  onMount(() => {
    localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    allZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : commonZones;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => (now = Date.now(), timer = setTimeout(tick, 60_000 - (now % 60_000)));
    tick();
    return () => clearTimeout(timer);
  });
  let el: HTMLDivElement;
  // lightweight-charts has no maximum axis width and a label's width depends on the pane height, so floor both axes at a computed width no label reaches.
  // The right axis is one width across all panes, so a visible study's labels count too.
  let ruler: HTMLCanvasElement | undefined;
  let pinned = '';
  const studyLabels = () => [...new Set(insts.flatMap((k) => k.study.hidden ? [] : k.def.percent ? ['-0.0000%'] : k.def.flow || k.def.key === 'obv' ? ['-00.000M'] : k.def.pane === 'own' && !k.def.range ? ['-0000.00'] : []))];
  const pinAxes = (c: IChartApi) => {
    const close = bars.at(-1)?.close;
    if (!close) return;
    const font = chartFont();
    const family = css('--mono');
    const shape = candles.priceFormatter().format(close).replace(/\d/g, '0');
    const right = [scale.mode === PriceScaleMode.Percentage ? '-00.00%' : `${shape}0`, ...studyLabels()];
    const key = `${font}|${family}|${right}`;
    if (pinned === key) return;
    pinned = key;
    const ctx = (ruler ??= document.createElement('canvas')).getContext('2d')!;
    ctx.font = `${font}px ${family}`;
    const width = (labels: string[]) => { const w = Math.ceil(11 + font * 5 / 6 + Math.max(...labels.map((l) => ctx.measureText(l).width))); return w + w % 2; };
    c.priceScale('right').applyOptions({ minimumWidth: width(right) });
    c.priceScale('left').applyOptions({ minimumWidth: width(['-00.00%']) });
  };
  let wrapper: HTMLDivElement;
  let nativeFullscreen = $state(false);
  let focused = $state(false);
  const fullscreen = $derived(nativeFullscreen || focused);
  $effect(() => {
    ui.chartFull = fullscreen;
    return () => (ui.chartFull = false);
  });
  async function toggleFullscreen() {
    if (document.fullscreenElement === wrapper) return void await document.exitFullscreen();
    if (focused) { focused = false; return; }
    try {
      if (!wrapper.requestFullscreen) { focused = true; return; }
      await wrapper.requestFullscreen();
    } catch { focused = true; }
  }
  onMount(() => {
    const changed = () => nativeFullscreen = document.fullscreenElement === wrapper;
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  });
  let chart = $state<IChartApi>();
  let chartWidth = $state(0);
  const DOCK = 'trade-ui:copilot-size';
  let dock = $state(loadStored(DOCK, { w: 0, h: 0 }));
  let grip: { x: number; y: number; w: number; h: number } | null = null;
  const saveDock = (size: { w: number; h: number }) => saveStored(DOCK, (dock = size));
  function gripDown(e: PointerEvent) {
    const box = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    grip = { x: e.clientX, y: e.clientY, w: box.width, h: box.height };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function gripMove(e: PointerEvent) {
    if (grip) dock = { w: Math.max(280, Math.round(grip.w + grip.x - e.clientX)), h: Math.max(180, Math.round(grip.h + e.clientY - grip.y)) };
  }
  function gripUp() {
    if (grip) saveDock(dock);
    grip = null;
  }
  const mobileIv = new MediaQuery('(max-width: 900px), (pointer: coarse) and (max-height: 500px)');
  const pinnedIntervals = $derived(mobileIv.current ? settings.chart.pinnedIntervals : settings.chart.desktopPinnedIntervals);
  let pinCapacity = $state(0);
  let candles: ISeriesApi<'Candlestick'>;
  const chooseInterval = (interval: Interval) => { settings.chart.interval = interval; persist(); };
  /** Another chart of this market beside the main one, on the first of these intervals no chart of it shows yet. */
  function addPane() {
    const shown = [settings.chart.interval, ...settings.chart.panes.filter((p) => p.coin === market.coin).map((p) => p.interval)];
    settings.chart.panes.push({ coin: market.coin, interval: (['1h', '4h', '1d', '5m', '15m'] as Interval[]).find((i) => !shown.includes(i)) ?? '1h' });
    persist();
  }
  const pinInterval = (interval: Interval) => {
    const pins = pinnedIntervals;
    if (mobileIv.current && !pins.includes(interval) && pins.length >= 9) return void toast.info('Unpin a timeframe before adding another (maximum 9).');
    const next = ALL_INTERVALS.filter((i) => i === interval ? !pins.includes(i) : pins.includes(i));
    if (mobileIv.current) settings.chart.pinnedIntervals = next;
    else settings.chart.desktopPinnedIntervals = next;
    persist();
  };
  const inlineIv = $derived(pinnedIntervals.slice(0, pinCapacity).includes(settings.chart.interval));
  function fitPinnedIntervals(toolbar: HTMLDivElement) {
    void [pinnedIntervals, mobileIv.current, compact, fullscreen, session.master];
    if (mobileIv.current) return;
    const measure = () => {
      const style = getComputedStyle(toolbar), gap = parseFloat(style.columnGap) || 0;
      const children = [...toolbar.children] as HTMLElement[];
      const fixed = children.filter((child) => !child.classList.contains('iv'));
      let available = toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - gap * Math.max(0, fixed.length - 1);
      for (const child of fixed) {
        const css = getComputedStyle(child);
        available -= child.getBoundingClientRect().width;
        available -= (parseFloat(css.marginLeft) || 0) + (parseFloat(css.marginRight) || 0);
      }
      let count = 0;
      for (const button of children.filter((child) => child.classList.contains('iv'))) {
        const width = button.getBoundingClientRect().width + gap;
        if (width > available) break;
        available -= width;
        count++;
      }
      pinCapacity = count;
    };
    const observer = new ResizeObserver(measure);
    let active = true;
    void tick().then(() => {
      if (!active) return;
      observer.observe(toolbar);
      for (const child of toolbar.children) observer.observe(child);
      measure();
    });
    return () => { active = false; observer.disconnect(); };
  }
  $effect(() => { if (chart) volume.applyOptions({ visible: settings.chart.volume }); });
  let volume: ISeriesApi<'Histogram'>;
  let bars = $state.raw<Bar[]>([]);
  let barsVersion = $state(0);
  const coachBars = $derived.by(() => {
    void barsVersion;
    return coach.open && coach.mode === 'metrics' ? bars.slice() : [];
  });
  let loadedFrom = 0;
  let insts: Inst[] = [];
  let count = $state(0);
  let barCount = $state(0);
  let priceRange = $state('');
  let timeRange = $state('');
  let cvdBars = $state(0);
  let oidBars = $state(0);
  let paneCount = $state(1);
  let crosshair = $state('');
  let decimals = $state(2);
  let retrying = $state(false);
  let empty = $state(false);
  let axisW = $state(0);
  let axisL = $state(0);
  let paneTop = $state<Record<string, number>>({});
  let priceH = $state(0);
  let kickLines = () => {};
  let legendH = $state(0);
  $effect(() => {
    if (legendH >= 0) untrack(kickLines);
  });
  let hoverTime: number | null = null;
  const scale = $state({ mode: PriceScaleMode.Normal, invert: false });
  let logOffset = 4;
  let autoPriceRange: { minValue: number; maxValue: number } | null = null;
  const trackedScales = new WeakSet<object>();
  function trackPriceRanges(c: IChartApi) {
    for (const series of c.panes()[0].getSeries()) {
      if ((series.options().priceScaleId ?? 'right') !== 'right' || trackedScales.has(series)) continue;
      trackedScales.add(series);
      const provider = series.options().autoscaleInfoProvider;
      series.applyOptions({ autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = provider ? provider(original) : original();
        if (series === candles) autoPriceRange = null;
        const range = info?.priceRange;
        if (range) {
          autoPriceRange = {
            minValue: Math.min(autoPriceRange?.minValue ?? Infinity, range.minValue),
            maxValue: Math.max(autoPriceRange?.maxValue ?? -Infinity, range.maxValue)
          };
        }
        if (autoPriceRange) {
          // Match 5.2's log formula before getVisibleRange rounds its bounds to the price tick.
          const span = autoPriceRange.maxValue - autoPriceRange.minValue || 10 * 10 ** -decimals;
          logOffset = span >= 1 || span < 1e-15 ? 4 : 4 + Math.ceil(Math.abs(Math.log10(span)));
        }
        return info;
      } });
    }
  }
  let applied = $state({ mode: '', invert: false });
  let legend = $state<{ bar: Bar; vals: Record<string, string>; cols: Record<string, string>; focused: boolean }>();
  const loadCoach = () => import('./ai/ChartCoach.svelte').then((m) => m.default).catch(() => { coach.open = false; toast.error('Chart coach could not load. Reload the page and try again.'); return null; });
  const narrow = new MediaQuery('max-width: 900px');
  // The top bar's three widths, by the plot's own width (a desktop chart column can be narrow too) less the view controls.
  const compact = $derived(chartWidth > 0 && chartWidth < 560);
  const inlineRanges = $derived(chartWidth >= Math.max(672, 48 * settings.display.fs));
  const room = $derived(chartWidth - 6 * settings.display.fs - (fullscreen ? 64 : 0));
  const blocked = $derived(askBlocked());
  const toggleTool = (t: Parameters<typeof armTool>[0]) => (drawings.tool === t ? escapeChart() : armTool(t));
  type RailItem = { id: string; d: string; label: string; title: string; on?: boolean; off?: boolean; act: () => unknown; sep?: boolean };
  const picked = $derived(pickSelected());
  const railItems: RailItem[] = $derived([
    ...(noAi() ? [] : [
      { id: 'ask-ai', d: 'M3 4h12v8H8.5L5 15v-3H3z', label: 'Ask AI about a chart point or zone', title: blocked || `Ask AI: click a candle for a point or drag a zone (${keyed('askAi', 'Esc cancels')})`, on: drawings.tool === 'ask', off: !!blocked, act: () => (blocked ? toast.error(blocked) : toggleTool('ask')), sep: !picked },
      ...(picked ? [{ id: 'ask-selected', d: 'M3 4h12v8H8.5L5 15v-3H3zM9 6v4M7 8h4', label: 'Ask AI about the selected drawing or measure', title: blocked || 'Ask AI about what is selected: the drawing or the measured range, with the candles, orders and fills inside it', off: !!blocked, act: () => (blocked ? toast.error(blocked) : Object.assign(annotationChat, { markId: null, pending: picked })), sep: true }] : []),
    ]),
    ...TOOLS.map(([tool, d, text, action]) => ({ id: `draw-${tool}`, d, label: text, title: `${text} (${keyed(action, 'Esc cancels')})`, on: drawings.tool === tool, act: () => toggleTool(tool) })),
    { id: 'draw-ruler', d: 'M2.5 12.5 12.5 2.5l3 3-10 10zM5.5 9.5 7 11M8 7l1.5 1.5M10.5 4.5 12 6', label: 'Measure', title: 'Measure: drag from one point to another (Shift+drag with a mouse; Esc cancels)', on: drawings.tool === 'ruler', act: () => toggleTool('ruler'), sep: true },
    { id: 'draw-eraser', d: 'm3 10.5 6.75-7.5 5.25 5.25-6.75 7.5H5.25l-2.25-3zm3.75-3.75 5.25 5.25M8.25 15.75h7.5', label: 'Erase drawing', title: 'Eraser: click a drawing to remove it; Ctrl+Z undoes, Esc exits', on: drawings.tool === 'eraser', act: () => toggleTool('eraser') },
    { id: 'draw-clear', d: 'M3.5 5h11M7 5V3.5h4V5m-6 0 .7 9.5h6.6L13 5M7.8 7.5v5M10.2 7.5v5', label: drawings.sel ? 'Delete selected drawing' : 'Delete all drawings', title: drawings.sel ? 'Delete the selected drawing (Ctrl+Z undoes)' : `Delete all ${market.coin} drawings (Ctrl+Z undoes)`, off: !drawings.list.length, act: () => (drawings.sel ? deleteSelected() : clearDrawings()) }
  ]);
  // A rail shorter than its tools folds the rest behind ⋯: a slot is a button and its 2px gap, the two rules take 18px.
  let railH = $state(0);
  let railMore = $state(false);
  const coarse = new MediaQuery('pointer: coarse');
  const railFit = $derived.by(() => {
    const slot = coarse.current ? 36 : 32;
    return railItems.length * slot + 24 <= railH ? railItems.length : Math.max(0, Math.floor((railH - 6) / slot) - 1);
  });
  const openGroup = $derived(lineLabels.groups.find((g) => g.key === lineLabels.open));
  type GroupRow = (typeof lineLabels.groups)[number]['rows'][number];
  const SORTS = { px: (r: GroupRow) => (r.o.isTrigger ? r.o.triggerPx : r.o.limitPx), sz: (r: GroupRow) => r.o.sz, pnl: (r: GroupRow) => r.pnl ?? 0, pos: (r: GroupRow) => r.projected };
  /** A view order only: # keeps each order's place in fill order, which the effects and totals are computed in. */
  let groupSort = $state<{ key: keyof typeof SORTS; dir: 1 | -1 } | null>(null);
  const cycleSort = (key: keyof typeof SORTS) => (groupSort = groupSort?.key !== key ? { key, dir: -1 } : groupSort.dir === -1 ? { key, dir: 1 } : null);
  let groupThrough = $state<number | null>(null);
  const sortRows = (rows: GroupRow[]) => {
    const numbered = rows.map((r, n) => ({ r, n }));
    const by = groupSort;
    return by ? numbered.sort((a, b) => by.dir * (SORTS[by.key](a.r) - SORTS[by.key](b.r)) || a.n - b.n) : numbered;
  };
  // A row that moves when another leaves or joins the open list slides there from its last place. Svelte drops a leaving row before any effect runs,
  // so places are re-measured after everything that moves the list (a flip, its tag, a resize, a scroll) and compared when the rows change.
  let rowKeys = '';
  let rowTops = new Map<string, number>();
  const rowEls = () => [...document.querySelectorAll<HTMLElement>('[data-testid=group-row]')];
  const topOf = (r: HTMLElement) => r.parentElement!.getBoundingClientRect().top + r.offsetTop - r.parentElement!.scrollTop;
  const measureRows = () => (rowTops = new Map(rowEls().map((r) => [r.dataset.oid!, topOf(r)])));
  $effect(() => {
    const g = openGroup;
    void [g?.y, g?.up, g?.room, chartWidth, lineLabels.size];
    const keys = g?.rows.map((r) => r.key).join() ?? '';
    untrack(() => {
      if (keys !== rowKeys)
        for (const r of rowEls()) {
          // A row still sliding starts from where it is drawn.
          const dy = (rowTops.get(r.dataset.oid!) ?? NaN) - topOf(r) + new DOMMatrixReadOnly(getComputedStyle(r).transform).m42;
          if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
        }
      rowKeys = keys;
      measureRows();
    });
  });
  // A sheet whose group dissolved (it went without the user closing it) leaves its scrim up for a moment, so a tap meant for its rows hits nothing.
  let shield = $state(false);
  let sheet: string[] = [];
  $effect(() => {
    const members = narrow.current && openGroup ? openGroup.members : [];
    if (sheet.length && !members.length && !untrack(() => lineLabels.groups).some((g) => g.members.some((m) => sheet.includes(m)))) (shield = true), setTimeout(() => (shield = false), 400);
    sheet = members;
  });
  // A hidden chart (another phone tab) keeps no list open.
  $effect(() => {
    if (!chartWidth) untrack(() => (lineLabels.open = ''));
  });
  let legendOpen = $state(typeof matchMedia === 'undefined' || !matchMedia('(max-width: 900px)').matches);
  // Rows past the price pane would cover the volume and pane legends, so they fold into the ▾ +N count, as Hyperliquid's legend does.
  let legendBox = $state<HTMLElement>();
  let cut = $state(0);
  // ▾ +N first lists every row in a scrolling legend; the next click folds it.
  let legendAll = $state(false);
  const legendRoom = $derived((paneTop.volume || priceH) - 2);
  $effect(() => {
    const box = legendBox;
    const room = legendRoom;
    void [legendH, legendOpen, legendAll, priceRows, compareView.rows, aiView.bias.length];
    if (!box || !priceH) return;
    untrack(() => {
      const rows = [...box.children].slice(1) as HTMLElement[];
      for (const r of rows) r.style.display = '';
      const over = legendAll ? [] : rows.filter((r) => r.offsetTop + r.offsetHeight > room);
      for (const r of over) r.style.display = 'none';
      cut = over.length;
    });
  });
  const NO_RATES: FundingHistory = { rows: [], since: Infinity };
  let rateHist = NO_RATES;
  let rateCoin = '';
  let rateFrom = $state(0);
  let rateStatus = $state('');
  let prediction = $state<Prediction[]>([]);
  let predictionNote = $state('');
  const rateHour = $derived(publishedHour(now));
  const rateMinute = $derived(Math.floor(now / 60_000));
  const spot = $derived(isSpot(market.coin));
  const ratesOn = $derived(settings.chart.studies.some((s) => DEFS[s.type].data && !s.hidden) && !spot);
  const fundingOn = $derived(settings.chart.studies.some((s) => DEFS[s.type].data === 'funding' && !s.hidden) && !spot);
  const pctRate = (v: number | null | undefined) => v == null ? '—' : `${(v * 100).toFixed(4)}%`;
  const livePremium = $derived(market.ctx?.oraclePx ? (market.ctx.markPx - market.ctx.oraclePx) / market.ctx.oraclePx : null);
  const venueFunding = $derived([['HlPerp', 'Hyperliquid'], ['BinPerp', 'Binance'], ['BybitPerp', 'Bybit']].map(([id, name]) => ({
    id, name, rate: prediction.find((r) => r.venue === id),
    expired: !!prediction.find((r) => r.venue === id && r.nextTime !== null && r.nextTime <= now)
  })));
  const predictionFetched = $derived(prediction[0]?.fetchedAt);
  const predictedText = $derived(venueFunding.map(({ name, rate, expired }) => `${name} ${expired ? 'awaiting update' : pctRate(rate?.rate)}${rate?.hours && !expired ? `/${rate.hours}h` : ''}`).join(' · '));
  function fitFunding(el: HTMLElement) {
    const box = el.closest('.chart') as HTMLElement;
    const fit = () => {
      if (!el.offsetHeight) return;
      const bounds = box.getBoundingClientRect(), anchor = el.parentElement!.getBoundingClientRect();
      const above = anchor.top - bounds.top - 14, below = bounds.bottom - anchor.bottom - 14;
      const up = above >= below;
      el.style.width = `${Math.min(440, bounds.width - 16)}px`;
      el.style.maxHeight = `${Math.max(0, up ? above : below)}px`;
      el.style.left = `${Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - el.offsetWidth - 8)) - anchor.left}px`;
      el.style.top = `${up ? -el.offsetHeight - 6 : anchor.height + 6}px`;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    ro.observe(box);
    return () => ro.disconnect();
  }
  let merged = $state.raw(withHistory(flow.now, flow.hist));
  let buy = '';
  let sell = '';

  const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const time = (b: { time: number }) => (b.time / 1000) as UTCTimestamp;
  const toCandle = (b: Bar) => ({ time: time(b), open: b.open, high: b.high, low: b.low, close: b.close });
  let volUp = '';
  let volDown = '';
  const usdVol = (b: Bar) => `≈$${fmtCompact((b.volume * (b.high + b.low + b.close)) / 3)}`;
  const toVol = (b: Bar) => ({ time: time(b), value: b.volume, color: b.close >= b.open ? volUp : volDown });

  // Hyperliquid's volume palette in its theme (--vol-up/down); the other themes keep their candle colours at 40%.
  const volColours = () => [css('--vol-up') || css('--chart-up') + '66', css('--vol-down') || css('--chart-down') + '66'];
  const theme = () => ({ buy, sell, decimals });

  // The legend's rows: each study with its effective plot styles, price-pane ones under OHLC and own-pane ones at their pane's top.
  const rows = $derived(settings.chart.studies.filter((s) => !DEFS[s.type].data || !spot).map((s) => ({ s, def: DEFS[s.type], plots: DEFS[s.type].plots.map((_, n) => plotStyle(s, n)) })));
  const priceRows = $derived(rows.filter((r) => r.def.pane === 'price'));
  const studiesView = $derived(JSON.stringify(rows.map(({ s, plots }) => ({ id: s.id, type: s.type, inputs: s.inputs, plots: plots.map(({ on, color, width, style }) => ({ on, color, width, style })), hidden: !!s.hidden }))));
  function toggleFunding() {
    const funding = settings.chart.studies.filter((s) => s.type === 'Funding');
    if (fundingOn) funding.forEach((s) => removeStudy(s.id));
    else if (funding.length) toggleStudy(funding[0].id);
    else { const why = addStudy('Funding'); if (why) toast.error(why); }
  }
  const openStudy = (id: string) => (ui.overlay = { kind: 'study', id });
  const toggleIndicators = () => (ui.overlay = ui.overlay === 'indicators' ? null : 'indicators');
  const studyId = $derived.by(() => { const m = modal(); return m?.kind === 'study' ? m.id : null; });
  const hhmm = (t: number) => zoneFormats.clock.format(t);
  const stamp = (t: number) => {
    const parts = Object.fromEntries(zoneFormats.parts.formatToParts(t).map((part) => [part.type, part.value]));
    return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
  const when = (t: number) => (stamp(t).slice(0, 5) === stamp(Date.now()).slice(0, 5) ? hhmm(t) : stamp(t));
  const since = (t: number | null) => `since ${t === null ? hhmm(flow.now.start) : stamp(t)} ${timezone}${merged.gaps.length ? ` · gap ${when(merged.gaps.at(-1)!)}` : ''}`;
  const pair = (r: { from: number; to: number } | null) => (r ? `${r.from},${r.to}` : '');
  const px = (v: number) => fmtNum(v, decimals);

  let paneHeights = '';
  /** Test hooks, read a frame later so they see the range the chart has just drawn. Pane tops force a layout, so they are read only when a pane height or a pane's series changed. */
  function readRanges() {
    kickLines();
    requestAnimationFrame(() => {
      if (!chart) return;
      if (held && !pressedAt) leaveThird();
      const axis = chart.priceScale('right');
      const range = axis.getVisibleRange();
      priceRange = pair(range);
      autoOn = axis.options().autoScale;
      // By bar index, as scrollPosition counts from Ichimoku's forward points, past the last candle.
      away = (chart.timeScale().getVisibleLogicalRange()?.to ?? Infinity) < bars.length - 2 || !autoOn;
      timeRange = pair(chart.timeScale().getVisibleLogicalRange());
      const first = bars[Math.max(0, Math.floor(chart.timeScale().getVisibleLogicalRange()?.from ?? 0))];
      if (first) rateFrom = Math.min(rateFrom || Infinity, Math.floor(first.time / CHUNK) * CHUNK);
      pinAxes(chart);
      axisW = chart.priceScale('right').width();
      el.style.setProperty('--axis-w', `${axisW}px`);
      axisL = leftWidth(chart);
      priceH = chart.panes()[0].getHeight();
      const own = insts.filter((k) => k.def.pane === 'own');
      const heights = `${chart.panes().map((p) => p.getHeight())}|${own.map((k) => `${k.study.id}:${k.plots[0][0].getPane().paneIndex()}`)}`;
      if (heights === paneHeights) return;
      paneHeights = heights;
      const top = (s: { getPane(): { getHTMLElement(): HTMLElement | null } } | undefined) => s?.getPane().getHTMLElement()?.offsetTop ?? 0;
      paneTop = { volume: top(volume), ...Object.fromEntries(own.map((k) => [k.study.id, top(k.plots[0][0])])) };
    });
  }

  // A pick holds its own interval's bars; another interval's would be sent under its name.
  $effect(() => {
    if (annotationChat.pending && annotationChat.pending.interval !== settings.chart.interval) annotationChat.pending = null;
  });
  const flowAt = (f: 'cvd' | 'oid', t: number) => (f === 'cvd' ? merged.cvd.findLast((p) => p.time <= t) : merged.oid.find((p) => p.time === t))?.value ?? null;
  const collect = (sel: Selection) => collectSelection(sel, bars, insts.filter((k) => !k.study.hidden).flatMap((k) =>
    k.def.flow ? [{ name: k.def.short, at: (i: number) => flowAt(k.def.flow!, bars[i].time) }]
      : k.def.plots.flatMap((p, n) => (p.kind === 'arrows' || p.kind === 'points' || !plotStyle(k.study, n).on ? [] : [{ name: plotName(k.study, n), at: (i: number) => k.out.values[n]?.[i] }]))
  ));

  /** The bar under the crosshair, or the latest bar when the pointer is off the chart or past the last bar; a study plotted ahead (Ichimoku's leading spans) shows its point under the crosshair. */
  function showLegend() {
    const i = hoverTime === null ? bars.length - 1 : bars.findLastIndex((b) => b.time <= hoverTime!);
    const bar = bars[i];
    if (!bar) return void (legend = undefined);
    const vals: Record<string, string> = {};
    const cols: Record<string, string> = {};
    for (const k of insts) {
      if (k.def.flow) {
        const v = flowAt(k.def.flow, bar.time);
        if (v != null) vals[k.def.flow] = fmtCompact(v);
        continue;
      }
      const j = hoverTime !== null && hoverTime > bar.time ? (k.out.times?.findLastIndex((t) => t <= hoverTime!) ?? i) : i;
      k.out.values.forEach((v, n) => {
        if (v[j] == null) return;
        const key = `${k.study.id}-${n}`;
        vals[key] = fmtNum(v[j]!, k.def.digits ?? (k.def.pane === 'own' ? valueDigits(v[j]!, decimals) : decimals)) + (k.def.percent ? '%' : '');
        const c = k.out.colors?.[n]?.[j];
        const palette = plotStyle(k.study, n, theme()).palette;
        if (c != null && palette) cols[key] = palette[c].slice(0, 7);
      });
    }
    legend = { bar, vals, cols, focused: hoverTime !== null };
  }

  function onCrosshair(p: MouseEventParams) {
    hoverTime = p.point && p.time !== undefined ? (p.time as number) * 1000 : null;
    showLegend();
  }

  let resetShown = $state(false);
  // The library stores Reset's third as a bar offset, which new bars, forward study points and a width change all break.
  let held = false;
  let pressedAt: { from: number; to: number } | null = null;
  let autoOn = $state(true);
  let away = $state(false);
  $effect(() => {
    const press = (e: PointerEvent) => {
      resetShown = !!el?.contains(e.target as Node);
      if (resetShown) pressedAt = chart?.timeScale().getVisibleLogicalRange() ?? null;
    };
    // A tap leaves the view where it is, so only a press that moved it ends the hold.
    const release = () => {
      const now = chart?.timeScale().getVisibleLogicalRange();
      if (pressedAt && now && (Math.abs(now.from - pressedAt.from) > 0.5 || Math.abs(now.to - pressedAt.to) > 0.5)) held = false;
      pressedAt = null;
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
    };
  });

  /** Puts the last candle at 2/3 of the width, across that many bars when given; false before it has a place on the time scale. */
  function leaveThird(across = 0) {
    const ts = chart!.timeScale();
    const range = ts.getVisibleLogicalRange();
    const latest = bars.at(-1);
    const x = latest ? ts.timeToCoordinate((latest.time / 1000) as UTCTimestamp) : null;
    const last = x === null ? null : ts.coordinateToLogical(x);
    if (!range || last === null) return false;
    const span = across || range.to - range.from;
    const to = last + span / 3;
    if (Math.abs(to - range.to) > 0.5) ts.setVisibleLogicalRange({ from: to - span, to });
    return true;
  }

  function command(cmd: ChartCmd) {
    if (cmd === 'indicators') return void toggleIndicators();
    if (cmd === 'fullscreen') return void toggleFullscreen();
    const ts = chart!.timeScale();
    if (cmd === 'reset') {
      resetShown = false;
      chart!.priceScale('right').setAutoScale(true);
      // 6 px a bar is the zoom the chart opens at.
      held = leaveThird(ts.width() / 6);
      if (!held) ts.scrollToRealTime();
      return void readRanges();
    }
    held = false;
    resetShown = true;
    if (cmd === 'up' || cmd === 'down') {
      const axis = chart!.priceScale('right');
      const range = axis.getVisibleRange();
      if (!range) return;
      const delta = (range.to - range.from) * (cmd === 'up' ? 0.1 : -0.1);
      axis.setAutoScale(false);
      axis.setVisibleRange({ from: range.from + delta, to: range.to + delta });
      readRanges();
      return;
    }
    if (cmd === 'invert') return void (scale.invert = !scale.invert);
    if (cmd === 'log' || cmd === 'percent') return void (scale.mode = scale.mode === MODES[cmd] ? PriceScaleMode.Normal : MODES[cmd]);
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const span = r.to - r.from;
    const step = Math.max(1, Math.round(span / 10));
    if (cmd === 'zoomInBoth' || cmd === 'zoomOutBoth') {
      const axis = chart!.priceScale('right');
      const range = axis.getVisibleRange();
      if (!range || range.from >= range.to) return;
      let { from, to } = range;
      if (axis.options().mode === PriceScaleMode.Logarithmic) {
        // 5.2 reads prices but writes log units, with an adaptive offset kept while auto-scale is off.
        const log = (price: number) => Math.abs(price) < 1e-15 ? 0 : Math.sign(price) * (Math.log10(Math.abs(price) + 10 ** -logOffset) + logOffset);
        from = log(from);
        to = log(to);
      }
      const mid = (from + to) / 2;
      const factor = cmd === 'zoomInBoth' ? 0.8 : 1.25;
      const half = (to - from) / 2 * factor;
      axis.setAutoScale(false);
      axis.setVisibleRange({ from: mid - half, to: mid + half });
    }
    const moves = { back: [-step, -step], forward: [step, step], zoomIn: [span * 0.2, 0], zoomOut: [-span * 0.25, 0] };
    const [df, dt] = moves[cmd === 'zoomInBoth' ? 'zoomIn' : cmd === 'zoomOutBoth' ? 'zoomOut' : cmd];
    ts.setVisibleLogicalRange({ from: r.from + df, to: r.to + dt });
  }

  let picks = 0;
  const plotWidth = () => chart?.timeScale().width() || chartWidth;

  function showSpan(from: number, to: number, interval: Interval) {
    picks++;
    held = false;
    goal = { coin: market.coin, from: Math.floor(from), to: Math.ceil(to) };
    resetShown = true;
    if (interval === settings.chart.interval) reveal();
    else chooseInterval(interval);
  }

  async function pickRange(days: number) {
    const [coin, turn, now] = [market.coin, ++picks, Date.now()];
    let from = days ? now - days * 864e5 : zoned(`${today(timezone, now).slice(0, 4)}-01-01`, '00:00', timezone);
    if (days === Infinity) {
      const first = await candleSnapshot(coin, '1d', 0, now).catch((e) => (console.warn('market start not loaded', e), []));
      if (turn !== picks || coin !== market.coin) return;
      if (!first.length) return void toast.error('Could not load this market\'s history');
      from = first[0].time;
    }
    const span = now - from;
    showSpan(from, now + (narrow.current ? 0 : span * 0.03), rangeInterval(span, span, plotWidth()));
  }

  function goToTime(t: number) {
    const current = settings.chart.interval;
    const interval = reachInterval(current, Date.now() - t);
    const r = chart?.timeScale().getVisibleLogicalRange();
    const span = (r ? r.to - r.from : 120) * MS[interval];
    if (interval !== current) toast.info(`${ivLabel(current)} candles do not go back that far: showing ${ivLabel(interval)}`);
    showSpan(t - span / 3, t + span * 2 / 3, interval);
  }

  const goToRange = (from: number, to: number) => showSpan(from, to, rangeInterval(to - from, Date.now() - from, plotWidth(), settings.chart.interval));

  /** lightweight-charts pans price on a drag only while auto-scale is off, so a press in the price plot turns it off and a release that moved less than 4px vertically turns it back on. */
  function pressPlot(e: MouseEvent) {
    const ps = chart!.priceScale('right');
    const r = el.getBoundingClientRect();
    if (e.button !== 0 || e.clientX >= r.right - ps.width() || e.clientX < r.left + leftWidth(chart!) || e.clientY >= r.top + chart!.panes()[0].getHeight()) return;
    const wasAuto = ps.options().autoScale;
    ps.setAutoScale(false);
    const release = (u: MouseEvent) => {
      if (wasAuto && Math.abs(u.clientY - e.clientY) < 4) ps.setAutoScale(true);
      readRanges();
    };
    window.addEventListener('mouseup', release, { once: true });
  }

  /** full: setData on every study; otherwise only the last bar's values move. A null value draws nothing. */
  function draw(full: boolean) {
    const ctx = { bars, since: loadedFrom, step: MS[settings.chart.interval], rates: ratesOn ? fundingValues(rateCoin === market.coin ? rateHist : NO_RATES, bars, MS[settings.chart.interval]) : undefined };
    for (const k of insts) drawStudy(k, ctx, full, theme());
    // The price-pane lines that draw something, for tests.
    count = insts.reduce((n, k) => n + (k.def.pane === 'price' && !k.study.hidden ? k.def.plots.filter((p, j) => !p.kind && plotStyle(k.study, j).on && k.out.values[j]?.some((x) => x !== null)).length : 0), 0);
    barCount = bars.length;
    barsVersion = untrack(() => barsVersion) + 1;
    readRanges();
    showLegend();
  }

  function drawFlow(f: Flow, h: Hist) {
    const cvd = insts.find((k) => k.def.flow === 'cvd' && !k.study.hidden)?.plots[0][0];
    const oid = insts.find((k) => k.def.flow === 'oid' && !k.study.hidden)?.plots[0][0];
    if (!cvd && !oid) {
      cvdBars = oidBars = 0;
      return;
    }
    el.dataset.flowDraws = String(Number(el.dataset.flowDraws ?? 0) + 1);
    merged = withHistory(f, h);
    cvd?.setData(merged.cvd.map((p) => ({ time: time(p), value: p.value })));
    oid?.setData(merged.oid.map((p) => ({ time: time(p), value: p.value, color: p.value < 0 ? sell : buy })));
    cvdBars = cvd ? merged.cvd.length : 0;
    oidBars = oid ? merged.oid.length : 0;
    paneCount = chart?.panes().length ?? 1;
    readRanges();
    showLegend();
  }


  function addBar(b: Bar) {
    const last = bars.at(-1);
    if (last?.time === b.time) bars[bars.length - 1] = b;
    else bars.push(b);
  }

  // Live candle frames coalesce to one study update a frame, and none while the tab is hidden.
  let frame = 0;
  const drawSoon = () => (frame ||= requestAnimationFrame(() => ((frame = 0), draw(false))));
  let flowFrame = 0;
  const drawFlowSoon = () => {
    if (flowFrame || document.hidden || !chart || !insts.some((k) => k.def.flow && !k.study.hidden)) return;
    flowFrame = requestAnimationFrame(() => {
      flowFrame = 0;
      if (chart && !document.hidden) drawFlow(flow.now, flow.hist);
    });
  };

  const rightGap = () => (narrow.current ? 0 : 8);
  $effect(() => {
    const rightOffset = rightGap();
    untrack(() => chart?.applyOptions({ timeScale: { rightOffset } }));
  });
  // The coach is wide-screen only, and its demo lines must not outlive the panel that closes them.
  $effect(() => {
    if (noAi()) untrack(() => Object.assign(coach, { open: false, demo: null, error: '' }));
  });

  onMount(() => {
    [volUp, volDown] = volColours();
    buy = css('--buy');
    sell = css('--sell');
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { color: css('--panel') }, textColor: css('--chart-axis'), fontFamily: css('--mono'), fontSize: chartFont(), panes: { separatorColor: css('--gutter'), separatorHoverColor: css('--line') } },
      grid: { vertLines: { color: css('--gutter') }, horzLines: { color: css('--gutter') } },
      timeScale: { timeVisible: true, borderColor: css('--line'), rightOffset: rightGap(), minBarSpacing: 0.2 },
      rightPriceScale: { borderColor: css('--line'), entireTextOnly: true },
      crosshair: { mode: CrosshairMode.Normal }
    });
    crosshair = CrosshairMode[c.options().crosshair.mode];
    candles = c.addSeries(CandlestickSeries, { upColor: css('--chart-up'), downColor: css('--chart-down'), borderVisible: false, wickUpColor: css('--chart-up'), wickDownColor: css('--chart-down') });
    volume = c.addSeries(HistogramSeries, { priceScaleId: 'right', priceFormat: volumeAxis, lastValueVisible: true, priceLineVisible: false }, 1);
    volume.getPane().setStretchFactor(0.5);
    volume.priceScale().applyOptions({ visible: true, entireTextOnly: true, scaleMargins: { top: 0.2, bottom: 0 } });
    c.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    trackPriceRanges(c);
    c.timeScale().subscribeVisibleLogicalRangeChange(readRanges);
    c.timeScale().subscribeVisibleLogicalRangeChange((r) => r && older(r));
    c.subscribeCrosshairMove(onCrosshair);
    // CVD and OI delta panes have their own price scales; only the price pane's axis stretches.
    const inStrip = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return e.clientX >= r.right - c.priceScale('right').width() && e.clientY < r.bottom - c.timeScale().height();
    };
    const onAxis = (e: MouseEvent) => inStrip(e) && e.clientY < el.getBoundingClientRect().top + c.panes()[0].getHeight();
    // Capture phase on the container, so lightweight-charts' own wheel listener (time zoom) never sees an axis wheel, in any pane.
    el.addEventListener('wheel', (e) => {
      // Line labels and the legends sit beside lightweight-charts' own element, so their wheel is handed over as a time zoom.
      if ((e.target as Element).closest('.rows, .annotation-chat, .copilot, .legends.all')) return;
      if ((e.target as Element).closest('.tag, .legends')) return void (e.preventDefault(), e.stopPropagation(), c.chartElement().dispatchEvent(new WheelEvent('wheel', e)));
      if (!inStrip(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!onAxis(e)) return;
      const r = c.priceScale('right').getVisibleRange();
      if (!r) return;
      // A mouse notch is one step; a trackpad's small pixel deltas scale in proportion.
      const notch = e.deltaMode ? Math.sign(e.deltaY) : Math.max(-1, Math.min(1, e.deltaY / 100));
      if (!notch) return;
      const mid = (r.from + r.to) / 2;
      const half = ((r.to - r.from) / 2) * 1.1 ** notch;
      c.priceScale('right').setVisibleRange({ from: mid - half, to: mid + half });
      readRanges();
    }, { capture: true, passive: false });
    const tools = chartTools(c, candles, el, () => bars, () => MS[settings.chart.interval], () => legendH + 4);
    const lines = positionLines(candles, el, () => c.timeScale().logicalToCoordinate((bars.length - 24) as Logical), () => leftWidth(c), () => legendH + 4);
    const offCompare = compareLines(c, candles, () => bars, el, readRanges);
    const offAi = aiMarks(candles, el, () => market.coin, () => leftWidth(c), (t) => c.timeScale().logicalToCoordinate(timeToLogical(bars.map((b) => b.time), t, MS[settings.chart.interval]) as Logical), () => c.timeScale().options().barSpacing / 2, () => legendH + 4);
    const offDemo = demoLevels(candles, () => market.coin, readRanges);
    const offFills = fillMarkers(c, candles, el);
    kickLines = lines.kick;
    // lightweight-charts drops its crosshair while the pointer is over a label, so it is set from the pointer there; set this way it fires no crosshair move.
    el.addEventListener('mousemove', (e) => {
      const on = e.target as Element;
      if (!on.closest('.tag') || on.closest('.rows') || e.buttons || !bars.length) return;
      const r = el.getBoundingClientRect();
      const y = e.clientY - r.top;
      const price = candles.coordinateToPrice(y);
      if (price === null || y >= c.panes()[0].getHeight()) return;
      const t = c.timeScale().coordinateToTime(e.clientX - r.left - leftWidth(c)) ?? time(bars.at(-1)!);
      c.setCrosshairPosition(price, t, candles);
      hoverTime = timeMs(t);
      showLegend();
    });
    el.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget as Element | null;
      if (!(e.target as Element).closest('.tag') || to?.closest('.tag') || c.chartElement().contains(to)) return;
      c.clearCrosshairPosition();
      hoverTime = null;
      showLegend();
    });
    // Capture phase, so a press the tools or an order drag claim (an armed tool, a Shift+drag measure, a drawing, then an order label or line) never reaches lightweight-charts' pan.
    const claim = (e: MouseEvent) => tools.down(e) || lines.grab(e);
    el.addEventListener('mousedown', (e) => {
      const on = e.target as Element;
      if (on.closest('button, input, textarea, .annotation-chat, .copilot')) return;
      if (claim(e)) return void ((document.activeElement as HTMLElement | null)?.blur(), e.preventDefault(), e.stopPropagation());
      if (!on.closest('.tag')) pressPlot(e);
    }, true);
    const autoscale = () => (c.priceScale('right').setAutoScale(true), readRanges());
    el.addEventListener('dblclick', (e) => {
      if ((e.target as Element).closest('.annotation-chat, .copilot')) return;
      if (onAxis(e)) autoscale();
    });
    // Touch has no reliable dblclick: two taps within 300 ms and 30 px, each moving under 10 px, reset the price axis or, on the plot, toggle fullscreen.
    let press = { x: 0, y: 0 }, tap = { t: 0, x: 0, y: 0 };
    // A second finger voids the first one's tap, so a pinch is never half of a double tap.
    el.addEventListener('pointerdown', (e) => void (press = e.isPrimary ? { x: e.clientX, y: e.clientY } : { x: Infinity, y: Infinity }));
    el.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'touch' || !e.isPrimary || drawings.tool || (e.target as Element).closest('button, input, textarea, .tag, .legends, .annotation-chat')) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= 10) return void (tap.t = 0);
      const second = e.timeStamp - tap.t < 300 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 30;
      tap = second ? { t: 0, x: 0, y: 0 } : { t: e.timeStamp, x: e.clientX, y: e.clientY };
      if (second) void (onAxis(e) ? autoscale() : toggleFullscreen());
    });
    chart = c;
    active = command;
    el.addEventListener('pointerup', readRanges);
    el.addEventListener('wheel', () => (held = false), { capture: true, passive: true });
    void document.fonts.ready.then(() => { pinned = ''; readRanges(); });
    const resized = new ResizeObserver(readRanges);
    resized.observe(el);
    const wakeFlow = () => { if (!document.hidden) drawFlowSoon(); };
    document.addEventListener('visibilitychange', wakeFlow);
    return () => {
      document.removeEventListener('visibilitychange', wakeFlow);
      cancelAnimationFrame(flowFrame);
      flowFrame = 0;
      resized.disconnect();
      tools.destroy();
      lines.off();
      offCompare();
      offAi();
      offDemo();
      offFills();
      kickLines = () => {};
      active = undefined;
      chart = undefined;
      c.remove();
    };
  });

  $effect(() => {
    const ps = chart?.priceScale('right');
    if (!ps) return;
    ps.applyOptions({ mode: scale.mode, invertScale: scale.invert });
    applied = { mode: PriceScaleMode[ps.options().mode], invert: ps.options().invertScale };
    readRanges();
  });

  $effect(() => {
    const c = chart;
    const p = positionOf(market.coin);
    const gain = p && market.ctx?.markPx ? (market.ctx.markPx - p.entryPx) * Math.sign(p.szi) : p?.uPnl;
    const shown = settings.chart.indicators.positions.on;
    void settings.display.theme;
    if (!c) return;
    untrack(() => {
      const color = shown && p?.szi && gain ? css(gain > 0 ? '--buy' : '--sell') : '';
      candles.applyOptions({ priceLineColor: color });
      el.dataset.currentPriceColor = color;
    });
  });

  $effect(() => {
    settings.display.theme;
    const c = chart;
    if (!c) return;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || chart !== c) return;
      buy = css('--buy');
      sell = css('--sell');
      [volUp, volDown] = volColours();
      const range = c.timeScale().getVisibleLogicalRange();
      c.applyOptions({
        layout: { background: { color: css('--panel') }, textColor: css('--chart-axis'), fontFamily: css('--mono'), panes: { separatorColor: css('--gutter'), separatorHoverColor: css('--line') } },
        grid: { vertLines: { color: css('--gutter') }, horzLines: { color: css('--gutter') } },
        timeScale: { borderColor: css('--line') },
        rightPriceScale: { borderColor: css('--line') }
      });
      candles.applyOptions({ upColor: css('--chart-up'), downColor: css('--chart-down'), wickUpColor: css('--chart-up'), wickDownColor: css('--chart-down') });
      volume.setData(bars.map(toVol));
      insts.forEach((k) => styleStudy(k, theme()));
      draw(true);
      drawFlow(flow.now, flow.hist);
      if (range) c.timeScale().setVisibleLogicalRange(range);
      readRanges();
    });
    return () => { cancelled = true; };
  });

  $effect(() => {
    const formats = zoneFormats;
    chart?.applyOptions({
      localization: { timeFormatter: (value: Time) => formats.full.format(timeMs(value)) },
      timeScale: { tickMarkFormatter: (value: Time, type: TickMarkType) => {
        const at = timeMs(value);
        if (type === TickMarkType.Year) return formats.year.format(at);
        if (type === TickMarkType.Month) return formats.month.format(at);
        if (type === TickMarkType.DayOfMonth) return formats.day.format(at);
        return (type === TickMarkType.TimeWithSeconds ? formats.seconds : formats.clock).format(at);
      } }
    });
  });

  $effect(() => {
    const fontSize = chartFont();
    if (!chart) return;
    chart.applyOptions({ layout: { fontSize } });
    el.dataset.font = String(chart.options().layout.fontSize);
    // lightweight-charts reserves 5px plus 5/12 of the font outside its axis labels; whole pixels, as label placing reads the rounded clientWidth.
    el.style.setProperty('--axis-trim', `${Math.floor(5 + fontSize * 5 / 12)}px`);
  });

  // A new list (a study added, removed or moved) rebuilds the series in list order, each removed series taking its now-empty pane with it;
  // own panes get a stretch factor of 0.5 against the price pane's 2, the spec's 1 : 0.25. Inputs, styles and the eye keep the series and redraw them.
  $effect(() => {
    const c = chart;
    if (!c) return;
    const want = ($state.snapshot(settings.chart.studies) as Study[]).filter((s) => !DEFS[s.type].data || !spot);
    untrack(() => {
      if (want.map((s) => s.id + s.type).join() !== insts.map((k) => k.study.id + k.study.type).join()) {
        removeStudies(c, insts);
        insts = buildStudies(c, want, theme());
        trackPriceRanges(c);
      } else insts.forEach((k, i) => ((k.study = want[i]), styleStudy(k, theme())));
      draw(true);
      drawFlow(flow.now, flow.hist);
    });
  });

  $effect(() => {
    void flow.now;
    void flow.hist;
    if (chart) untrack(drawFlowSoon);
  });

  $effect(() => {
    const coin = market.coin;
    void rateMinute;
    if (!fundingOn) return;
    let live = true;
    untrack(() => {
      prediction = [];
      predictionNote = 'Loading funding estimates…';
      predictedFunding(coin).then((rows) => {
        if (!live) return;
        prediction = rows;
        predictionNote = rows.length ? '' : coin.includes(':') ? 'Not published for HIP-3 perps' : 'Not published for this coin';
      }, (e) => {
        if (live) predictionNote = 'Funding estimates unavailable';
        console.warn('predicted funding not loaded', e);
      });
    });
    return () => { live = false; };
  });

  let heal = () => {};
  let older = (_: { from: number }) => {};
  let goal: { coin: string; from: number; to: number } | null = null;
  let reveal = () => {};
  $effect(() => {
    if (socket.reconnects) untrack(heal);
  });

  $effect(() => {
    const c = chart;
    if (!c) return;
    const coin = market.coin;
    const interval = settings.chart.interval;
    // snapshot/subscribe read reactive socket and meta state; only coin and interval may re-run this.
    return untrack(() => {
      // Live bars of the new interval/coin may be older than the last bar shown; update() would throw.
      candles.setData([]);
      volume.setData([]);
      held = false;
      if (narrow.current) c.timeScale().scrollToPosition(0, false);
      bars = [];
      rateFrom = 0;
      rateHist = NO_RATES;
      rateCoin = '';
      rateStatus = '';
      empty = false;
      draw(true);
      c.priceScale('right').setAutoScale(true);
      let live = true;
      let tries = 0;
      let start = 0;
      let loadingOlder = false;
      let exhausted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      retrying = false;
      const retry = (e: unknown) => {
        if (!live) return;
        if (!tries && !rateLimited(e)) toast.error('chart data failed to load — retrying');
        retrying = true;
        timer = setTimeout(wake, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
      };
      const wake = () => (document.hidden ? document.addEventListener('visibilitychange', wake, { once: true }) : load());
      const load = () => {
        start = loadedFrom = snapshotFrom(interval, Date.now());
        chartCandles(coin, interval, start).then(show, retry);
      };
      const show = (snap: Bar[]) => {
        if (!live) return;
        retrying = false;
        if (!snap.length) return void ((goal = null), (empty = true));
        const d = pxDecimals(snap[snap.length - 1].close, meta.byName.get(coin)?.szDecimals ?? 0, meta.byName.get(coin)?.spot);
        decimals = d;
        candles.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: 10 ** -d } });
        insts.forEach((k) => styleStudy(k, theme()));
        candles.setData(snap.map(toCandle));
        volume.setData(snap.map(toVol));
        bars = snap;
        draw(true);
        reveal();
      };
      load();
      // Bars the live feed missed while the socket was down, asked again from the newest bar a snapshot answered; live bars since stay.
      heal = () => {
        if (!bars.length) return;
        chartCandles(coin, interval, start).then((snap) => {
          if (live && snap.length) show([...bars.filter((b) => b.time < snap[0].time), ...snap, ...bars.filter((b) => b.time > snap.at(-1)!.time)]);
        }, (e) => console.warn('candles after a reconnect not loaded', e));
      };
      const more = (from: number) => {
        loadingOlder = true;
        candleSnapshot(coin, interval, from, bars[0].time - 1).then((snap) => {
          if (!live) return;
          loadingOlder = false;
          const add = snap.filter((b) => b.time < bars[0].time);
          if (!add.length) {
            exhausted = true;
            return reveal();
          }
          const view = c.timeScale().getVisibleLogicalRange();
          bars = [...add, ...bars];
          loadedFrom = Math.min(loadedFrom, from);
          candles.setData(bars.map(toCandle));
          volume.setData(bars.map(toVol));
          if (view) c.timeScale().setVisibleLogicalRange({ from: view.from + add.length, to: view.to + add.length });
          draw(true);
          reveal();
        }, (e) => {
          console.warn('older candles not loaded', e);
          if (!live) return;
          if (goal) toast.error('Could not load candles for that date');
          goal = null;
          setTimeout(() => {
            loadingOlder = false;
            if (live) reveal();
          }, 5000);
        });
      };
      // A view scrolled near the oldest bar asks for the 500 before it; an empty answer means the market has none older.
      older = (r) => {
        if (r.from >= 30 || loadingOlder || exhausted || !bars.length) return;
        more(bars[0].time - 500 * MS[interval]);
      };
      // Runs after each load: a date older than the bars held loads back to it first, and a market younger than the date starts at its first bar.
      reveal = () => {
        if (goal && (empty || goal.coin !== coin)) goal = null;
        if (!goal || loadingOlder || !bars.length) return;
        if (bars[0].time > goal.from && !exhausted) return more(Math.max(0, goal.from - 40 * MS[interval]));
        const times = bars.map((b) => b.time);
        const from = Math.max(0, timeToLogical(times, goal.from, MS[interval]));
        const to = Math.max(from + (goal.to - goal.from) / MS[interval], timeToLogical(times, goal.to, MS[interval]));
        goal = null;
        c.priceScale('right').setAutoScale(true);
        c.timeScale().setVisibleLogicalRange({ from, to });
      };
      const off = watchCandles(coin, interval, (b) => {
        // A late frame for an older bar: update() would throw on it.
        if (!live || b.time < (bars.at(-1)?.time ?? 0)) return;
        candles.update(toCandle(b));
        volume.update(toVol(b));
        addBar(b);
        keepCandles(coin, interval, bars);
        drawSoon();
      });
      return () => {
        live = false;
        cancelAnimationFrame(frame);
        frame = 0;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', wake);
        off();
      };
    });
  });

  // After the candle effect, so a coin or interval change has reset rateFrom before this asks for the new coin's history.
  $effect(() => {
    const coin = market.coin;
    const from = rateFrom;
    void rateHour;
    if (!chart || !ratesOn || !from) return;
    let live = true;
    untrack(() => {
      if (rateCoin !== coin) rateStatus = 'loading…';
      fundingHistory(coin, from).then((hist) => {
        if (!live) return;
        const oldest = oldestChunk(Date.now());
        [rateHist, rateCoin, rateStatus] = [hist, coin, !hist.rows.length ? 'No funding history' : from < oldest ? `from ${new Date(oldest).toISOString().slice(0, 10)}` : ''];
        draw(true);
      }, (e) => {
        if (live) rateStatus = 'History unavailable; retried next hour';
        console.warn('funding history not loaded', coin, e);
      });
    });
    return () => { live = false; };
  });
</script>

<svelte:window onkeydown={(e) => { if (focused && !ui.overlay && e.key === 'Escape') focused = false; }} onpointerdown={(e) => railMore && !(e.target as Element).closest?.('.more') && (railMore = false)} />

{#snippet railButton(it: RailItem)}
  <button class:on={it.on} class:off={it.off} aria-disabled={it.off} data-testid={it.id} title={it.title} aria-label={it.label} onclick={(e) => (e.currentTarget.blur(), (railMore = false), it.act())}>{@render icon(it.d)}</button>
{/snippet}
{#snippet moreTools()}
  <div class="more">
    <button class:on={railMore || railItems.slice(railFit).some((it) => it.on)} data-testid="rail-more" title="More drawing tools" aria-label="More drawing tools" aria-expanded={railMore} onclick={(e) => (e.currentTarget.blur(), (railMore = !railMore))}>⋯</button>
    {#if railMore}<div class="rail-menu" data-testid="rail-menu">{#each railItems.slice(railFit) as it (it.id)}{@render railButton(it)}{/each}</div>{/if}
  </div>
{/snippet}
{#snippet sortHead(key: keyof typeof SORTS, label: string, title = '')}
  {@const dir = groupSort?.key === key ? groupSort.dir : 0}
  <span class="sort" class:sorted={dir} role="button" tabindex="0" data-testid="group-sort-{key}" title={`${title ? title + ' ' : ''}Click to sort; a third click restores fill order.`} aria-label="Sort by {label}" onclick={() => cycleSort(key)} onkeydown={(e) => e.key === 'Enter' && cycleSort(key)}>{label}{dir ? (dir < 0 ? ' ▾' : ' ▴') : ''}</span>
{/snippet}
{#snippet groupRows(g: (typeof lineLabels.groups)[number])}
  <div class="group-heading"><span>#</span>{@render sortHead('px', 'Price')}{@render sortHead('sz', 'Size')}{@render sortHead('pnl', 'Fill effect', 'PnL is what the fill closes, in price order, against the current entry, before fees.')}{@render sortHead('pos', 'Σ position')}<span></span></div>
  {#each sortRows(g.rows) as { r, n } (r.key)}
    <div class="row" class:through={groupThrough !== null && n <= groupThrough} class:under={r.under} class:opening={r.phase !== 'close'} role="row" tabindex="0" onpointerenter={() => (groupThrough = n)} onpointerleave={() => (groupThrough = null)} onfocus={() => (groupThrough = n)} onblur={() => (groupThrough = null)} data-phase={r.phase} data-position={r.projected} data-testid="group-row" data-oid={r.o.oid}>
      <span class="n">{n + 1}</span>{' '}{#each r.cells as c, i}<span class:price={i === 0} class:detail={i === 2} data-testid={i === 2 ? 'group-effect' : undefined}>{#if i === 2}{#if c}<span class="transition">{c}</span>{/if}{#if r.pnl !== undefined}{#if c}<span class="effect-separator">{' · '}</span>{/if}<b class="pnl" class:buy={r.pnl > 0} class:sell={r.pnl < 0}>{signed(r.pnl)}</b>{/if}{:else}{c}{/if}</span>{' '}{/each}
      <span class="cumulative" data-testid="group-cumulative" title="Your position if every order on this side fills, in price order, through this row."><b class:buy={r.projected > 0} class:sell={r.projected < 0}>{#if r.projected === 0}Flat{:else}<span>{r.projected > 0 ? 'Long' : 'Short'}</span>{' '}<span>{fmtSz(Math.abs(r.projected), meta.byName.get(market.coin)?.szDecimals)}</span>{/if}</b></span>
      {#if r.x}
        {@const o = r.o}
        <button class="x" data-testid="group-cancel" data-oid={o.oid} disabled={r.busy} title="Cancel this order" aria-label="Cancel {o.coin} order {o.oid}" onclick={(e) => (e.currentTarget.blur(), cancelLine(o))}>✕</button>
      {:else}<span></span>{/if}
    </div>
  {/each}
  {@const through = groupThrough !== null && groupThrough < g.rows.length - 1 ? groupThrough : null}
  {@const part = through === null ? g.rows : g.rows.slice(0, through + 1)}
  {@const scope = through === null ? 'Total' : `Through #${through + 1}`}
  {@const gain = part.reduce((sum, r) => sum + (r.pnl ?? 0), 0)}
  {@const filled = part.reduce((sum, r) => sum + r.filled, 0)}
  <div class="group-totals" data-testid="group-totals" data-through={through === null ? undefined : through + 1} title="Totals for this group in price order, after earlier orders on the same side. Point at or focus a row to total through that row. Filled size respects reduce-only limits. Gain is realized PnL before fees; fills are not guaranteed.">
    <span>{scope} gain <b class="pnl" class:buy={gain > 0} class:sell={gain < 0} data-testid="group-total-gain" title={`${fmtNum(gain, 2)} USD before fees`}>{signed(gain)}</b></span>
    <span>{scope} filled <b data-testid="group-total-filled">{fmtSz(filled, meta.byName.get(market.coin)?.szDecimals)} {nameOf(market.coin)}</b></span>
  </div>
{/snippet}
{#snippet icon(d: string)}<svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true"><path {d} fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>{/snippet}
{#snippet studyRow(r: (typeof rows)[number])}
  {@const flowKey = r.def.flow}
  <div class="ind study" class:off={r.s.hidden} class:rates={!!r.def.data} data-testid="legend-study" data-id={r.s.id} data-type={r.s.type} role="group" aria-label={r.s.type} ondblclick={() => !flowKey && openStudy(r.s.id)}>
    {#if flowKey}
      <span data-testid="legend-{flowKey}">{r.def.short} {since(merged.first[flowKey])}</span>
      {#if !r.s.hidden}<b class="val" data-testid="value-{flowKey}">{legend?.vals[flowKey] ?? ''}</b>{/if}
      {#if merged.first[flowKey] === null && flow.hist.status !== 'loading'}<span class="hist" data-testid="hist-{flowKey}" title={flow.hist.note || 'not recorded for this coin'}>live only</span>{/if}
    {:else}
      <span class="name">{r.def.short}</span>
      {#if r.def.inputs.length && !r.def.data}<button class="inputs" data-testid="legend-inputs" title="{r.s.type} settings" onclick={(e) => (e.currentTarget.blur(), openStudy(r.s.id))}>{inputsText(r.s)}</button>{/if}
      {#if r.def.data}<span class="hist" data-testid="rate-status">{rateStatus}</span>{/if}
      {#if !r.s.hidden}
        {#each r.def.plots as p, n}
          {#if r.plots[n].on}<b class="val" style:color={legend?.cols[`${r.s.id}-${n}`] || r.plots[n].color.slice(0, 7)} data-testid="value-{r.s.id}-{n}" title={p.title}>{legend?.vals[`${r.s.id}-${n}`] ?? '∅'}</b>{/if}
        {/each}
        {#if r.def.data && r.s.inputs.live !== 'Hide'}<span class="hist" data-testid="rate-live">Live {pctRate(r.def.data === 'funding' ? market.ctx?.funding : livePremium)}{r.def.data === 'funding' ? '/h' : ''}</span>{/if}
        {#if r.def.data === 'funding'}
          <details class="prediction" data-testid="funding-predicted">
            <summary title={predictionNote || predictedText}>Venue funding</summary>
            <div {@attach fitFunding}>
              <strong>Current estimate for next funding</strong>
              <span class="explain">Estimates can change before payment. Positive rates mean longs pay shorts. The chart shows settled Hyperliquid payments; Live is its current hourly rate.</span>
              {#if predictionNote}<span>{predictionNote}</span>
              {:else}
                <table aria-label="Venue funding estimates"><thead><tr><th>Venue</th><th>Rate / interval</th><th>Next payment</th></tr></thead><tbody>
                  {#each venueFunding as v (v.id)}
                    <tr data-testid="funding-venue-{v.id}"><td>{v.name}</td><td>{#if v.rate && !v.expired}<b>{pctRate(v.rate.rate)}</b><small>{v.rate.hours ? `per ${v.rate.hours}h` : 'Interval not published'}</small>{:else}{v.expired ? 'Awaiting update' : 'Not published'}{/if}</td><td>{#if v.rate?.nextTime && !v.expired}<time datetime={new Date(v.rate.nextTime).toISOString()}>{zoneFormats.full.format(v.rate.nextTime)}</time>{:else}—{/if}</td></tr>
                  {/each}
                </tbody></table>
              {/if}
              <span class="explain">Source: Hyperliquid predicted funding feed. Refreshed every minute.{#if predictionFetched}{' '}Fetched {zoneFormats.full.format(predictionFetched)}.{/if}</span>
            </div>
          </details>
        {/if}
      {/if}
    {/if}
    <span class="acts">
      <button data-testid="legend-eye" title={r.s.hidden ? 'Show' : 'Hide'} aria-label="{r.s.hidden ? 'Show' : 'Hide'} {r.s.type}" aria-pressed={!!r.s.hidden} onclick={(e) => (e.currentTarget.blur(), toggleStudy(r.s.id))}>{@render icon(r.s.hidden ? 'M2 9s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5zM3 15 15 3' : 'M2 9s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5zm7 2.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z')}</button>
      {#if !flowKey}<button data-testid="legend-settings" title="Settings" aria-label="{r.s.type} settings" onclick={(e) => (e.currentTarget.blur(), openStudy(r.s.id))}>{@render icon('M9 2.5 14.6 5.7v6.6L9 15.5l-5.6-3.2V5.7zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z')}</button>{/if}
      <button data-testid="legend-remove" title="Remove" aria-label="Remove {r.s.type}" onclick={(e) => (e.currentTarget.blur(), removeStudy(r.s.id))}>{@render icon('M3.5 5h11M7 5V3.5h4V5m-6 0 .7 9.5h6.6L13 5M7.8 7.5v5M10.2 7.5v5')}</button>
    </span>
  </div>
{/snippet}
<div class="wrap" bind:this={wrapper} class:fullscreen class:compact data-testid="chart" data-timezone={timezone} data-legend-time={legend?.bar.time ?? ''} data-crosshair={crosshair} data-scale-mode={applied.mode} data-invert={applied.invert} data-series={count} data-bars={barCount} data-price-range={priceRange} data-time-range={timeRange} data-panes={paneCount} data-cvd-bars={cvdBars} data-oid-bars={oidBars} data-flow-since={flow.now.start} data-flow-hist={flow.hist.status} data-hist-bars={flow.hist.bars.length} data-cvd-first={merged.cvd[0]?.time ?? ''} data-flow-gaps={merged.gaps.length} data-measure={measure.shown} data-studies={studiesView} data-drawings={JSON.stringify(drawings.list)} data-drawings-on={settings.chart.indicators.drawings.on} data-tool={drawings.tool ?? ''} data-selected={drawings.sel ?? ''} data-ask={annotationChat.pending?.type ?? ''} data-demo-levels={coach.lines} data-ai-marks={JSON.stringify(aiView.marks.map(({ type, label, a, b }) => ({ type, label, a, b })))}>
  <div class="intervals" class:mobile-intervals={mobileIv.current} {@attach fitPinnedIntervals}>
    {#if fullscreen}<button class="chart-coin" data-testid="chart-coin" aria-label="Markets" onclick={(e) => (e.currentTarget.blur(), (ui.overlay = 'picker'))}><Coin coin={market.coin} quote="" /></button>{/if}
    {#each pinnedIntervals as i, index (i)}
      <button class="iv" class:overflow={!mobileIv.current && index >= pinCapacity} class:mobile-pin={mobileIv.current} class:on={settings.chart.interval === i} aria-hidden={!mobileIv.current && index >= pinCapacity ? true : undefined} aria-pressed={settings.chart.interval === i} data-testid={`timeframe-pin-${i}`} onclick={(e) => (chooseInterval(i), e.currentTarget.blur())}>{ivLabel(i)}</button>
    {/each}
    <span class="iv-menu" class:more={!compact && !mobileIv.current} class:on={!compact && !mobileIv.current && !inlineIv}><Menu value={settings.chart.interval} text={compact || mobileIv.current ? ivLabel(settings.chart.interval) : inlineIv ? 'More intervals' : `Interval ${ivLabel(settings.chart.interval)}`} options={ALL_INTERVALS.map((i) => ({ value: i, label: ivName(i), group: ivGroup(i), testid: `interval-${i}`, pinned: pinnedIntervals.includes(i), pinDisabled: mobileIv.current && pinnedIntervals.length >= 9 && !pinnedIntervals.includes(i) }))} onpick={(i) => chooseInterval(i as Interval)} onpin={(i) => pinInterval(i as Interval)} pinHint={mobileIv.current ? `Pin up to 9 timeframes (${pinnedIntervals.length}/9)` : 'Pinned timeframes appear as space allows'} testid="interval-menu" align="left" ariaLabel="Interval" dropdown /></span>
    <span class="tools">
      <button data-testid="compare-button" title="Compare markets on the left axis (up to 5)" aria-label={compact && room < 22.2 * settings.display.fs ? 'Compare' : null} onclick={(e) => (e.currentTarget.blur(), (ui.overlay = 'compare'))}>{compact && room < 22.2 * settings.display.fs ? '⇄' : 'Compare'}{compared().length ? ` ${compared().length}` : ''}</button>
      {#if !narrow.current && !fullscreen}<button data-testid="chart-add" disabled={settings.chart.panes.length >= MAX_PANES} title={settings.chart.panes.length >= MAX_PANES ? `At most ${MAX_PANES} extra charts` : `Open another chart beside this one (${nameOf(market.coin)}, another interval); ⇄ on it swaps it with this chart`} aria-label="Add a chart" onclick={(e) => (e.currentTarget.blur(), addPane())}>＋</button>{/if}
      <button data-testid="chart-indicators" aria-haspopup="dialog" aria-expanded={ui.overlay === 'indicators'} aria-label={compact && room < 19.3 * settings.display.fs ? 'Indicators' : null} title="Indicators ({keys('indicators')})" onclick={(e) => (e.currentTarget.blur(), toggleIndicators())}>{compact && room < 19.3 * settings.display.fs ? 'ƒx' : 'ƒx Indicators'}</button>
      <button data-testid="chart-funding-toggle" class:on={fundingOn} aria-label="Funding history" aria-pressed={fundingOn} disabled={spot} title={spot ? 'Funding is available on perpetual markets only' : 'Show hourly funding history and live rates'} onclick={(e) => (e.currentTarget.blur(), toggleFunding())}>{compact ? 'FR' : 'Funding'}</button>
    </span>
    <button class="ui-tab zen-toggle" class:on={inZen()} aria-pressed={inZen()} disabled={!session.master} data-testid="zen-toggle" title={session.master ? `Chart-only view (${keys('zen')}, Esc exits)` : 'Connect a wallet to use Zen Mode'} onclick={(e) => { if (e.detail) e.currentTarget.blur(); setZen(!inZen()); }}>Zen Mode</button>
  </div>
  {#if coach.open && !narrow.current}{#await loadCoach() then Coach}{#if Coach}<Coach bars={coachBars} interval={settings.chart.interval} />{/if}{/await}{/if}
  <div class="rail" role="toolbar" aria-orientation="vertical" aria-label="Drawing tools" data-testid="chart-rail" bind:clientHeight={railH}>
    {#each railItems.slice(0, railFit) as it (it.id)}
      {@render railButton(it)}
      {#if it.sep && railFit === railItems.length}<hr />{/if}
    {/each}
    {#if railFit > 0 && railFit < railItems.length}{@render moreTools()}{/if}
  </div>
  <div class="chart" bind:this={el} bind:clientWidth={chartWidth} style:--cw={dock.w ? `${dock.w}px` : null} style:--ch={dock.h ? `${dock.h}px` : null} onwheelcapture={() => (resetShown = true)}>
    <div class="chart-refresh" class:shown={resetShown || away} style:top="{priceH - 28}px" style:left="{axisL + (chartWidth - axisL - axisW) / 2}px">      <button data-testid="chart-reset" title="Reset chart: auto-scale, default zoom, one-third blank space ({keys('chartReset')})" aria-label="Reset chart" onclick={(e) => (e.currentTarget.blur(), command('reset'))}>⟲</button>
</div>
    {#if retrying}<div class="retrying" data-testid="chart-retrying">retrying…</div>
    {:else if empty || !barCount}<div class="retrying" data-testid="chart-status">{empty ? `No candles for ${nameOf(market.coin)} ${ivLabel(settings.chart.interval)} yet` : `Loading ${nameOf(market.coin)} ${ivLabel(settings.chart.interval)}…`}</div>{/if}
    {#if fillHover.at}
      {@const d = meta.byName.get(market.coin)?.szDecimals}
      {@const right = fillHover.at.x > chartWidth / 2}
      <div class="fill-card" data-testid="fill-card" style:top="{fillHover.at.y + 14}px" style:left={right ? null : `${fillHover.at.x + 14}px`} style:right={right ? `${chartWidth - fillHover.at.x + 14}px` : null}>
        {#each fillHover.fills.slice(0, 8) as f (`${f.tid}:${f.oid}`)}
          <span class="dim">{zoneFormats.seconds.format(f.time)}</span><span class:buy={f.side === 'B'} class:sell={f.side === 'A'}>{f.side === 'B' ? 'Buy' : 'Sell'}</span><span>{fmtSz(f.sz, d)}</span><span>@ {fmtPx(f.px, d ?? 0, isSpot(f.coin))}</span>
        {/each}
        {#if fillHover.fills.length > 8}<span class="more dim">+{fillHover.fills.length - 8} more · {fillHover.fills.length} fills</span>{/if}
      </div>
    {/if}
    {#if legend}
      {@const b = legend.bar}
      {@const sp = legendOpen ? ' ' : ''}
      {@const hidden = priceRows.length + compareView.rows.length + (aiView.bias.length ? 1 : 0)}
      <div class="legends" class:all={legendAll} bind:this={legendBox} bind:clientHeight={legendH} style:max-height={legendAll ? `${legendRoom}px` : null} style:left="{axisL + 8}px" style:right="{axisW + 8}px">
        <div class="ohlc" class:down={b.close < b.open} class:short={!legendOpen} class:idle={!legendOpen && !legend.focused} data-testid="chart-legend" data-time={b.time}>
          <button class="fold" data-testid="legend-toggle" aria-expanded={legendOpen} title={legendOpen ? 'Collapse legend' : 'Expand legend'} onclick={(e) => (e.currentTarget.blur(), legendOpen && cut && !legendAll ? (legendAll = true) : ((legendOpen = !legendOpen), (legendAll = false)))}>{legendOpen ? `▾${cut ? ` +${cut}` : ''}` : `▸${hidden ? ` +${hidden}` : ''}`}</button>
          {#if legendOpen}<span>{nameOf(market.coin)} · {ivLabel(settings.chart.interval)}</span>{/if}
          <span>O{sp}<b>{px(b.open)}</b></span>
          <span>H{sp}<b>{px(b.high)}</b></span>
          <span>L{sp}<b>{px(b.low)}</b></span>
          <span>C{sp}<b data-testid="legend-close">{px(b.close)}</b></span>
          <b>{#if legendOpen}{b.close >= b.open ? '+' : ''}{px(b.close - b.open)} ({fmtPct((b.close - b.open) / b.open)}){:else}{fmtPct((b.close - b.open) / b.open)}{/if}</b>
          {#if legendOpen && !(narrow.current && settings.chart.volume)}<span>Vol <b>{fmtCompact(b.volume)}</b> <b>{usdVol(b)}</b></span>{/if}
          {#if legendOpen && !narrow.current}<span class="timestamp" data-testid="chart-timestamp">{zoneFormats.full.format(b.time)}</span>{/if}
        </div>
        {#each legendOpen ? priceRows : [] as r (r.s.id)}{@render studyRow(r)}{/each}
        {#if legendOpen && aiView.bias.length}
          <div class="ind" data-testid="legend-ai">
            {#each aiView.marks.filter((mark) => mark.type === 'bias') as mark (mark.id)}<button class="bias" data-key={mark.id} data-tone={mark.tone ?? 'neutral'} data-testid="ai-bias" title="Discuss this annotation" aria-label="Discuss annotation: {mark.label}" onclick={() => annotationChat.markId = mark.id}>AI {mark.label}</button>{/each}
          </div>
        {/if}
        {#each legendOpen ? compareView.rows : [] as r (r.coin)}
          <div class="ind" data-testid="legend-compare" data-coin={r.coin}>
            <span style:color={r.color}>{nameOf(r.coin)}</span>
            <b class="val" data-testid="compare-value">{r.value}</b>
            {#if r.pct}<b class="val" style:color={r.color} data-testid="compare-pct">{r.pct}</b>{/if}
            <button class="rm" data-testid="compare-remove" title="Stop comparing {r.coin}" aria-label="Stop comparing {r.coin}" onclick={(e) => (e.currentTarget.blur(), toggleCompare(r.coin))}>×</button>
          </div>
        {/each}
      </div>
    {/if}
    {#if settings.chart.volume}<div class="legends" style:top="{(paneTop.volume ?? 0) + 4}px" style:left="{axisL + 8}px" style:right="{axisW + 8}px"><div class="ind" data-testid="legend-volume">Volume <b data-testid="value-volume">{legend ? fmtCompact(legend.bar.volume) : '—'}</b> <b data-testid="value-volume-usd">{legend ? usdVol(legend.bar) : ''}</b></div></div>{/if}
    {#each rows.filter((r) => r.def.pane === 'own') as r (r.s.id)}
      <div class="legends" style:top="{(paneTop[r.s.id] ?? 0) + 4}px" style:left="{axisL + 8}px" style:right="{axisW + 8}px">{@render studyRow(r)}</div>
    {/each}
    {#each aiView.labels as l (l.key)}
      <button class="tag ai" data-tone={l.tone} title="Discuss this annotation" aria-label="Discuss annotation: {l.text}" onclick={() => annotationChat.markId = l.key} hidden={l.y < 0} data-testid="ai-label" data-mine={l.mine} data-key={l.key} style:left="{l.left}px" style:transform="translate3d(0,{l.y}px,0) translateY(-50%)" style:height="{aiView.height}px" style:max-width={l.max === null ? null : `min(50%, ${l.max}px)`} style:visibility={l.placed ? null : 'hidden'} bind:offsetWidth={l.w}><span>{l.text}</span></button>
    {/each}
    {#if !noAi()}<button class="copilot-launch" data-testid="chart-copilot" title="AI co-pilot: your own Claude Code, Codex or other MCP client coaches you on this chart" aria-expanded={ui.panelTab === 'ai'} onclick={(e) => { e.currentTarget.blur(); ui.panelTab = ui.panelTab === 'ai' ? 'trade' : 'ai'; }}>Co-pilot{#if agent.suggestions.length}<span>{agent.suggestions.length}</span>{/if}{#if ui.panelTab === 'ai'}<span aria-hidden="true">✕</span>{/if}</button>{/if}
    {#if ui.panelTab === 'ai' && !noAi()}<aside class="copilot" data-testid="copilot-dock" aria-label="AI co-pilot"><AiPanel /><span class="copilot-grip" data-testid="copilot-grip" role="presentation" title="Drag to resize, double-click to reset" onpointerdown={gripDown} onpointermove={gripMove} onpointerup={gripUp} onpointercancel={gripUp} ondblclick={() => saveDock({ w: 0, h: 0 })}></span></aside>{/if}
    {#if !noAi()}<AnnotationChat time={(t) => zoneFormats.full.format(t)} {collect} dock={(p) => ((candles?.priceToCoordinate(p) ?? 0) > priceH / 2 ? 'top' : 'bottom')} />{/if}
    {#each lineLabels.groups as g (g.rows[0].key)}
      {@const open = lineLabels.open === g.key}
      <div class="tag fill" class:buy={g.buy} class:open hidden={g.y < 0} data-testid="line-group" data-key={g.key} data-oids={g.rows.map((r) => r.o.oid).join(',')} style:left="{g.left}px" style:transform="translate3d(0,{g.y}px,0) translateY(-50%)" style:height="{lineLabels.size}px" style:max-width="{Math.max(0, lineLabels.max)}px" style:visibility={g.w ? null : 'hidden'} bind:offsetWidth={g.w}>
        <span class="clip" title={g.text}>{g.text}</span>{' '}
        <button class="x" data-testid="group-open" style:width="{lineLabels.size}px" title={open ? 'Hide these orders' : 'List these orders'} aria-expanded={open} aria-label="List {g.rows.length} orders" onclick={(e) => (e.currentTarget.blur(), toggleGroup(g.key))}>{open ? '▾' : '▸'}</button>
        {#if open && !narrow.current}
          <div class="rows" class:up={g.up} popover="manual" {@attach (n) => n.showPopover()} data-testid="group-list" onscroll={measureRows} style:left="{g.vx}px" style:top="{g.vy}px" style:max-width="{g.span}px" style:max-height="{g.room}px" style:grid-auto-rows="minmax({Math.max(30, lineLabels.size * 2)}px, max-content)">
            {@render groupRows(g)}
          </div>
        {/if}
      </div>
    {/each}
    {#each lineLabels.list as t (t.key)}
      {@const quiet = t.kind === 'mfe' || t.kind === 'mae'}
      <div class="tag" class:buy={t.buy} class:fill={t.tag} class:under={t.under} class:drag={t.drag} class:quiet class:over={t.over} class:still={!t.tag && !t.drag && !(t.x && t.o)} hidden={t.y < 0 || !!t.group} title={t.hint} data-testid={quiet ? 'extreme-tag' : 'line-tag'} data-kind={t.kind} data-key={t.key} data-tag={t.o?.oid} data-group={t.group || null} style:left="{t.left}px" style:transform="translate3d(0,{t.y}px,0) translateY(-50%)" style:height="{lineLabels.size}px" style:max-width={lineLabels.max <= 0 ? null : `${t.cap || lineLabels.max}px`} bind:offsetWidth={t.w}>
        {#if t.drag && !t.tag}<span class="grip" data-testid="line-grip" title={t.o ? 'Drag to move this order' : 'Drag to place a TP or SL'}>⋮</span>{' '}{/if}
        {#each t.parts as part, i}
          {@const est = !!t.est && part === t.est}
          {@const pnl = est || (t.kind === 'position' && i === 0)}
          <span class:clip={est || (quiet && i > 0)} class:est class:pnl class:buy={pnl && t.pnl! > 0} class:sell={pnl && t.pnl! < 0} style:color={t.why && part === t.why ? 'var(--dim)' : null}>{#if quiet && i === 0 && t.pnl !== undefined}{part.slice(0, part.indexOf(' · '))} · <b class="pnl" class:buy={t.pnl > 0} class:sell={t.pnl < 0}>{signed(t.pnl)}</b>{:else}{part}{/if}</span>{' '}
        {/each}
        {#if t.x && t.o}
          {@const o = t.o}
          <button class="x" data-testid="line-cancel" data-oid={o.oid} disabled={t.busy} style:width="{lineLabels.size}px" title="Cancel this order" aria-label="Cancel {o.coin} order {o.oid}" onclick={(e) => (e.currentTarget.blur(), cancelLine(o))}>✕</button>
        {/if}
      </div>
    {/each}
  </div>
  {#if narrow.current && (openGroup || shield)}
    <button class="group-scrim" data-testid="group-scrim" tabindex="-1" aria-label="Close the order list" onclick={() => openGroup && toggleGroup(openGroup.key)}></button>
  {/if}
  {#if narrow.current && openGroup}
    {@const g = openGroup}
    <div class="group-sheet" style:--side={g.buy ? 'var(--buy)' : 'var(--sell)'} style:--ink={g.buy ? 'var(--buy-text)' : 'var(--sell-text)'} role="dialog" aria-modal="true" aria-label={g.text} data-testid="group-list" data-key={g.key}>
      <div class="sheet-head"><span>{g.text}</span><button class="x" data-testid="group-close" aria-label="Close" onclick={() => toggleGroup(g.key)} {@attach (b) => b.focus()}>✕</button></div>
      <div class="sheet-rows" onscroll={measureRows}>{@render groupRows(g)}</div>
    </div>
  {/if}
  {#if ui.overlay === 'indicators'}<Indicators />{/if}
  {#if ui.overlay === 'goto'}<GoTo {timezone} presets={!inlineRanges} {pickRange} {goToTime} {goToRange} />{/if}
  <!-- Native fullscreen shows only this element's subtree, so the page's picker cannot appear over it. -->
  {#if ui.chartFull && (ui.overlay === 'picker' || ui.overlay === 'compare')}<MarketPicker compare={ui.overlay === 'compare'} />{/if}
  {#if ui.chartFull}<Toasts />{/if}
  {#if studyId !== null && settings.chart.studies.some((s) => s.id === studyId)}<StudySettings id={studyId} />{/if}
  <div class="chart-footer" class:ranged={inlineRanges} data-testid="chart-footer">
    <div class="ranges">
      {#if railFit === 0}{@render moreTools()}{/if}
      {#if inlineRanges}{#each RANGES as [label, days]}<button data-testid="range-{label}" onclick={(e) => (e.currentTarget.blur(), pickRange(days))}>{label}</button>{/each}{/if}
      <button data-testid="chart-goto" aria-label="Go to date" title="Go to a date or range" onclick={(e) => (e.currentTarget.blur(), (ui.overlay = 'goto'))}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1" /><path d="M2 6.5h12M5 1.5v3M11 1.5v3" /></svg></button>
    </div>
    <span class="funding" data-testid="chart-funding" aria-hidden="true"></span>
    <label class="timezone"><time data-testid="chart-clock" datetime={now ? new Date(now).toISOString() : null}>{#if now}{zoneFormats.clock.format(now)} ({clockOffset}){:else}—{/if}</time><span aria-hidden="true">⌄</span><select aria-label="Chart timezone" data-testid="chart-timezone" value={settings.chart.timezone} onfocus={prepareZoneOffsets} onpointerdown={prepareZoneOffsets} onkeydown={prepareZoneOffsets} onchange={(e) => { settings.chart.timezone = e.currentTarget.value; persist(); e.currentTarget.blur(); }}>
      <option value="local">{zoneLabel('local')}</option>
      <optgroup label="Common regions">{#each commonZones as zone}<option value={zone}>{zoneLabel(zone)}</option>{/each}</optgroup>
      <optgroup label="All regions">{#each otherZones as zone}<option value={zone}>{zoneLabel(zone)}</option>{/each}</optgroup>
    </select></label>
    <span class="scales" onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) scaleMenu = false; }}>
      {#each [SCALES[2], SCALES[1], SCALES[0]] as [cmd, id, text, action]}
        {@const on = cmd === 'invert' ? scale.invert : scale.mode === MODES[cmd]}
        <button class="mode" class:on aria-pressed={on} data-testid="scale-{id}" title="{text} ({keys(action)})" onclick={(e) => (e.currentTarget.blur(), command(cmd))}>{id === 'pct' ? '%' : id}</button>
      {/each}
      <button class="mode" class:on={autoOn} aria-pressed={autoOn} data-testid="scale-auto" title="Auto-scale ({keys('chartReset')})" onclick={(e) => (e.currentTarget.blur(), command('reset'))}>auto</button>
      <button class="mode" class:on={scaleMenu} aria-expanded={scaleMenu} aria-label="Chart scale settings" title="Chart scale settings" data-testid="scale-menu" onclick={() => (scaleMenu = !scaleMenu)}><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M8 1.5 13.6 4.75v6.5L8 14.5l-5.6-3.25v-6.5z" /><circle cx="8" cy="8" r="2.1" /></svg></button>
      {#if scaleMenu}
        {@const regular = scale.mode === PriceScaleMode.Normal}
        <div class="ui-menu scale-menu" role="menu" tabindex="-1" aria-label="Chart scale settings" data-testid="scale-settings" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); scaleMenu = false; } }}>
          {#snippet item(id: string, label: string, on: boolean, run: () => void, key = '')}
            <button role="menuitemcheckbox" aria-checked={on} data-testid="scale-item-{id}" onclick={() => { run(); scaleMenu = false; }}><span class="tick" aria-hidden="true">{on ? '✓' : ''}</span><span>{label}</span><span class="key">{key}</span></button>
          {/snippet}
          {@render item('auto', 'Auto (fits data to screen)', autoOn, () => command('reset'), keys('chartReset'))}
          {@render item('invert', 'Invert scale', scale.invert, () => command('invert'), keys('chartInvert'))}
          <hr />
          {@render item('regular', 'Regular', regular, () => (scale.mode = PriceScaleMode.Normal))}
          {@render item('percent', 'Percent', scale.mode === MODES.percent, () => regularOr('percent'), keys('chartPercent'))}
          {@render item('log', 'Logarithmic', scale.mode === MODES.log, () => regularOr('log'), keys('chartLog'))}
          <hr />
          {@render item('fills', 'Buy/sell markers', settings.chart.indicators.fills.on, () => { settings.chart.indicators.fills.on = !settings.chart.indicators.fills.on; persist(); })}
          {#if !noAi()}{@render item('ai', 'AI annotations', settings.chart.indicators.ai.on, () => { settings.chart.indicators.ai.on = !settings.chart.indicators.ai.on; persist(); })}{/if}
          <hr />
          {@render item('more', 'More settings…', false, () => openSettings('display'))}
        </div>
      {/if}
    </span>

  </div>
</div>

<style>
  .copilot-launch { position: absolute; z-index: 8; top: 8px; right: calc(var(--axis-w, 0px) + 8px); display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--dim); }
  .copilot-launch:hover { color: var(--bright); }
  .copilot-launch[aria-expanded='true'], .copilot-launch span { color: var(--accent); }
  .chart :global(.annotation-chat.top) { top: 40px; }
  .copilot { position: absolute; z-index: 7; top: 40px; right: calc(var(--axis-w, 0px) + 8px); max-height: calc(100% - 48px); width: min(var(--cw, 340px), calc(100% - var(--axis-w, 0px) - 16px)); height: var(--ch, auto); display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
  .chart:has(.copilot) :global(.annotation-chat) { right: min(calc(var(--axis-w, 0px) + var(--cw, 340px) + 16px), 12px + 50%); }
  .copilot-grip { position: absolute; left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; touch-action: none; border-left: 1px solid var(--dim); border-bottom: 1px solid var(--dim); border-bottom-left-radius: var(--radius); opacity: 0.5; }
  .copilot-grip:hover { opacity: 1; }
  .chart-refresh { position: absolute; z-index: 2; transform: translateX(-50%); opacity: 0; visibility: hidden; transition: opacity 0.15s, visibility 0.15s; }
  .chart-refresh.shown, .chart-refresh:focus-within { opacity: 1; visibility: visible; }
  .chart-refresh button { width: 20px; height: 20px; min-width: 0; min-height: 0; padding: 0; border-radius: 0; border: 0; background: none; color: var(--dim); font-size: 16px; line-height: 1; }
  .chart-refresh button:hover { color: var(--bright); }
  .chart-footer button { background: var(--panel); color: var(--dim); }
  .chart-coin { flex: none; padding: 4px 6px; color: var(--bright); font-weight: 600; white-space: nowrap; }
  .zen-toggle { flex: none; display: inline-flex; align-items: center; white-space: nowrap; margin-inline-start: 8px; padding: 4px 6px; }
  .chart-footer button.on { color: var(--accent); }
  .scales { position: relative; display: inline-flex; align-items: center; gap: inherit; }
  .scales > button { display: inline-flex; align-items: center; }
  .scale-menu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 6; display: grid; min-width: 250px; padding: 4px 0; white-space: nowrap; }
  .chart-footer .scale-menu button { display: grid; grid-template-columns: 2ch 1fr auto; gap: 8px; align-items: center; padding: 5px 12px; background: none; color: var(--text); text-align: left; border-radius: 0; }
  .chart-footer .scale-menu button:hover { background: var(--surface); color: var(--bright); }
  .scale-menu .tick { color: var(--accent); }
  .scale-menu .key { color: var(--dim); }
  .scale-menu hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--line); }
  .wrap { position: relative; display: grid; grid-template: auto minmax(0, 1fr) auto / auto minmax(0, 1fr); height: 100%; }
  .intervals, .chart-footer { grid-column: 1 / -1; }
  .intervals { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  .rail { grid-area: 2 / 1; position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; width: 36px; padding: 4px 0; border-right: 1px solid var(--line); }
  .more { position: relative; }
  .rail-menu { position: absolute; top: 0; left: calc(100% + 6px); display: flex; gap: 2px; max-width: calc(100vw - 64px); overflow-x: auto; overscroll-behavior: contain; touch-action: pan-x; padding: 2px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
  .rail-menu button { flex-shrink: 0; }
  .ranges .more { position: static; }
  .ranges .rail-menu { top: auto; bottom: calc(100% + 4px); left: 4px; max-width: calc(100% - 8px); }
  .rail button, .ranges .more button { flex-shrink: 0; display: grid; place-items: center; width: 30px; height: 30px; min-width: 0; min-height: 0; padding: 0; background: none; color: var(--dim); font-family: var(--mono); border-radius: var(--radius); }
  .rail button:hover, .ranges .more button:hover { color: var(--bright); }
  .rail button.on, .ranges .more button.on { color: var(--accent); background: var(--surface); }
  .rail button.off, .ranges .more button.off { opacity: 0.4; cursor: not-allowed; }
  .rail hr { flex-shrink: 0; width: 20px; margin: 3px 0; border: 0; border-top: 1px solid var(--line); }
  .intervals button { background: none; color: var(--dim); }
  .intervals button.on { color: var(--bright); background: var(--surface); }
  .chart-footer.ranged { flex-wrap: nowrap; }
  .ranged > * { flex-shrink: 0; }
  .ranged > .funding { flex: 1 1 0; min-width: 0; flex-wrap: nowrap; white-space: nowrap; }
  .ranges { display: flex; align-items: center; gap: 2px; margin-right: 8px; }
  .ranges button { display: inline-flex; align-items: center; padding: 2px 6px; }
  .funding { margin-right: auto; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; color: var(--dim); }
  .chart-footer { position: relative; z-index: 2; display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 4px; padding: 4px 8px; border-top: 1px solid var(--line); flex-shrink: 0; }
  .timezone { position: relative; display: inline-flex; align-items: center; gap: 6px; color: var(--chart-axis); padding: 2px 6px; font-variant-numeric: tabular-nums; }
  .timezone:focus-within { outline: 1px solid var(--accent); }
  .timezone select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
  .timestamp { color: var(--dim); }
  .tools { display: flex; align-items: center; gap: 2px; margin-left: 12px; color: var(--dim); }
  .rm { min-width: 0; min-height: 0; padding: 0 4px; background: none; color: var(--dim); font: inherit; pointer-events: auto; }
  .chart { grid-area: 2 / 2; position: relative; min-width: 0; width: 100%; max-width: 100%; min-height: 0; overflow: hidden; contain: strict; }
  .chart :global(.tv-lightweight-charts) { position: relative; z-index: 0; }
  .legends { position: absolute; top: 4px; left: 8px; z-index: 4; color: var(--dim); font-family: var(--mono); pointer-events: none; }
  .ohlc, .ind { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 10px; }
  .legends > * { text-shadow: 0 0 3px var(--bg), 0 0 2px var(--bg); }
  .ohlc span, .ohlc > b, .ind > * { white-space: nowrap; }
  .ohlc.short { flex-wrap: nowrap; overflow: hidden; gap: 0 8px; }
  .legends.all { overflow-y: auto; pointer-events: auto; }
  .ohlc b { font-weight: 400; color: var(--buy); }
  .fold { padding: 0 2px; background: none; border: 0; color: var(--dim); font: inherit; cursor: pointer; pointer-events: auto; }
  .fold:hover { color: var(--bright); }
  .ohlc.down b { color: var(--sell); }
  .ind { gap: 0 6px; }
  .ind .val { font-weight: 400; color: var(--bright); }
  /* A study row takes the pointer, so hovering it shows its eye, settings and remove buttons, as on Hyperliquid; a touch screen always shows them. */
  .study { pointer-events: auto; width: fit-content; max-width: 100%; }
  .prediction { position: relative; color: var(--dim); }
  .prediction summary { cursor: pointer; }
  .prediction div { position: absolute; top: 100%; left: 0; z-index: 5; display: grid; gap: 8px; width: min(440px, calc(100vw - 24px)); padding: 10px; overflow: auto; white-space: normal; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); font-size: max(11px, calc(var(--fs) * 0.917)); line-height: 1.4; text-shadow: none; }
  .prediction strong { color: var(--bright); }
  .prediction .explain { white-space: normal; }
  .prediction th, .prediction td { padding: 5px 4px; white-space: normal; vertical-align: top; }
  .prediction th:first-child, .prediction td:first-child { padding-left: 0; }
  .prediction b { color: var(--bright); font-weight: 500; white-space: nowrap; }
  .prediction small { display: block; white-space: nowrap; }
  .study .name { color: var(--text); }
  .study .inputs { min-width: 0; min-height: 0; padding: 0; background: none; border: 0; color: var(--dim); font: inherit; cursor: pointer; }
  .study.off :is(.name, .inputs, span) { opacity: 0.5; }
  .acts { display: none; gap: 2px; align-self: center; }
  .study:hover .acts, .study:focus-within .acts { display: inline-flex; }
  .acts button { display: grid; place-items: center; width: 22px; height: 18px; min-width: 0; min-height: 0; padding: 0; background: none; color: var(--dim); border-radius: var(--radius); }
  .acts button:hover { color: var(--bright); background: var(--surface); }
  .hist { color: var(--dim); }
  .fill-card { position: absolute; z-index: 5; display: grid; grid-template-columns: repeat(4, auto); gap: 1px 10px; padding: 6px 8px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); font: max(8px, calc(var(--fs) * 0.786))/1.4 var(--mono); white-space: nowrap; pointer-events: none; }
  .fill-card .buy { color: var(--buy-text); }
  .fill-card .sell { color: var(--sell-text); }
  .fill-card .more { grid-column: 1 / -1; }
  .retrying { position: absolute; inset: 0; z-index: 4; display: grid; place-items: center; color: var(--dim); font-family: var(--mono); pointer-events: none; }
  .tag { --side: var(--sell); --ink: var(--sell-text); position: absolute; top: 0; z-index: 3; display: flex; box-sizing: border-box; will-change: transform; font: max(8px, calc(var(--fs) * 0.92))/1.2 var(--mono); white-space: nowrap; color: var(--text); background: color-mix(in srgb, var(--panel) 92%, transparent); }
  .tag[hidden] { display: none; }
  .tag.buy { --side: var(--buy); --ink: var(--buy-text); }
  .tag:is([data-kind=order], [data-kind=exit]) > span:not(.grip, .pnl), .tag[data-kind=position] > span:last-of-type, .tag.fill > span:not(.pnl) { color: var(--ink); }
  .tag > * { display: flex; align-items: center; justify-content: center; padding: 0 0.45em; }
  .tag > .clip { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tag > .est { color: var(--text); }
  .tag > .est.buy { color: var(--buy-text); }
  .tag > .est.sell { color: var(--sell-text); }
  .tag .pnl, .row .pnl { color: var(--text); }
  .tag .pnl.buy, .row .pnl.buy { color: var(--buy-text); }
  .tag .pnl.sell, .row .pnl.sell { color: var(--sell-text); }
  .tag b.pnl { font-weight: inherit; }
  .tag.fill { color: var(--text); background: var(--panel); border-radius: var(--radius); }
  .tag.fill > .clip { align-self: center; }
  .tag.drag { cursor: ns-resize; }
  .tag.ai { --side: var(--bright); z-index: 2; max-width: 50%; padding: 0; --ink: var(--bright); color: var(--ink); border-radius: var(--radius); pointer-events: auto; cursor: pointer; font: 600 var(--fs)/1.4 var(--mono); }
  .tag.ai:focus-visible, .bias:focus-visible { outline: 2px solid var(--bright); outline-offset: 2px; }
  .tag.ai:hover, .bias:hover { filter: brightness(1.2); }
  .tag.ai[data-tone=support], .bias[data-tone=support] { --side: var(--buy); --ink: var(--buy-text); }
  .tag.ai[data-tone=resistance], .bias[data-tone=resistance] { --side: var(--warn); --ink: var(--warn-text); }
  .tag.ai[data-tone=invalidation], .bias[data-tone=invalidation] { --side: var(--sell); --ink: var(--sell-text); }
  .fullscreen { position: fixed; inset: 0; z-index: 20; background: var(--panel); width: 100%; height: 100%; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .tag.ai > span { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .bias { --side: var(--bright); padding: 4px 8px; color: var(--ink, var(--side)); border: 1px solid var(--side); border-radius: var(--radius); background: var(--panel); font-size: var(--fs); font-weight: 600; pointer-events: auto; cursor: pointer; }
  .tag.still { z-index: 2; }
  .tag.quiet { z-index: 2; pointer-events: none; opacity: 0.7; }
  .tag.quiet > .clip { align-self: center; }
  .tag.quiet > * + * { padding-left: 0; }
  .tag.over:not(.under) { z-index: 5; opacity: 1; }
  .tag > .x { flex: none; border-left: 0; }
  .tag > .grip { padding-right: 0; }
  .tag > .grip + * { padding-left: 0.3em; }
  .tag.open { z-index: 5; }
  .tag > .rows { position: fixed; inset: auto; margin: 0; color: inherit; font-size: var(--fs); display: grid; grid-template-columns: repeat(5, auto) 22px; grid-template-rows: auto; align-items: stretch; justify-content: stretch; padding: 0; overflow: auto; overscroll-behavior: contain; overflow-anchor: none; background: var(--panel); border: 1px solid var(--line); }
  .tag > .rows.up { transform: translateY(-100%); }
  .tag > .rows .row > span, .tag > .rows .group-heading > span { padding-inline: 0.7em; }
  .rows, .sheet-rows { scrollbar-width: thin; scrollbar-color: var(--dim) var(--panel); }
  .rows::-webkit-scrollbar, .sheet-rows::-webkit-scrollbar { width: 6px; height: 6px; }
  .rows::-webkit-scrollbar-thumb, .sheet-rows::-webkit-scrollbar-thumb { background: var(--dim); border-radius: var(--radius); }
  .rows::-webkit-scrollbar-track, .rows::-webkit-scrollbar-corner, .sheet-rows::-webkit-scrollbar-track, .sheet-rows::-webkit-scrollbar-corner { background: var(--panel); }
  .group-totals { grid-column: 1 / -1; position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; padding: 8px; background: var(--surface); color: var(--dim); border-top: 1px solid var(--line); white-space: normal; }
  .group-totals > span { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; font-size: max(10px, calc(var(--fs) * 0.83)); }
  .group-totals b { color: var(--text); font-size: max(8px, calc(var(--fs) * 0.92)); font-weight: 500; white-space: nowrap; }
  .group-heading { display: contents; }
  .group-heading > .sort { cursor: pointer; }
  .group-heading > .sort.sorted { color: var(--accent); font-weight: 700; }
  .group-heading > span { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: flex-end; padding: 4px 6px; background: var(--surface); color: var(--dim); font-size: max(8px, calc(var(--fs) * 0.92)); border-bottom: 1px solid var(--line); }
  .group-scrim { position: fixed; inset: 0; z-index: 20; padding: 0; background: #0008; border: 0; border-radius: 0; }
  .group-sheet { position: fixed; inset: auto 0 0; z-index: 21; display: flex; flex-direction: column; max-height: 85vh; max-height: 85dvh; padding-bottom: env(safe-area-inset-bottom); font: 14px/1.2 var(--mono); background: var(--panel); border-top: 1px solid var(--line); border-radius: var(--radius) var(--radius) 0 0; }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; padding-left: 14px; color: var(--ink); font-weight: 600; border-bottom: 1px solid var(--line); }
  .sheet-head .x { width: 44px; height: 44px; border: 0; }
  .sheet-rows { position: relative; display: grid; grid-template-columns: repeat(5, minmax(max-content, auto)) 44px; align-content: start; overflow: auto; overscroll-behavior: contain; overflow-anchor: none; }
  /* A min-height, not minmax(44px, auto) rows: the sheet's flex height leaves the grid no free space, so minmax tracks never grow past 44px for wrapped text. */
  .sheet-rows .group-heading > span, .sheet-rows .row > * { box-sizing: border-box; min-height: 44px; }
  .sheet-rows .row > span { white-space: nowrap; overflow-wrap: normal; }
  .sheet-rows .cumulative b { flex-wrap: nowrap; }
  .sheet-rows .group-heading > span, .sheet-rows .group-totals > span { font-size: 13px; }
  .sheet-rows .group-totals b { font-size: 15px; }
  /* The table may be wider than the phone: the totals stay in view while it scrolls sideways. */
  .sheet-rows .group-totals { left: 0; justify-self: start; box-sizing: border-box; width: 100vw; }
  .row .pnl { white-space: nowrap; }
  .row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; color: color-mix(in srgb, var(--text) 70%, transparent); }
  .row .n { color: color-mix(in srgb, var(--dim) 70%, transparent); }
  .row > .x { position: sticky; right: 0; background: var(--panel); z-index: 1; }
  .group-heading > span:last-child { right: 0; z-index: 2; }
  .row .price { color: color-mix(in srgb, var(--ink) 70%, transparent); font-weight: 500; }
  .row .detail { flex-direction: column; align-items: flex-end; justify-content: center; gap: 2px; text-align: right; white-space: normal; overflow-wrap: normal; color: color-mix(in srgb, var(--dim) 70%, transparent); }
  .row .detail b { font-weight: 500; }
  .effect-separator { display: none; }
  .row.opening > * { background: color-mix(in srgb, var(--side) 8%, var(--panel)); }
  .row.through > * { background: color-mix(in srgb, var(--side) 16%, var(--panel)); }
  .row:focus-visible { outline: 0; }
  .row.opening .detail { color: color-mix(in srgb, var(--ink) 70%, transparent); font-weight: 500; }
  .row .cumulative { display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 1px; min-width: 90px; }
  .cumulative b { display: flex; flex-wrap: wrap; justify-content: flex-end; column-gap: 0.3em; font-weight: 500; white-space: normal; }
  .cumulative b span { white-space: nowrap; }
  .cumulative b.buy { color: color-mix(in srgb, var(--buy-text) 70%, transparent); }
  .cumulative b.sell { color: color-mix(in srgb, var(--sell-text) 70%, transparent); }

  .row > span { display: flex; align-items: center; justify-content: flex-end; padding: 0 0.45em; }
  .row > span + span { border-left: 1px solid var(--line); }
  .row > * { border-top: 1px solid color-mix(in srgb, var(--side) 12%, transparent); }
  .row:first-child > * { border-top: 0; }
  .x { min-width: 0; min-height: 0; padding: 0; font: inherit; color: inherit; background: none; border: 0; border-left: 1px solid var(--line); border-radius: 0; cursor: pointer; }
  .under .x, .row.under .x { visibility: hidden; }
  .x:disabled { opacity: 0.4; cursor: default; }
  .x:enabled:hover { color: var(--side); background: color-mix(in srgb, var(--side) 25%, transparent); }
  .intervals { flex-wrap: nowrap; }
  .intervals.mobile-intervals { flex-wrap: wrap; }
  .intervals > * { flex-shrink: 0; }
  @media (pointer: coarse) {
    .rail { width: 40px; }
    .rail button, .ranges .more button { width: 34px; height: 34px; }
    .acts { display: inline-flex; }
    .acts button { width: 34px; height: 34px; }
  }
  .iv-menu { display: inline-flex; align-items: stretch; color: var(--bright); }
  .iv-menu :global(button) { padding: 0 8px; }
  .compact .intervals { padding: 2px 4px; }
  .iv.overflow { position: absolute; visibility: hidden; pointer-events: none; }
  .compact .iv.mobile-pin { display: block; padding: 2px 5px; min-width: 0; min-height: 32px; }
  .iv-menu.more { color: var(--dim); border-radius: var(--radius); }
  .iv-menu.more.on { color: var(--bright); background: var(--surface); }
  /* A wide bar's menu shows only its caret: font-size 0 hides its text, which stays the button's accessible name. */
  .iv-menu.more :global(.menu > button) { font-size: 0; gap: 0; padding: 0 6px; }
  @media (min-width: 901px) {
    .ohlc:not(.short) { flex-wrap: nowrap; overflow: hidden; }
    .ohlc .timestamp { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  }
  .compact .tools { margin-left: 4px; }
  @media (max-width: 900px) {
    .tag .x { position: relative; }
    .tag .x::after { content: ''; position: absolute; inset: -12px -8px; }
    .wrap { overflow: hidden; }
    .chart { margin-right: calc(-1 * var(--axis-trim, 10px)); }
    .ohlc.short { flex-wrap: wrap; }
    /* A collapsed phone legend shows a candle's OHLC only while one is under the crosshair. */
    .ohlc.idle > :not(.fold) { display: none; }
    .chart-footer { flex-wrap: nowrap; align-items: center; gap: 0; padding: 0 4px; border-top: 0; }
    .chart-footer .funding { display: none; }
    .chart-footer button { background: none; padding: 2px 8px; }
    .timezone { order: -1; margin-right: auto; min-height: 36px; padding: 2px 4px; }
    .ranges { margin-right: 0; }
  }
</style>
