import { BaselineSeries, HistogramSeries, LineSeries, createSeriesMarkers, type IChartApi, type IPriceLine, type IPrimitivePaneRenderer, type IPrimitivePaneView, type ISeriesApi, type ISeriesMarkersPluginApi, type ISeriesPrimitive, type SeriesAttachedParameter, type SeriesMarker, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { Num } from '$lib/market/indicators';
import { DEFS, bandStyle, fillStyle, plotStyle, type Ctx, type Def, type Out, type Study } from '$lib/market/studies';

type Series = ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | ISeriesApi<'Baseline'>;
type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
/** One study on the chart: a series per plot. */
export type Inst = { study: Study; def: Def; plots: Series[][]; out: Out; bands: IPriceLine[]; fill?: Fill; cross?: Crosses; marks?: ISeriesMarkersPluginApi<Time> };
export type Theme = { buy: string; sell: string; decimals: number };

const time = (t: number) => (t / 1000) as UTCTimestamp;
/** Fraction digits of an own-pane value without fixed digits (MACD, ATR): the coin's price decimals, and at least five significant figures, as Hyperliquid shows them. */
export const valueDigits = (v: number, decimals: number) => Math.max(decimals, 5 - String(Math.trunc(Math.abs(v))).length);

/** Something a study paints on its series' pane, in a colour and only while on. */
abstract class Layer implements ISeriesPrimitive<Time> {
  on = true;
  color = '';
  downColor?: string;
  private p?: SeriesAttachedParameter<Time>;
  private views: IPrimitivePaneView[] = [{ zOrder: () => this.z, renderer: () => ({ draw: (t: Target) => this.p && this.on && this.draw(this.p, t) }) }];
  protected z: 'bottom' | 'normal' = 'normal';
  attached(p: SeriesAttachedParameter<Time>) { this.p = p; }
  detached() { this.p = undefined; }
  paneViews() { return this.views; }
  update() { this.p?.requestUpdate(); }
  protected abstract draw(p: SeriesAttachedParameter<Time>, target: Target): void;
}

/** Hyperliquid's cross marks (plot style 3, MA and EMA Cross): a + at each value, sized by the plot's width. */
class Crosses extends Layer {
  width = 4;
  constructor(private get: () => { times: number[]; v: Num[] }) { super(); }
  protected draw(p: SeriesAttachedParameter<Time>, target: Target) {
    const { times, v } = this.get();
    const ts = p.chart.timeScale();
    const r = this.width + 2;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.strokeStyle = this.color;
      ctx.lineWidth = Math.max(1, this.width / 2);
      ctx.beginPath();
      v.forEach((x, i) => {
        const [cx, cy] = x === null ? [null, null] : [ts.timeToCoordinate(time(times[i])), p.series.priceToCoordinate(x)];
        if (cx === null || cy === null) return;
        ctx.moveTo(cx - r, cy);
        ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx, cy + r);
      });
      ctx.stroke();
    });
  }
}

/** Shades the area between two plots (or two band levels) of a study, under its lines. */
class Fill extends Layer {
  protected z = 'bottom' as const;
  constructor(private get: () => { times: number[]; a: Num[] | number; b: Num[] | number }) { super(); }
  protected draw(p: SeriesAttachedParameter<Time>, target: Target) {
    const { times, a, b } = this.get();
    const y = (v: number) => p.series.priceToCoordinate(v);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.fillStyle = this.color;
      if (typeof a === 'number' || typeof b === 'number') {
        const [y1, y2] = [y(a as number), y(b as number)];
        if (y1 !== null && y2 !== null) ctx.fillRect(0, Math.min(y1, y2), mediaSize.width, Math.abs(y2 - y1));
        return;
      }
      let run: [number, number, number][] = [];
      const flush = () => {
        if (run.length > 1) {
          ctx.beginPath();
          run.forEach(([x, ya], i) => (i ? ctx.lineTo(x, ya) : ctx.moveTo(x, ya)));
          for (let i = run.length - 1; i >= 0; i--) ctx.lineTo(run[i][0], run[i][2]);
          ctx.fill();
        }
        run = [];
      };
      const ts = p.chart.timeScale();
      times.forEach((t, i) => {
        const x = a[i] === null || b[i] === null ? null : ts.timeToCoordinate(time(t));
        const [ya, yb] = x === null ? [null, null] : [y(a[i]!), y(b[i]!)];
        if (x === null || ya === null || yb === null) return flush();
        if (this.downColor && run.length) this.segment(ctx, run.at(-1)!, [x, ya, yb], p.series.priceScale().options().invertScale);
        if (this.downColor) run = [];
        run.push([x, ya, yb]);
      });
      if (!this.downColor) flush();
    });
  }
  private segment(ctx: CanvasRenderingContext2D, a: number[], b: number[], inverted: boolean) {
    const polygon = (left: number[], right: number[], color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(left[0], left[1]);
      ctx.lineTo(right[0], right[1]);
      ctx.lineTo(right[0], right[2]);
      ctx.lineTo(left[0], left[2]);
      ctx.closePath();
      ctx.fill();
    };
    const color = (p: number[]) => (inverted ? p[1] > p[2] : p[1] < p[2]) ? this.color : this.downColor!;
    if ((a[1] - a[2]) * (b[1] - b[2]) >= 0) return polygon(a, b, color(a[1] === a[2] ? b : a));
    const ratio = (a[1] - a[2]) / (a[1] - a[2] - b[1] + b[2]);
    const cross = a.map((v, i) => v + ratio * (b[i] - v));
    polygon(a, cross, color(a));
    polygon(cross, b, color(b));
  }
}

const compactAxis = (digits: number) => {
  const number = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: digits });
  return { type: 'custom' as const, minMove: 0.01, formatter: (v: number) => number.format(Math.abs(v) < 1 ? +v.toFixed(2) || 0 : v) };
};
export const volumeAxis = compactAxis(3);
const flowAxis = compactAxis(5);

function addSeries(c: IChartApi, def: Def, kind: string | undefined, pane: number, t: Theme): Series {
  const range = def.range;
  const base = {
    priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: kind !== 'points',
    priceFormat: def.flow || def.key === 'obv' ? flowAxis : { type: 'price' as const, precision: def.digits ?? t.decimals, minMove: 10 ** -(def.digits ?? t.decimals) },
    ...(range && { autoscaleInfoProvider: () => ({ priceRange: { minValue: range[0], maxValue: range[1] } }) })
  };
  if (def.flow === 'cvd') return c.addSeries(BaselineSeries, { ...base, baseValue: { type: 'price', price: 0 }, lineWidth: 1 }, pane);
  if (kind === 'hist') return c.addSeries(HistogramSeries, base, pane);
  return c.addSeries(LineSeries, { ...base, ...(kind === 'points' && { lineVisible: false }) }, pane);
}

/** Series for each study in list order; an own-pane study takes the next pane, so panes follow the list. */
export function buildStudies(c: IChartApi, list: Study[], t: Theme): Inst[] {
  return list.map((study) => {
    const def = DEFS[study.type];
    const pane = def.pane === 'own' ? c.panes().length : 0;
    const plots = def.plots.map((p) => (p.kind === 'arrows' ? [] : [addSeries(c, def, p.kind, pane, t)]));
    const first = plots[0][0];
    if (def.pane === 'own') {
      first.getPane().setStretchFactor(0.5);
      first.priceScale().applyOptions({ visible: true, scaleMargins: { top: def.data ? 0.25 : 0.1, bottom: 0.1 } });
    }
    const k: Inst = { study, def, plots, out: { values: [] }, bands: (def.bands ?? []).map((b) => first.createPriceLine({ price: b.value, color: b.color, lineWidth: 1, lineStyle: b.style, axisLabelVisible: false, title: '' })) };
    const f = def.fill;
    if (f) first.attachPrimitive((k.fill = new Fill(() => ({ times: k.out.times ?? [], a: f.bands ? def.bands![f.a].value : k.out.values[f.a] ?? [], b: f.bands ? def.bands![f.b].value : k.out.values[f.b] ?? [] }))));
    const n = def.plots.findIndex((p) => p.kind === 'points');
    if (n >= 0) plots[n][0].attachPrimitive((k.cross = new Crosses(() => ({ times: k.out.times ?? [], v: k.out.values[n] ?? [] }))));
    if (def.plots.some((p) => p.kind === 'arrows')) k.marks = createSeriesMarkers(first, []);
    styleStudy(k, t);
    return k;
  });
}

export function removeStudies(c: IChartApi, list: Inst[]) {
  for (const k of list) {
    k.marks?.detach();
    if (k.fill) k.plots[0][0].detachPrimitive(k.fill);
    if (k.cross) k.plots[k.def.plots.findIndex((p) => p.kind === 'points')][0].detachPrimitive(k.cross);
    k.plots.flat().forEach((s) => c.removeSeries(s));
  }
}

/** Colours, widths, line styles and visibility from the study's settings; data is untouched except for the per-bar palette, which draw() repaints. */
export function styleStudy(k: Inst, t: Theme) {
  const shown = !k.study.hidden;
  k.def.plots.forEach((_, n) => {
    const st = plotStyle(k.study, n, t);
    k.plots[n].forEach((s) => s.applyOptions({ visible: shown && st.on, color: st.palette?.[0] ?? st.color, lineWidth: st.width as 1, lineStyle: st.style } as never));
    if (k.def.plots[n].kind === 'points') Object.assign(k.cross!, { on: shown && st.on, color: st.color, width: st.width }).update();
  });
  if (k.def.flow === 'cvd') k.plots[0][0].applyOptions({ topLineColor: t.buy, topFillColor1: t.buy + '33', topFillColor2: t.buy + '33', bottomLineColor: t.sell, bottomFillColor1: t.sell + '33', bottomFillColor2: t.sell + '33' } as never);
  k.bands.forEach((l, i) => l.applyOptions({ color: bandStyle(k.study, i).color, lineVisible: shown && bandStyle(k.study, i).on }));
  if (k.fill) Object.assign(k.fill, { on: shown && fillStyle(k.study).on, color: fillStyle(k.study).color, downColor: fillStyle(k.study).downColor }).update();
  if (!shown) k.marks?.setMarkers([]);
  const format = k.def.pane === 'own' ? { type: 'custom' as const, minMove: 1e-8, formatter: (v: number) => v.toFixed(valueDigits(v, t.decimals)) } : { type: 'price' as const, precision: t.decimals, minMove: 10 ** -t.decimals };
  if (k.def.percent) k.plots.flat().forEach((s) => s.applyOptions({ priceFormat: { type: 'custom', minMove: 0.0001, formatter: (v: number) => `${v.toFixed(4)}%` } }));
  if (!k.def.flow && !k.def.digits && k.def.key !== 'obv') k.plots.flat().forEach((s) => s.applyOptions({ priceFormat: format }));
}

const point = (bars: { time: number }[], j: number, v: Num, color?: string) => (v === null ? { time: time(bars[j].time) } : { time: time(bars[j].time), value: v, ...(color && { color }) });

/** Recomputes a study over all bars; full sets every point, otherwise only the last bar's point moves. A hidden study waits for the full redraw that shows it,
 * holding no points meanwhile: lightweight-charts keeps every series' times on the time scale, so another interval's would space out these candles. */
export function drawStudy(k: Inst, c: Ctx, full: boolean, t: Theme) {
  if (k.def.flow) return;
  if (k.study.hidden) return void (full && k.plots.flat().forEach((s) => s.setData([])));
  k.out = { times: c.bars.map((b) => b.time), ...k.def.calc(c, k.study.inputs) };
  const points = k.out.times!.map((time) => ({ time }));
  const last = points.length - 1;
  if (last < 0) return void k.plots.flat().forEach((s) => s.setData([]));
  k.def.plots.forEach((p, n) => {
    const v = k.out.values[n];
    const pal = k.out.colors?.[n];
    const st = plotStyle(k.study, n, t);
    // lightweight-charts joins a line across missing points and colours a segment by its left point, so a line breaks (as Hyperliquid's does at a gap or a colour change) by a transparent last point before the break.
    const breaks = (i: number) => (!p.kind || p.kind === 'line') && i < last && v[i] !== null && (v[i + 1] === null || (pal?.[i + 1] ?? null) !== (pal?.[i] ?? null));
    const at = (i: number) => point(points, i, v[i], breaks(i) ? 'transparent' : pal && pal[i] !== null ? st.palette![pal[i]!] : undefined);
    for (const s of k.plots[n]) {
      if (full || k.def.displaced || breaks(last - 1)) s.setData((p.kind === 'points' ? points.map((_, i) => at(i)) : v.flatMap((x, i) => (x === null ? [] : [at(i)]))) as never);
      else if (v[last] !== null || p.kind === 'points') s.update(at(last) as never);
    }
  });
  if (k.marks) k.marks.setMarkers(arrows(k, c));
  k.fill?.update();
  k.cross?.update();
}

function arrows(k: Inst, c: Ctx): SeriesMarker<Time>[] {
  return k.def.plots.flatMap((p, n) => {
    const st = plotStyle(k.study, n);
    if (p.kind !== 'arrows' || !st.on) return [];
    const up = p.title.startsWith('Up');
    return k.out.values[n].flatMap((v, i) => (v === null ? [] : [{ time: time(c.bars[i].time), position: up ? 'belowBar' : 'aboveBar', shape: up ? 'arrowUp' : 'arrowDown', color: st.color } as SeriesMarker<Time>]));
  });
}
