import { untrack } from 'svelte';
import { LineSeries, PriceScaleMode, type DataChangedScope, type IChartApi, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from 'lightweight-charts';
import { MS, candleSnapshot, snapshotFrom, watchCandles, type Bar, type Interval } from '$lib/market/candles';
import { market } from '$lib/market/market.svelte';
import { kindOf, listState, meta } from '$lib/market/meta.svelte';
import { socket } from '$lib/transport/ws.svelte';
import { MAX_COMPARE, persist, settings } from '$lib/settings/settings.svelte';
import { fmtNum, fmtPct, pxDecimals } from '$lib/util/format';
import { toast } from '../toast.svelte';

const COLORS = ['#cfd2d7', '#83b236', '#cb64db', '#a88758', '#7d8a9c'];
export interface CompareRow { coin: string; color: string; value: string; pct: string }
/** The compared markets drawn now, in their saved order. */
export const compareView = $state({ rows: [] as CompareRow[] });

/** The left axis width; lightweight-charts throws until it has laid out an axis just made visible. */
export function leftWidth(chart: IChartApi) {
  try {
    return chart.priceScale('left').width();
  } catch {
    return 0;
  }
}

export const compared = (main = market.coin) => settings.chart.compare[main] ?? [];

/** Adds the coin to the current market's compare list, or removes it; kept per main coin. */
export function toggleCompare(coin: string) {
  const main = market.coin;
  const list = compared(main);
  if (!list.includes(coin) && list.length >= MAX_COMPARE) return toast.error(`compare at most ${MAX_COMPARE} markets`);
  const next = list.includes(coin) ? list.filter((c) => c !== coin) : [...list, coin];
  const { [main]: _, ...rest } = settings.chart.compare;
  settings.chart.compare = next.length ? { ...rest, [main]: next } : rest;
  persist();
}

interface Line { coin: string; s: ISeriesApi<'Line'>; bars: Bar[]; pts: Bar[]; dec: number; off: () => void }
/** coin|interval → its bars so far: a market compared again fetches only the bars since, or none within the current bar. */
const cache = new Map<string, Bar[]>();
const point = (b: Bar) => ({ time: (b.time / 1000) as UTCTimestamp, value: b.close });

/**
 * Draws each compared market as a line on the left price scale: its own price for one, % change from the first visible bar for two or more.
 * Points are kept to the main candles' bar times, so bar indices (drawings, the measure, labels) stay the main series'.
 */
export function compareLines(chart: IChartApi, main: ISeriesApi<'Candlestick'>, bars: () => Bar[], enabled: () => boolean, el: HTMLElement, onLayout: () => void) {
  const lines = new Map<string, Line>();
  const failed = new Set<string>();
  /** Failed coins whose candles HL refused: their legend row stays, valued —, so a saved compare never vanishes on a rate limit. */
  const unloaded = new Set<string>();
  let ctx = '';
  let hover: number | null = null;
  let seen: Bar[] = [];
  let times = new Set<number>();
  let queued = false;
  // Set on teardown: a queued microtask or frame would otherwise read the removed chart and throw "Value is null".
  let stopped = false;
  const left = chart.priceScale('left');
  // Through the chart, so every pane's left scale follows: lightweight-charts lays out each pane's left axis once pane 0's is visible, and throws "Value is null" on a pane without one.
  chart.applyOptions({ leftPriceScale: { visible: false, borderColor: getComputedStyle(document.documentElement).getPropertyValue('--line').trim(), scaleMargins: { top: 0.1, bottom: 0.25 } } });

  const mainTimes = () => {
    const b = bars();
    if (b !== seen || b.length !== times.size) [seen, times] = [b, new Set(b.map((x) => x.time))];
    return times;
  };
  function redraw(l: Line) {
    const t = mainTimes();
    l.pts = l.bars.filter((b) => t.has(b.time));
    l.s.setData(l.pts.map(point));
  }
  /** A main bar update draws the compared bar of the same time once both exist. */
  function follow(l: Line) {
    const t = bars().at(-1)?.time;
    const b = t === undefined ? undefined : l.bars.findLast((x) => x.time <= t);
    const last = l.pts.at(-1)?.time ?? 0;
    if (!b || b.time < last || !mainTimes().has(b.time)) return;
    l.s.update(point(b));
    if (b.time === last) l.pts[l.pts.length - 1] = b;
    else l.pts.push(b);
  }
  // A microtask later: Chart.svelte sets the candles' data before it stores the bars that `bars()` reads.
  const onMain = (scope: DataChangedScope) => queueMicrotask(() => stopped || (scope === 'full' ? (lines.forEach(redraw), layout()) : (lines.forEach(follow), report(), publish())));
  main.subscribeDataChanged(onMain);

  function report() {
    const from = (chart.timeScale().getVisibleRange()?.from as number | undefined) ?? 0;
    const pct = lines.size > 1;
    compareView.rows = compared().flatMap((coin, i) => {
      const l = lines.get(coin);
      if (!l) return unloaded.has(coin) ? [{ coin, color: COLORS[i], value: '—', pct: '' }] : [];
      const at = hover === null ? l.pts.at(-1) : l.pts.findLast((b) => b.time <= hover!);
      const base = l.pts.find((b) => b.time >= from * 1000);
      return [{ coin, color: COLORS[i], value: at ? fmtNum(at.close, l.dec) : '', pct: pct && at && base ? fmtPct(at.close / base.close - 1) : '' }];
    });
  }
  /** Mirrors the lines into el's data-compare and re-places the labels, once a frame. */
  function publish() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (stopped) return;
      el.dataset.compare = JSON.stringify({
        mode: lines.size ? PriceScaleMode[left.options().mode] : '', visible: left.options().visible, width: leftWidth(chart), range: left.getVisibleRange(),
        lines: [...lines.values()].map((l) => ({ coin: l.coin, points: l.s.data().length, color: l.s.options().color }))
      });
      onLayout();
    });
  }

  function layout() {
    // Shown once a line has points: lightweight-charts' crosshair label throws on a visible scale with none.
    chart.applyOptions({ leftPriceScale: { visible: [...lines.values()].some((l) => l.pts.length > 0), mode: lines.size > 1 ? PriceScaleMode.Percentage : PriceScaleMode.Normal } });
    lines.forEach((l) => l.s.applyOptions({ color: COLORS[compared().indexOf(l.coin)] ?? COLORS[0] }));
    report();
    publish();
  }

  function remove(coin: string) {
    const l = lines.get(coin);
    if (!l) return;
    l.off();
    chart.removeSeries(l.s);
    lines.delete(coin);
  }

  function fail(coin: string, why: string, keep = false) {
    failed.add(coin);
    if (keep) unloaded.add(coin);
    remove(coin);
    toast.error(`compare ${coin}: ${why} — ${keep ? 'not loaded, change the interval to retry' : 'dropped from the chart'}`);
    layout();
  }

  function add(coin: string, interval: Interval) {
    if (meta.byName.get(coin)?.isDelisted) return fail(coin, 'delisted');
    const s = chart.addSeries(LineSeries, { priceScaleId: 'left', color: COLORS[0], lineWidth: 2, priceLineVisible: false, baseLineVisible: false, crosshairMarkerVisible: false });
    const l: Line = { coin, s, bars: [], pts: [], dec: 2, off: () => {} };
    lines.set(coin, l);
    const key = `${coin}|${interval}`;
    const now = Date.now();
    const from = snapshotFrom(interval, now);
    const kept = cache.get(key) ?? [];
    const had = (kept.at(-1)?.time ?? 0) >= from ? kept : [];
    const since = had.at(-1)?.time ?? from;
    const load = () => candleSnapshot(coin, interval, since);
    // One retry 1–3 s later: HL refuses a snapshot over the per-IP weight (a 429 post error frame), as on a reload right after another.
    const again = () => new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000)).then(() => (lines.get(coin) === l ? load() : []));
    const fetched = since >= now - (now % MS[interval]) ? Promise.resolve([]) : load().catch(again);
    fetched.then((snap) => {
      if (lines.get(coin) !== l) return;
      const all = [...had.filter((b) => b.time < (snap[0]?.time ?? Infinity)), ...snap];
      if (!all.length) return fail(coin, 'no candles');
      cache.set(key, (l.bars = all));
      l.dec = pxDecimals(all[all.length - 1].close, meta.byName.get(coin)?.szDecimals ?? 0, meta.byName.get(coin)?.spot);
      s.applyOptions({ priceFormat: { type: 'price', precision: l.dec, minMove: 10 ** -l.dec } });
      redraw(l);
      l.off = watchCandles(coin, interval, (b) => live(l, b));
      layout();
    }, (e: Error) => lines.get(coin) === l && fail(coin, e.message || 'failed to load', true));
  }

  function live(l: Line, b: Bar) {
    const last = l.bars.at(-1);
    if (last && b.time < last.time) return;
    if (last?.time === b.time) l.bars[l.bars.length - 1] = b;
    else l.bars.push(b);
    follow(l);
    report();
    publish();
  }

  /** Unknown once its market list has loaded fresh. */
  const gone = (c: string) => !meta.byName.has(c) && listState(kindOf(c)) !== 'loading';

  /** Lines for another main coin or interval go; snapshots wait for the socket (REST info weight is per IP); a coin waits for its meta (HL drops the socket on an unknown HIP-3 dex), and one that failed stays off until the coin or interval changes. */
  function sync(next: string, interval: Interval, want: string[]) {
    if (next !== ctx) {
      [...lines.keys()].forEach(remove);
      failed.clear();
      unloaded.clear();
      ctx = next;
    }
    [...lines.keys()].filter((c) => !want.includes(c)).forEach(remove);
    [...failed].filter((c) => !want.includes(c)).forEach((c) => (failed.delete(c), unloaded.delete(c)));
    if (socket.state === 'open') want.filter((c) => meta.byName.has(c) && !lines.has(c) && !failed.has(c)).forEach((c) => add(c, interval));
    want.filter((c) => gone(c) && !failed.has(c)).forEach((c) => fail(c, 'not listed'));
    layout();
  }

  const onCrosshair = (p: MouseEventParams) => {
    hover = p.point && p.time !== undefined ? (p.time as number) * 1000 : null;
    if (lines.size) report();
  };
  const onRange = () => lines.size && (report(), publish());
  chart.subscribeCrosshairMove(onCrosshair);
  chart.timeScale().subscribeVisibleTimeRangeChange(onRange);

  const off = $effect.root(() => {
    $effect(() => {
      const coin = market.coin;
      const interval = settings.chart.interval;
      const want = enabled() ? compared(coin).filter((c) => c !== coin) : [];
      void [meta.byName, meta.loaded, meta.hip3, socket.state];
      untrack(() => sync(`${coin}|${interval}`, interval, want));
    });
  });

  return () => {
    stopped = true;
    off();
    chart.unsubscribeCrosshairMove(onCrosshair);
    chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange);
    main.unsubscribeDataChanged(onMain);
    [...lines.keys()].forEach(remove);
    compareView.rows = [];
  };
}
