import { tick, untrack } from 'svelte';
import type { IChartApi, IPrimitivePaneRenderer, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, Logical, Time } from 'lightweight-charts';
import { market } from '$lib/market/market.svelte';
import { meta } from '$lib/market/meta.svelte';
import { MS, type Bar, type Interval } from '$lib/market/candles';
import { settings } from '$lib/settings/settings.svelte';
import { annotationChat, type Selection } from '$lib/agent/agent.svelte';
import { isTouch, isTyping } from '$lib/ui/touch';
import { fmtPx } from '$lib/util/format';
import { logicalToTime, timeToLogical } from './geometry';
import { leftWidth } from './compare.svelte';
import { clearMeasure, measure, measureUp, narrow, paintMeasure, stampOf } from './measure.svelte';
import { commit, deleteSelected, type Pt, dragPoint, drawingLabels, drawings, hitDrawing, loadDrawings, paintDrawings, placePoint, redoDrawing, undoDrawing } from './drawings.svelte';

/** Price pane coordinates: time (ms) and price to CSS pixels and back. */
export interface View { x(t: number): number | null; t(x: number): number; y(p: number): number | null; p(y: number): number | null; w: number; h: number }
export interface Colors { buy: string; sell: string; accent: string; panel: string; font: string }
type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Esc peels one layer: a pending tool, then the annotation chat (and its picked point or zone), then the selection, then the measure. */
export function escapeChart(): boolean {
  if (drawings.tool) return Object.assign(drawings, { tool: null, pending: null, hover: null }), true;
  if (annotationChat.markId || annotationChat.pending) return Object.assign(annotationChat, { markId: null, pending: null }), true;
  if (drawings.sel) return (drawings.sel = null), true;
  if (measure.m) return clearMeasure(), true;
  return false;
}

/**
 * The selected drawing, or else the finished measure, as the point or zone its chat opens on; null when the chart has neither.
 * A horizontal line has no time of its own and a vertical one no price: they sit at the newest bar and at the mark price.
 */
export function pickSelected(): Selection | null {
  const d = drawings.list.find((x) => x.id === drawings.sel);
  const m = measure.m?.done && measure.m.coin === market.coin ? measure.m : null;
  const pts = d ? d.pts : m ? [m.a, m.b] : null;
  if (!pts) return null;
  const interval = settings.chart.interval;
  const now = Date.now();
  const bar = now - (now % (MS[interval as Interval] ?? 60_000));
  // The companion takes a range within the last year that ends by now.
  const clamp = (t: number) => Math.round(Math.min(bar, Math.max(now - 364 * 864e5, t)));
  const base = { coin: market.coin, interval };
  const mark = market.ctx?.markPx ?? 0;
  if (d?.kind === 'h') return pts[0].p > 0 ? { ...base, type: 'level', a: pts[0].p, t0: bar, t1: bar } : null;
  if (d?.kind === 'v') return mark > 0 ? { ...base, type: 'level', a: mark, t0: clamp(pts[0].t), t1: clamp(pts[0].t) } : null;
  const [lo, hi] = [Math.min(pts[0].p, pts[1].p), Math.max(pts[0].p, pts[1].p)];
  const [t0, t1] = [clamp(Math.min(pts[0].t, pts[1].t)), clamp(Math.max(pts[0].t, pts[1].t))];
  if (!(lo > 0)) return null;
  return hi > lo ? { ...base, type: 'zone', a: lo, b: hi, t0, t1 } : { ...base, type: 'level', a: lo, t0, t1 };
}

/** Fixed editing keys, taken before the hotkey dispatcher (which ignores Ctrl) while there is something to delete, undo or redo. */
function onKey(e: KeyboardEvent) {
  if (isTouch() || e.repeat || e.altKey || isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const done = mod && e.code === 'KeyZ' ? (e.shiftKey ? redoDrawing() : undoDrawing()) : !mod && (e.code === 'Delete' || e.code === 'Backspace') && deleteSelected();
  if (!done) return;
  e.preventDefault();
  e.stopPropagation();
}

/** Draws the measure and the drawings on the candle series; `down` claims a plot mousedown before lightweight-charts pans. */
export function chartTools(chart: IChartApi, series: ISeriesApi<'Candlestick'>, el: HTMLElement, bars: () => Bar[], step: () => number, top: () => number = () => 0) {
  const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colors: Colors = { buy: css('--buy'), sell: css('--sell'), accent: css('--accent'), panel: css('--panel'), font: `11px ${css('--mono')}` };
  const view = (): View => {
    const times = bars().map((b) => b.time);
    const ts = chart.timeScale();
    return {
      x: (t) => {
        const l = timeToLogical(times, t, step());
        return Number.isFinite(l) ? ts.logicalToCoordinate(l as Logical) : null;
      },
      t: (x) => logicalToTime(times, ts.coordinateToLogical(x) ?? NaN, step()),
      y: (p) => series.priceToCoordinate(p),
      p: (y) => series.coordinateToPrice(y),
      w: ts.width(),
      h: chart.panes()[0].getHeight()
    };
  };

  let request = () => {};
  let labels: ISeriesPrimitiveAxisView[] = [];
  let timeLabels: ISeriesPrimitiveAxisView[] = [];
  const tag = (at: number | null, text: string, bg: string): ISeriesPrimitiveAxisView => ({ coordinate: () => at ?? -1e6, text: () => text, textColor: () => colors.panel, backColor: () => bg, visible: () => at !== null });
  const draw = (target: Target) =>
    target.useMediaCoordinateSpace(({ context }) => {
      const v = view();
      paintDrawings(context, v, colors);
      paintMeasure(context, v, colors, bars(), step(), top());
      paintAsk(context, v);
    });
  const views = [{ renderer: () => ({ draw }) }];
  const primitive: ISeriesPrimitive<Time> = {
    attached: (p) => void (request = p.requestUpdate),
    detached: () => void (request = () => {}),
    paneViews: () => views,
    priceAxisViews: () => labels,
    timeAxisViews: () => timeLabels,
    updateAllViews: () => {
      const m = measure.m;
      const a = meta.byName.get(market.coin);
      const ends = m ? [m.a, m.b] : [];
      const color = m && measureUp(m) ? colors.buy : colors.sell;
      const lines: [number, string][] = [...ends.map((e): [number, string] => [e.p, color]), ...drawingLabels().map((p): [number, string] => [p, colors.accent])];
      labels = lines.map(([price, bg]) => tag(series.priceToCoordinate(price), fmtPx(price, a?.szDecimals, a?.spot), bg));
      const v = view();
      timeLabels = ends.map((e) => tag(v.x(e.t), stampOf(e.t), color));
    },
    hitTest: (x, y) => {
      if (isTouch()) return null;
      const v = view();
      if (drawings.tool) return { externalId: 'tool', zOrder: 'top', cursorStyle: 'crosshair' };
      const g = hitDrawing(v, x, y);
      return g ? { externalId: g.id, zOrder: 'top', cursorStyle: 'move' } : null;
    }
  };
  series.attachPrimitive(primitive);

  const local = (e: MouseEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left - leftWidth(chart), y: e.clientY - r.top };
  };
  const point = (v: View, x: number, y: number) => ({ t: v.t(x), p: v.p(y) ?? NaN });
  /** Follows the pointer, mouse or finger, until release; lightweight-charts never saw the press, so it neither pans nor scales. */
  const track = (move: (x: number, y: number) => void, up: (x: number, y: number) => void) => {
    const m = (e: PointerEvent) => move(local(e).x, local(e).y);
    const end = (e: PointerEvent) => {
      removeEventListener('pointermove', m);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      up(local(e).x, local(e).y);
    };
    addEventListener('pointermove', m);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  };

  /** A measure point: the price under the pointer at the nearest bar. */
  const snap = (x: number, y: number) => ({ t: logicalToTime(bars().map((b) => b.time), Math.round(chart.timeScale().coordinateToLogical(x) ?? NaN), step()), p: series.coordinateToPrice(y) ?? NaN });
  let seq = 0;

  /** Follows the pointer while held; a release where it was pressed leaves no measure. Without a mouse only the ruler measures, since a drag pans. */
  function startMeasure(x: number, y: number): boolean {
    const ruler = drawings.tool === 'ruler';
    if (ruler) drawings.tool = null;
    if (narrow.current && !ruler) return false;
    const a = snap(x, y);
    if (!(a.p > 0) || !Number.isFinite(a.t)) return true;
    const id = ++seq;
    measure.m = { id, coin: market.coin, a, b: a, done: false };
    const to = (x2: number, y2: number, done: boolean) => {
      if (measure.m?.id !== id) return;
      if (done && Math.hypot(x2 - x, y2 - y) < 3) return clearMeasure();
      const b = snap(x2, y2);
      if (Number.isFinite(b.t) && Number.isFinite(b.p)) measure.m.b = b;
      measure.m.done = done;
    };
    track((x2, y2) => to(x2, y2, false), (x2, y2) => to(x2, y2, true));
    return true;
  }

  function grabDrawing(v: View, x: number, y: number): boolean {
    const g = hitDrawing(v, x, y);
    drawings.sel = g?.id ?? null;
    if (!g) return false;
    const before = $state.snapshot(drawings.list);
    const [start, pts0] = [point(v, x, y), before.find((d) => d.id === g.id)!.pts];
    let moved = false;
    track((x2, y2) => ((moved = true), dragPoint(g, point(view(), x2, y2), start, pts0)), () => moved && commit(undefined, before));
    return true;
  }

  /** Ask AI: a press picks the candle and price under it, a drag a zone; mouse and touch alike, since the tool must work on phones. */
  let asking: { x: number; y: number; a: Pt; b: Pt } | null = null;
  const pickOf = (a: Pt, b: Pt, zone: boolean): Selection => {
    const [t0, t1] = a.t <= b.t ? [a.t, b.t] : [b.t, a.t];
    return zone ? { coin: market.coin, interval: settings.chart.interval, type: 'zone', a: Math.min(a.p, b.p), b: Math.max(a.p, b.p), t0, t1 } : { coin: market.coin, interval: settings.chart.interval, type: 'level', a: a.p, t0: a.t, t1: a.t };
  };
  function askDown(e: PointerEvent) {
    if (drawings.tool !== 'ask' || e.button !== 0) return;
    const v = view();
    const { x, y } = local(e);
    if (x < 0 || x >= v.w || y < 0 || y >= v.h) return;
    e.preventDefault();
    e.stopPropagation();
    const a = snap(x, y);
    if (!(a.p > 0) || !Number.isFinite(a.t)) return;
    asking = { x, y, a, b: a };
    const move = (ev: PointerEvent) => {
      const b = snap(local(ev).x, local(ev).y);
      if (asking && b.p > 0 && Number.isFinite(b.t)) (asking.b = b), request();
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointercancel', up);
      if (!asking) return;
      const zone = Math.hypot(local(ev).x - asking.x, local(ev).y - asking.y) >= 6 && asking.b.p !== asking.a.p;
      const pick = pickOf(asking.a, asking.b, zone);
      asking = null;
      drawings.tool = null;
      Object.assign(annotationChat, { markId: null, pending: ev.type === 'pointercancel' ? null : pick });
      request();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
    addEventListener('pointercancel', up, { once: true });
  }
  /** lightweight-charts pans on touchstart, which follows pointerdown, so an armed tool, or the press that just used it up (the ruler), keeps the touch for itself. */
  let claimed = false;
  const claimTouch = (e: TouchEvent) => {
    const keep = (drawings.tool || claimed) && (e.target as Element).closest('canvas');
    claimed = false;
    if (keep) e.preventDefault(), e.stopPropagation();
  };
  /** A finger with a tool armed: a tap or a drag's release places a line; a trend or fib goes from the press to the release, or from one tap to the next; the eraser takes a wider hit. */
  function touchDown(e: PointerEvent) {
    if (drawings.tool === 'ask') return askDown(e);
    if (e.pointerType === 'mouse' || !drawings.tool || !e.isPrimary || e.button !== 0) return;
    const v = view();
    const { x, y } = local(e);
    if (x < 0 || x >= v.w || y < 0 || y >= v.h) return;
    e.preventDefault();
    e.stopPropagation();
    claimed = true;
    if (drawings.tool === 'ruler') return void startMeasure(x, y);
    if (drawings.tool === 'eraser') {
      const hit = hitDrawing(v, x, y, 12);
      return void (hit && ((drawings.sel = hit.id), deleteSelected()));
    }
    if (drawings.pending) return placePoint(point(v, x, y));
    if (drawings.tool === 'trend' || drawings.tool === 'fib') placePoint(point(v, x, y));
    track(
      (x2, y2) => drawings.pending && (drawings.hover = point(view(), x2, y2)),
      (x2, y2) => (!drawings.pending || Math.hypot(x2 - x, y2 - y) >= 6) && placePoint(point(view(), x2, y2))
    );
  }
  function paintAsk(ctx: CanvasRenderingContext2D, v: View) {
    const sel = asking ? pickOf(asking.a, asking.b, asking.b.p !== asking.a.p) : annotationChat.pending?.coin === market.coin ? annotationChat.pending : null;
    if (!sel) return;
    const half = chart.timeScale().options().barSpacing / 2;
    const [x0, x1, ya] = [v.x(sel.t0), v.x(sel.t1), v.y(sel.a)];
    if (x0 === null || x1 === null || ya === null) return;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = colors.accent;
    ctx.setLineDash([4, 3]);
    if (sel.type === 'zone') {
      const yb = v.y(sel.b!) ?? ya;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0 - half, Math.min(ya, yb), x1 - x0 + 2 * half, Math.abs(yb - ya));
      ctx.globalAlpha = 1;
      ctx.strokeRect(x0 - half, Math.min(ya, yb), x1 - x0 + 2 * half, Math.abs(yb - ya));
    } else {
      ctx.beginPath();
      ctx.moveTo(0, ya);
      ctx.lineTo(v.w, ya);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x0, ya, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  function down(e: MouseEvent): boolean {
    if (drawings.tool === 'ask') return true;
    if (e.button !== 0) return false;
    if (measure.m?.done) clearMeasure();
    if (isTouch()) return false;
    const v = view();
    const { x, y } = local(e);
    if (x < 0 || x >= v.w || y < 0 || y >= v.h) return false;
    if (drawings.tool === 'eraser') {
      const hit = hitDrawing(v, x, y);
      if (hit) { drawings.sel = hit.id; deleteSelected(); }
      return true;
    }
    if (drawings.tool && drawings.tool !== 'ruler') return placePoint(point(v, x, y)), true;
    if (drawings.tool === 'ruler' || e.shiftKey) return startMeasure(x, y);
    return grabDrawing(v, x, y);
  }

  const hover = (e: MouseEvent) => {
    if (drawings.pending) drawings.hover = point(view(), local(e).x, local(e).y);
  };
  el.addEventListener('mousemove', hover);
  el.addEventListener('pointerdown', touchDown, true);
  el.addEventListener('touchstart', claimTouch, { capture: true, passive: false });
  window.addEventListener('keydown', onKey, true);
  const offFx = $effect.root(() => {
    $effect(() => {
      void settings.display.theme;
      let cancelled = false;
      void tick().then(() => {
        if (cancelled) return;
        untrack(() => {
          Object.assign(colors, { buy: css('--buy'), sell: css('--sell'), accent: css('--accent'), panel: css('--panel'), font: `11px ${css('--mono')}` });
          request();
        });
      });
      return () => { cancelled = true; };
    });
    $effect(() => {
      const coin = market.coin;
      untrack(() => loadDrawings(coin));
    });
    $effect(() => {
      void [market.coin, settings.chart.interval, narrow.current];
      untrack(clearMeasure);
    });
    $effect(() => {
      void [JSON.stringify(measure.m), JSON.stringify(drawings.list), drawings.sel, drawings.hover, drawings.pending, settings.chart.indicators.drawings.on, JSON.stringify(annotationChat.pending)];
      request();
    });
  });
  return {
    down,
    destroy: () => {
      offFx();
      el.removeEventListener('mousemove', hover);
      el.removeEventListener('pointerdown', touchDown, true);
      el.removeEventListener('touchstart', claimTouch, true);
      window.removeEventListener('keydown', onKey, true);
      series.detachPrimitive(primitive);
    }
  };
}
