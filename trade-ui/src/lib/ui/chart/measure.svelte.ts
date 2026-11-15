import { MediaQuery } from 'svelte/reactivity';
import { meta } from '$lib/market/meta.svelte';
import { settings } from '$lib/settings/settings.svelte';
import type { Bar } from '$lib/market/candles';
import { tickSize } from '$lib/signing/wire';
import { fmtNum, pxDecimals } from '$lib/util/format';
import { timeToLogical } from './geometry';
import type { Pt } from './drawings.svelte';
import type { Colors, View } from './tools.svelte';

interface Measure { id: number; coin: string; a: Pt; b: Pt; done: boolean }

/** Shift+drag on a wide screen with a mouse, or the ruler anywhere: from the press to the pointer, kept after release until a click, Esc, or a coin or interval switch. `shown` is what was last painted, for the test hook. */
export const measure = $state({ m: null as Measure | null, shown: '' });
export const narrow = new MediaQuery('(max-width: 900px), (pointer: coarse)');
export const clearMeasure = () => void (measure.m = null);
export const measureUp = (m: Measure) => m.b.p >= m.a.p;
/** A measure end's time-axis tag, in the chart's timezone like the axis ticks. */
export const stampOf = (t: number) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: settings.chart.timezone === 'local' ? undefined : settings.chart.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

const VOL = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 3 });
const duration = (ms: number) =>
  ([[Math.floor(ms / 864e5), 'd'], [Math.floor(ms / 36e5) % 24, 'h'], [Math.floor(ms / 6e4) % 60, 'm']] as const).filter(([n]) => n > 0).map(([n, u]) => `${n}${u}`).join(' ') || '0m';

/** Change, % and ticks from the press price; bars and duration between the two bars; volume of every bar from one to the other, both included. */
function statsOf(m: Measure, bars: Bar[], step: number) {
  const t = meta.byName.get(m.coin) ?? { szDecimals: 0, spot: false };
  const dec = t.szDecimals;
  const times = bars.map((b) => b.time);
  const [lo, hi] = [Math.min(m.a.t, m.b.t), Math.max(m.a.t, m.b.t)];
  const change = m.b.p - m.a.p;
  const pct = change / m.a.p;
  const ticks = Math.round(change / tickSize(m.a.p, t));
  const n = Math.round(timeToLogical(times, m.b.t, step)) - Math.round(timeToLogical(times, m.a.t, step));
  const ms = m.b.t - m.a.t;
  const vol = bars.reduce((s, b) => (b.time >= lo && b.time <= hi ? s + b.volume : s), 0);
  const lines = [`${fmtNum(change, pxDecimals(m.a.p, dec))} (${(pct * 100).toFixed(2)}%), ${fmtNum(ticks, 0)}`, `${n} bars, ${ms < 0 ? '-' : ''}${duration(Math.abs(ms))}`, `Vol ${VOL.format(vol)}`];
  return { change, pct, ticks, bars: n, ms, vol, lines };
}

function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  if (Math.hypot(x1 - x0, y1 - y0) > 8) for (const s of [-1, 1]) ctx.moveTo(x1, y1), ctx.lineTo(x1 - 7 * Math.cos(a + s * 0.5), y1 - 7 * Math.sin(a + s * 0.5));
  ctx.stroke();
}

/** `top` is the pane's first row clear of the legend: the box never goes above it and drops below the measure when there is no room over it. */
export function paintMeasure(ctx: CanvasRenderingContext2D, v: View, c: Colors, bars: Bar[], step: number, top = 0) {
  const m = measure.m;
  const [x0, x1, y0, y1] = m ? [v.x(m.a.t), v.x(m.b.t), v.y(m.a.p), v.y(m.b.p)] : [];
  if (!m || x0 == null || x1 == null || y0 == null || y1 == null) return void (measure.shown = '');
  const s = statsOf(m, bars, step);
  const up = measureUp(m);
  const color = up ? c.buy : c.sell;
  const [xm, ym] = [(x0 + x1) / 2, (y0 + y1) / 2];
  ctx.fillStyle = color + '33';
  ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  arrow(ctx, xm, y0, xm, y1);
  arrow(ctx, x0, ym, x1, ym);
  ctx.font = c.font;
  const w = Math.max(...s.lines.map((l) => ctx.measureText(l).width)) + 16;
  const h = s.lines.length * 16 + 8;
  const [above, below] = [Math.min(y0, y1) - h - 6, Math.max(y0, y1) + 6];
  const [roomAbove, roomBelow] = [above >= top, below + h <= v.h];
  const y = up ? (roomAbove || !roomBelow ? above : below) : roomBelow || !roomAbove ? below : above;
  const box = { x: Math.max(0, Math.min(v.w - w, xm - w / 2)), y: Math.max(top, Math.min(v.h - h, y)), w, h };
  ctx.fillStyle = color;
  ctx.fillRect(box.x, box.y, w, h);
  ctx.fillStyle = c.panel;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  s.lines.forEach((l, i) => ctx.fillText(l, box.x + w / 2, box.y + 12 + i * 16));
  ctx.textAlign = 'left';
  const shown = JSON.stringify({ ...s, a: m.a, b: m.b, up, color, done: m.done, box, stamps: [stampOf(m.a.t), stampOf(m.b.t)] });
  if (shown !== measure.shown) measure.shown = shown;
}
