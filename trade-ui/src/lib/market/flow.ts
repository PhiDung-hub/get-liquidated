import { MS, type Interval } from './candles';

export interface Tick { side: 'B' | 'A'; sz: number; time: number; tid: number }
export interface Point { time: number; value: number }
interface OiBar { time: number; open: number; close: number }
export interface Flow { start: number; step: number; cvd: Point[]; oi: OiBar[]; recent: number[]; gaps: number[] }

// HL replays its last 30 trades on every (re)subscribe; tids are random, so dedupe keeps the latest ones counted.
const RECENT = 100;

export const newFlow = (start: number, interval: Interval): Flow => ({ start, step: MS[interval], cvd: [], oi: [], recent: [], gaps: [] });

const barOf = (f: Flow, time: number) => Math.floor(time / f.step) * f.step;

/** Each bar holds the running total after its last trade, so a trade moves its own bar and every later one. */
function bump(cvd: Point[], time: number, d: number): Point[] {
  const base = cvd.findLast((p) => p.time < time)?.value ?? 0;
  const all = cvd.some((p) => p.time === time) ? cvd : [...cvd, { time, value: base }].sort((a, b) => a.time - b.time);
  return all.map((p) => (p.time >= time ? { time: p.time, value: p.value + d } : p));
}

/** replay: the first trades message after a reconnect. It is complete only when it reaches a counted trade or the start. */
export function addTrades(f: Flow, ticks: Tick[], replay = false): Flow {
  const known = new Set(f.recent);
  const fresh = ticks.filter((t) => t.time >= f.start && !known.has(t.tid));
  const reaches = ticks.some((t) => known.has(t.tid) || t.time < f.start);
  const gaps = replay && ticks.length && !reaches ? [...f.gaps, Math.min(...ticks.map((t) => t.time))] : f.gaps;
  if (!fresh.length && gaps === f.gaps) return f;
  const deltas = new Map<number, number>();
  for (const t of fresh) deltas.set(barOf(f, t.time), (deltas.get(barOf(f, t.time)) ?? 0) + (t.side === 'B' ? t.sz : -t.sz));
  let cvd = f.cvd;
  for (const [time, d] of deltas) cvd = bump(cvd, time, d);
  return { ...f, cvd, recent: [...f.recent, ...fresh.map((t) => t.tid)].slice(-RECENT), gaps };
}

export function addOi(f: Flow, time: number, oi: number): Flow {
  const bar = barOf(f, time);
  const last = f.oi.at(-1);
  if (time < f.start || (last && bar < last.time)) return f;
  if (last?.time === bar) return last.close === oi ? f : { ...f, oi: [...f.oi.slice(0, -1), { ...last, close: oi }] };
  const open = last?.time === bar - f.step ? last.close : oi;
  return { ...f, oi: [...f.oi, { time: bar, open, close: oi }] };
}

export const oiDelta = (f: Flow): Point[] => f.oi.map((b) => ({ time: b.time, value: b.close - b.open }));

/** One collector bar; buy/sell are null where the coin was not recorded. */
export interface HistBar { t: number; buy: number | null; sell: number | null; oi: number | null; gap: boolean }
export interface Hist { status: 'off' | 'loading' | 'ok' | 'none'; bars: HistBar[]; note: string }

/** History ends at the start minute, so the shared bar barOf(start) holds history's part plus live's: live wins it and every later bar.
 * first: where each pane's history starts, null when that pane is live only (an OI-only coin has no CVD history). */
export function withHistory(f: Flow, h: Hist): { cvd: Point[]; oid: Point[]; gaps: number[]; first: { cvd: number | null; oid: number | null } } {
  if (h.status !== 'ok' || !h.bars.length) return { cvd: f.cvd, oid: oiDelta(f), gaps: f.gaps, first: { cvd: null, oid: null } };
  const seam = barOf(f, f.start);
  let total = 0;
  const cvd = h.bars.flatMap((b) => (b.buy === null && b.sell === null ? [] : [{ time: b.t, value: (total += (b.buy ?? 0) - (b.sell ?? 0)) }]));
  const live = f.cvd.map((p) => ({ time: p.time, value: p.value + total }));
  const ours = new Set(live.map((p) => p.time));
  const closes = new Map<number, number>(h.bars.flatMap((b) => (b.oi === null || b.t >= seam ? [] : [[b.t, b.oi] as [number, number]])));
  const oid = [...closes].flatMap(([t, c]) => (closes.has(t - f.step) ? [{ time: t, value: c - closes.get(t - f.step)! }] : []));
  const first = { cvd: cvd[0]?.time ?? null, oid: oid[0]?.time ?? null };
  for (const b of f.oi) {
    const prev = closes.get(b.time - f.step);
    oid.push({ time: b.time, value: b.close - (prev ?? b.open) });
    closes.set(b.time, b.close);
  }
  const gaps = [...h.bars.filter((b) => b.gap).map((b) => b.t), ...f.gaps].sort((a, b) => a - b);
  return { cvd: [...cvd.filter((p) => !ours.has(p.time)), ...live], oid, gaps, first };
}
