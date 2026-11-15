import { MS, type Bar, type Interval } from '$lib/market/candles';
import { agent, type Selection, type SelectionContext, type Side } from '$lib/agent/agent.svelte';
import { openOrders } from '$lib/account/orders.svelte';
import { positionOf } from '$lib/account/inventory.svelte';
import { fills } from '$lib/account/fills.svelte';
import { settings } from '$lib/settings/settings.svelte';
import { extremes } from './extremes.svelte';
import { drawings, type Pt } from './drawings.svelte';

export type { SelectionContext };

/** A visible indicator: its value at a chart bar's index. */
export type Series = { name: string; at: (i: number) => number | null | undefined };

const MAX_BARS = 200;
const MAX_BYTES = 29_000;
const r = (v: number) => +v.toPrecision(8);
// The agent refuses control characters and anything shaped like a 64-hex key, so text is cleaned rather than the whole question refused.
const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f]/g, ' ').replace(/[0-9a-fA-F]{64,}/g, '…').slice(0, max);
const side = (s: 'B' | 'A'): Side => (s === 'B' ? 'buy' : 'sell');

/**
 * The bars, visible indicator values, the viewed account's orders, position (with MFE/MAE), fills, drawings and AI marks inside sel.
 * A point covers its bar and a price band of ±0.25% widened to that bar's range; a zone covers its bars and [a, b].
 * Kept under MAX_BYTES of JSON by dropping the oldest bars, counted in omitted.
 */
export function collectSelection(sel: Selection, bars: Bar[], series: Series[]): SelectionContext {
  const step = MS[sel.interval as Interval] ?? 60_000;
  const first = bars.findIndex((b) => b.time + step > sel.t0);
  const last = bars.findLastIndex((b) => b.time <= sel.t1);
  const span = first < 0 || last < first ? [] : bars.slice(first, last + 1).map((b, i) => [first + i, b] as const);
  const t0 = span[0]?.[1].time ?? sel.t0;
  const t1 = (span.at(-1)?.[1].time ?? sel.t1) + step;
  const [lo, hi] = sel.b !== undefined ? [sel.a, sel.b] : [Math.min(sel.a * 0.9975, ...span.map(([, b]) => b.low)), Math.max(sel.a * 1.0025, ...span.map(([, b]) => b.high))];
  const inBand = (p: number) => p >= lo && p <= hi;
  const inTime = (t: number) => t >= t0 && t < t1;
  const lines = settings.chart.indicators.positions.on;

  const orders = lines ? openOrders.list.filter((o) => o.coin === sel.coin && inBand(o.isTrigger ? o.triggerPx : o.limitPx)).slice(0, 50)
    .map((o) => ({ side: side(o.side), type: clean(o.orderType, 30), px: r(o.limitPx), ...(o.isTrigger ? { trigger: r(o.triggerPx) } : {}), size: o.sz, reduceOnly: o.reduceOnly })) : [];
  const p = lines ? positionOf(sel.coin) : undefined;
  const long = (p?.szi ?? 0) > 0;
  const ext = p && extremes.key.startsWith(`${p.coin}:${long ? 1 : -1}:`) && extremes.mfe && extremes.mae ? [extremes.mfe.px, extremes.mae.px] : null;
  const position = p && [p.entryPx, p.liqPx, ...(ext ?? [])].some((x) => x != null && inBand(x))
    ? { side: long ? 'long' as const : 'short' as const, size: Math.abs(p.szi), entry: r(p.entryPx), liq: p.liqPx ? r(p.liqPx) : null, ...(ext ? { mfe: r(ext[0]), mae: r(ext[1]) } : {}) }
    : undefined;
  const fillsIn = lines ? fills.list.filter((f) => f.coin === sel.coin && inTime(f.time) && inBand(f.px)).slice(0, 50)
    .map((f) => ({ t: f.time, side: side(f.side), px: r(f.px), size: f.sz, dir: clean(f.dir, 40), closedPnl: r(f.closedPnl) })) : [];
  const hits = (pts: Pt[], kind: string) => kind === 'h' ? inBand(pts[0].p) : kind === 'v' ? inTime(pts[0].t)
    : Array.from({ length: 33 }, (_, i) => ({ t: pts[0].t + ((pts[1].t - pts[0].t) * i) / 32, p: pts[0].p + ((pts[1].p - pts[0].p) * i) / 32 }))
      .some((q) => inTime(q.t) && (kind === 'fib' ? Math.min(pts[0].p, pts[1].p) <= hi && Math.max(pts[0].p, pts[1].p) >= lo : inBand(q.p)));
  const drawn = settings.chart.indicators.drawings.on ? drawings.list.filter((d) => d.pts.length && d.pts.every((q) => q.p > 0 && q.t >= 0) && hits(d.pts, d.kind)).slice(0, 20)
    .map((d) => ({ kind: d.kind, pts: d.pts.map((q) => ({ t: Math.round(q.t), p: r(q.p) })) })) : [];
  const aiMarks = settings.chart.indicators.ai.on ? agent.marks
    .filter((m) => m.coin === sel.coin && m.author !== 'user' && m.a !== null && m.type !== 'bias' && (m.b === null ? inBand(m.a) : m.a <= hi && m.b >= lo)).slice(0, 20)
    .map((m) => ({ type: m.type as 'level' | 'zone', a: m.a!, b: m.b, label: clean(m.label, 60) })) : [];

  let keep = span.slice(-MAX_BARS);
  const build = (): SelectionContext => ({
    candles: keep.map(([, b]) => [b.time, r(b.open), r(b.high), r(b.low), r(b.close), r(b.volume)]),
    ...(span.length > keep.length ? { omitted: span.length - keep.length } : {}),
    indicators: series.map((s) => ({ name: s.name, values: keep.map(([i]) => { const v = s.at(i); return v == null ? null : r(v); }) })).filter((s) => s.values.some((v) => v !== null)).slice(0, 12),
    orders, ...(position ? { position } : {}), fills: fillsIn, drawings: drawn, aiMarks
  });
  let context = build();
  const bytes = () => new TextEncoder().encode(JSON.stringify(context)).length;
  while (keep.length > 1 && bytes() > MAX_BYTES) (keep = keep.slice(Math.ceil(keep.length / 4))), (context = build());
  return context;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "24 candles · 2 orders · 1 fill · MA 7/30/99": what a selection sends, for its chat panel. */
export function included(c: SelectionContext) {
  const groups = new Map<string, string[]>();
  for (const { name } of c.indicators) {
    const [kind, n = ''] = name.split(' ');
    groups.set(kind, [...(groups.get(kind) ?? []), n].filter(Boolean));
  }
  return [
    c.candles.length && plural(c.candles.length, 'candle') + (c.omitted ? ` (${c.omitted} older left out)` : ''),
    c.orders.length && plural(c.orders.length, 'order'),
    c.position && 'position',
    c.fills.length && plural(c.fills.length, 'fill'),
    c.drawings.length && plural(c.drawings.length, 'drawing'),
    c.aiMarks.length && plural(c.aiMarks.length, 'AI mark'),
    ...[...groups].map(([kind, ns]) => (ns.length ? `${kind} ${ns.join('/')}` : kind))
  ].filter(Boolean).join(' · ');
}
