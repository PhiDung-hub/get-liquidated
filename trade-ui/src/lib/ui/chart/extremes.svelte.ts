import { untrack } from 'svelte';
import { fillEvents, fills, type Fill } from '$lib/account/fills.svelte';
import { positionOf, type Position } from '$lib/account/inventory.svelte';
import { candleSnapshot, MS, type Bar, type Interval } from '$lib/market/candles';
import { market } from '$lib/market/market.svelte';
import { meta } from '$lib/market/meta.svelte';
import { tradeEvents, type Trade } from '$lib/market/trades.svelte';
import { tickSize } from '$lib/signing/wire';
import { net } from '$lib/transport/network';
import { socket } from '$lib/transport/ws.svelte';
import { load as stored, save } from '$lib/util/storage';

const CAP = 4999;
const RETRY = 15_000;
const PAINT = 500;
const TAIL = 500;
const TIERS: Interval[] = ['1m', '5m', '15m', '1h'];

/** A point of the position's path: its PnL since it opened at px and time t (USDC, after fees, before funding), and the largest cost basis held up to then. */
export interface Pt { v: number; px: number; t: number; base: number }
/** A position as cash flows: worth c + q·p at price p; K its cost basis, peak the largest K so far; sizes under half are flat. */
export interface Run { q: number; c: number; K: number; peak: number; best: Pt | null; worst: Pt | null; half: number }
export type Span = Bar & { end: number };
type Mode = 'full' | 'since' | 'live';

class Extremes {
  key = $state('');
  mfe = $state.raw<Pt | null>(null);
  mae = $state.raw<Pt | null>(null);
  mode = $state<Mode>('full');
  since = $state(0);
  candles = $state(false);
}
/**
 * The chart coin's position's best (MFE) and worst (MAE) PnL since it opened, replaying its fills along its bars and then the live trades; `candles` once bars counted.
 * key is coin:side:epoch; mode 'since' when the opening fill is older than the kept fills (counted from the oldest), 'live' when the fills are not known.
 */
export const extremes = new Extremes();

const dir = (f: Fill) => (f.side === 'B' ? f.sz : -f.sz);
const after = (f: Fill) => f.startPosition! + dir(f);
const floor = (t: number, iv: Interval) => Math.floor(t / MS[iv]) * MS[iv];
const lot = (x: number, half: number) => Math.round(x / half);

/** Where one millisecond's fills start: at the size more of them start from than end at, or nowhere for a round trip. */
function head(g: Fill[], half: number) {
  const net = new Map<number, number>();
  const count = (x: number, d: number) => net.set(lot(x, half), (net.get(lot(x, half)) ?? 0) + d);
  for (const f of g) count(f.startPosition!, 1), count(after(f), -1);
  return [...net].find(([, n]) => n > 0)?.[0];
}

/** One millisecond's fills along their startPosition chain from the size at (in lots), or from their head: a walk that takes each fill once (Hierholzer's, lower tids first where it branches), then any it cannot reach. */
function link(g: Fill[], half: number, at?: number): Fill[] {
  if (g.length < 2) return g;
  const from = Map.groupBy(g, (f) => lot(f.startPosition!, half));
  let s = at !== undefined && from.has(at) ? at : (head(g, half) ?? lot(g[0].startPosition!, half));
  const [path, out] = [[] as Fill[], [] as Fill[]];
  for (;;) {
    const f = from.get(s)?.shift();
    if (f) {
      path.push(f);
      s = lot(after(f), half);
      continue;
    }
    const back = path.pop();
    if (!back) break;
    out.push(back);
    s = lot(back.startPosition!, half);
  }
  return [...out.reverse(), ...[...from.values()].flat().sort((a, b) => a.tid - b.tid)];
}

/** Fills by time, each millisecond's (a block stamps its fills alike, and a tid is not the match order) linked on from the size the one before left: the first from q, else from where the first that is no round trip starts. */
function chained(fs: Fill[], half: number, q?: number): Fill[] {
  const sorted = fs.toSorted((a, b) => a.time - b.time || a.tid - b.tid);
  const groups: Fill[][] = [];
  for (let i = 0, j = 0; i < sorted.length; i = j) {
    while (j < sorted.length && sorted[j].time === sorted[i].time) j++;
    groups.push(sorted.slice(i, j));
  }
  let at = q !== undefined ? lot(q, half) : groups.map((g) => head(g, half)).find((h) => h !== undefined);
  return groups.flatMap((g) => {
    const l = link(g, half, at);
    at = lot(after(l.at(-1)!), half);
    return l;
  });
}
const start = (q: number, K: number, half: number): Run => ({ q, c: -Math.sign(q) * K, K, peak: K, best: null, worst: null, half });

function see(r: Run, px: number, t: number) {
  if (Math.abs(r.q) < r.half) return;
  const v = r.c + r.q * px;
  if (!r.best || v > r.best.v) r.best = { v, px, t, base: r.peak };
  if (!r.worst || v < r.worst.v) r.worst = { v, px, t, base: r.peak };
}

function apply(r: Run, f: Fill) {
  const [dq, fee] = [dir(f), f.feeToken === 'USDC' ? f.fee : 0];
  const a = r.q + dq;
  if (Math.abs(a) < r.half) return void Object.assign(r, { q: 0, K: 0, c: r.c - dq * f.px - fee });
  // An open or a flip starts again from the part of the fill past flat, with that share of its fee.
  if (Math.abs(r.q) < r.half || Math.sign(a) !== Math.sign(r.q)) return void Object.assign(r, start(a, Math.abs(a) * f.px, r.half), { c: -a * f.px - (fee * Math.abs(a)) / f.sz });
  r.c -= dq * f.px + fee;
  if (Math.abs(a) > Math.abs(r.q)) r.peak = Math.max(r.peak, (r.K += f.sz * f.px));
  else r.K *= Math.abs(a) / Math.abs(r.q);
  r.q = a;
}

const point = (r: Run, f: Fill) => (see(r, f.px, f.time), apply(r, f), see(r, f.px, f.time));

/** The leg of path v where it first reaches px from price at on leg s; 3 when it never does. */
function land(v: number[], s: number, at: number, px: number) {
  let i = s;
  for (let p = at; i < 3 && (p - px) * (v[i + 1] - px) > 0; p = v[++i]);
  return i;
}

/** A bar's path runs O→L→H→C when it closed up, else O→H→L→C, unless only the other one reaches its fills in turn; each fill lands where the path first reaches its price after the one before, or where the path stands. */
function walk(r: Run, b: Span, fs: Fill[]) {
  const ways = [[b.open, b.low, b.high, b.close], [b.open, b.high, b.low, b.close]];
  if (b.close < b.open) ways.reverse();
  const reaches = (v: number[]) => ((s, at) => fs.every((f) => ((s = land(v, s, at, f.px)), (at = f.px), s < 3)))(0, v[0]);
  const v = ways.find(reaches) ?? ways[0];
  let [s, at] = [0, v[0]];
  see(r, at, b.time);
  for (const f of fs) {
    const i = land(v, s, at, f.px);
    if (i < 3) {
      while (s < i) see(r, v[++s], b.time);
      at = f.px;
    }
    point(r, f);
  }
  while (s < 3) see(r, v[++s], b.time);
}

/** Folds bars (time order) and fills (chain order) into r, fills from now (when the bars were asked, which the newest bar's prices stop at) after every bar; returns a copy of r after the newest bar closed by now, with that bar's end C and the count n of fills before it. */
export function fold(r: Run, bars: Span[], fs: Fill[], now: number) {
  let [i, cp] = [0, null as { r: Run; C: number; n: number } | null];
  for (const b of bars) {
    while (i < fs.length && fs[i].time < b.time) point(r, fs[i++]);
    let j = i;
    while (j < fs.length && fs[j].time < Math.min(b.end, now)) j++;
    walk(r, b, fs.slice(i, j));
    i = j;
    if (b.end <= now) cp = { r: { ...r }, C: b.end, n: i };
  }
  while (i < fs.length) point(r, fs[i++]);
  return cp;
}

interface Epoch { id: string; fs: Fill[]; mode: Mode; t0: number; r: Run }

/**
 * The fills of the position on coin since its opening fill, the newest in chain order that left a position on its side from flat or the other side, and the state they start from.
 * Without one in the kept history it counts from the oldest kept fill, at the cost basis its fills take back from today's; before the fills are seeded, or while the newest leave no position on its side (a fill on its way), from the position as it stands.
 */
export function epoch(coin: string, p: Position, half: number): Epoch {
  const side = Math.sign(p.szi);
  const now: Epoch = { id: 'live', fs: [], mode: 'live', t0: Date.now(), r: start(p.szi, Math.abs(p.szi) * p.entryPx, half) };
  if (!fills.seeded) return now;
  const all = chained(fills.list.filter((f) => f.coin === coin && f.startPosition !== null), half);
  const end = all.at(-1);
  if (!end || Math.sign(after(end)) !== side) return now;
  const i = all.findLastIndex((f) => Math.sign(after(f)) === side && Math.sign(f.startPosition!) !== side);
  const o = all[Math.max(i, 0)];
  // Earlier fills of the opening fill's hour come along: they move its bar's path to where it filled, and the open drops what they saw.
  const fs = all.slice(i < 0 ? 0 : all.findIndex((f) => f.time >= floor(o.time, '1h')));
  const head = { id: `${o.time}:${o.tid}`, fs, t0: o.time };
  if (i >= 0) return { ...head, mode: 'full', r: start(fs[0].startPosition!, 0, half) };
  let K = Math.abs(p.szi) * p.entryPx;
  for (let j = fs.length - 1; j >= 0; j--) {
    const [b, a] = [Math.abs(fs[j].startPosition!), Math.abs(after(fs[j]))];
    K = a > b ? K - fs[j].sz * fs[j].px : (K * b) / a;
  }
  return { ...head, mode: 'since', r: start(fs[0].startPosition!, K, half) };
}

const tier = (t: number, now: number) => TIERS.find((iv) => now - floor(t, iv) < CAP * MS[iv]) ?? '1h';

/** One request from the bar holding from at the finest interval that reaches it within HL's 5,000-bar cap; a coarser one gets 1m bars spliced over the span of fills of the newest 5,000 minutes. */
async function barsFrom(coin: string, from: number, fs: Fill[], now: number): Promise<Span[]> {
  const get = async (iv: Interval, s: number, e: number) => (await candleSnapshot(coin, iv, s, e)).map((b) => ({ ...b, end: b.time + MS[iv] }));
  const iv = tier(from, now);
  const out = await get(iv, floor(from, iv), now);
  const recent = fs.filter((f) => now - f.time < CAP * MS['1m']);
  if (iv === '1m' || !recent.length) return out;
  const s = Math.max(floor(recent[0].time, iv), Math.ceil((now - CAP * MS['1m']) / MS[iv]) * MS[iv]);
  const e = floor(recent.at(-1)!.time, iv) + MS[iv];
  // A failed 1m read keeps the coarse bars rather than asking for both again.
  const fine = s < e ? await get('1m', s, e).then((bs) => bs.filter((b) => b.time >= s && b.time < e), () => []) : [];
  return fine.length ? [...out.filter((b) => b.time < s), ...fine, ...out.filter((b) => b.time >= e)] : out;
}

interface Saved { key: string; C: number; n: number; last: string; q: number; c: number; K: number; peak: number; best: Pt | null; worst: Pt | null }
const fillKey = (f?: Fill) => (f ? `${f.time}:${f.tid}` : '');
const cacheKey = (coin: string) => `trade-ui:extremes:v2:${net.current}:${coin}`;
const merge = (r: Run, o: { best: Pt | null; worst: Pt | null }) => {
  if (o.best && (!r.best || o.best.v > r.best.v)) r.best = o.best;
  if (o.worst && (!r.worst || o.worst.v < r.worst.v)) r.worst = o.worst;
};

let gen = 0;
let stale = false;
let bumps = $state(0);
let paint: ReturnType<typeof setTimeout> | undefined;
let heard = -1;
/** The shown run r: from when it counts (the position as it stands, in 'live'), the newest trade it counted (seen), the time its bars were asked (upto), and base, r before the trades in tail (at most TAIL, those older went into base, the newest of them at bt). */
let cur: { coin: string; r: Run; base: Run; bt: number; tail: Trade[]; fs: Fill[]; from: number; seen: number; upto: number } | null = null;

const show = () => cur && ([extremes.mfe, extremes.mae] = [cur.r.best, cur.r.worst]);

/** Trades redraw the labels (every price line) at most every PAINT ms. */
const soon = () => (paint ??= setTimeout(() => ((paint = undefined), show()), PAINT));

function reset(key: string) {
  [gen, stale, cur] = [gen + 1, false, null];
  Object.assign(extremes, { key, mfe: null, mae: null, candles: false });
}

const state = (r: Omit<Run, 'half'>) => ({ q: r.q, c: r.c, K: r.K, peak: r.peak, best: r.best, worst: r.worst });

/** Makes r the shown run, with what the old one saw meanwhile, and saves its checkpoint cp (base fills of done came before the bars it folded). */
function settle(coin: string, key: string, r: Run, cp: ReturnType<typeof fold>, base: number, done: Fill[], asked: number) {
  merge(r, cur!.r);
  Object.assign(cur!, { r, base: { ...r }, bt: asked, upto: asked });
  extremes.candles = true;
  show();
  if (cp) save(cacheKey(coin), { key, C: cp.C, n: base + cp.n, last: fillKey(done[base + cp.n - 1]), ...state(cp.r) } satisfies Saved);
}

/** Counts the epoch's fills, then reads the bars from the checkpoint kept for it (while the fills before it are unchanged) or from its opening fill; prices since the last read were not watched, so it always reads. */
function restart(key: string, coin: string, p: Position, e: Epoch) {
  const g = ++gen;
  const r = { ...e.r };
  fold(r, [], e.fs, 0);
  const tick = tickSize(p.entryPx, meta.byName.get(coin) ?? { szDecimals: 0, spot: false });
  if (Math.abs(r.q) >= r.half && Math.abs(r.K / Math.abs(r.q) - p.entryPx) > tick) console.warn(`extremes: ${coin} fills average ${r.K / Math.abs(r.q)}, the position ${p.entryPx}`);
  // Fills that do not add up to the position (one still on its way) count from the position as it stands until it comes.
  const off = Math.abs(r.q - p.szi) >= r.half;
  stale = off;
  const run = off ? start(p.szi, Math.abs(p.szi) * p.entryPx, r.half) : r;
  cur = { coin, r: run, base: { ...run }, bt: Date.now(), tail: [], fs: off ? [] : [...e.fs], from: Date.now(), seen: 0, upto: 0 };
  Object.assign(extremes, { key, mode: off ? 'live' : e.mode, since: e.t0, candles: false });
  show();
  if (off || e.mode === 'live') return;
  const c = stored<Saved | null>(cacheKey(coin), null);
  const now = Date.now();
  const before = c?.key === key && Number.isFinite(c.C) && c.C % MS[tier(c.C, now)] === 0 ? e.fs.filter((f) => f.time < c.C) : null;
  const kept = !!before && before.length === c!.n && fillKey(before.at(-1)) === c!.last && [c!.q, c!.c, c!.K, c!.peak].every(Number.isFinite);
  const resume = (): Run => ({ ...state(c!), half: r.half });
  const from = kept ? c!.C : e.t0;
  const load = (again: boolean, asked = Date.now()) =>
    barsFrom(coin, from, e.fs.filter((f) => f.time >= from), asked).then(
      (bars) => {
        if (g !== gen || !cur) return;
        const base = kept ? c!.n : 0;
        const k = kept ? resume() : { ...e.r };
        settle(coin, key, k, fold(k, bars, cur.fs.slice(base), asked), base, cur.fs, asked);
      },
      (err) => {
        console.warn(`extremes: ${coin} bars unavailable`, err);
        if (again) setTimeout(() => g === gen && load(false), RETRY);
      }
    );
  load(true);
}

/** The chart coin's fresh trades as they come (every one, before the list keeps its newest), each since the newest counted fill or, counted from the position as it stands, since then. */
function onTrades(list: Trade[]) {
  if (!cur || cur.coin !== market.coin) return;
  const last = cur.fs.at(-1)?.time ?? cur.from;
  for (const t of list) {
    if (t.time < last) continue;
    see(cur.r, t.px, t.time);
    cur.seen = Math.max(cur.seen, t.time);
    if (cur.tail.push(t) <= TAIL) continue;
    const o = cur.tail.shift()!;
    see(cur.base, o.px, o.time);
    cur.bt = o.time;
  }
  soon();
}

/**
 * Fresh fills of the coin that continue the run's chain apply at once; one out of order or off the chain (a late page, another account) recounts, and one that opens, flips or flattens finds the new epoch.
 * One older than trades already counted (its message came after theirs) goes back to base and takes the tail's trades again, those after it at its size (at most TAIL: O(1)); it recounts only when bars counted past it or base already took a trade after it.
 */
function onFills(fresh: Fill[]) {
  if (!cur) return;
  for (const f of chained(fresh.filter((f) => f.coin === cur!.coin && f.startPosition !== null), cur.r.half, cur.r.q)) {
    const [late, last] = [f.time < cur.seen, cur.fs.at(-1)?.time ?? cur.from];
    if (stale || f.time < cur.upto || f.time < last || (late && f.time < cur.bt) || Math.abs(f.startPosition! - cur.r.q) >= cur.r.half) return void ((stale = true), bumps++);
    const r = late ? { ...cur.base } : cur.r;
    const since = late ? cur.tail.filter((t) => t.time >= f.time) : [];
    if (late) for (const t of cur.tail) if (t.time < f.time) see(r, t.px, t.time);
    point(r, f);
    Object.assign(cur, { base: { ...r }, bt: f.time, tail: since });
    for (const t of since) see(r, t.px, t.time);
    cur.r = r;
    cur.fs.push(f);
    if (Math.sign(after(f)) !== Math.sign(f.startPosition!)) bumps++;
  }
  show();
}

/** Keeps `extremes` on the chart coin's position for the app's life, chart shown or not: a flip, a flat or a coin switch starts again; fills and trades then update it one at a time. */
export const startExtremes = () =>
  $effect.root(() => {
    // Counted from the position as it stands, every size change is a reason to look again; otherwise only a side change is.
    const held = $derived(((szi) => (extremes.mode === 'live' ? szi : Math.sign(szi)))(positionOf(market.coin)?.szi ?? 0));
    const empty = $derived(!fills.list.length);
    $effect(() => {
      const coin = market.coin;
      const rc = socket.reconnects;
      void [held, fills.seeded, empty, bumps];
      untrack(() => {
        // Prices while the socket was down are only in the bars, so a reconnect reads them again.
        if (rc !== heard) [heard, stale] = [rc, stale || (heard >= 0 && extremes.mode !== 'live')];
        const p = positionOf(coin);
        const s = Math.sign(p?.szi ?? 0);
        if (!s || !p) return extremes.key && reset('');
        const e = epoch(coin, p, 0.5 * 10 ** -(meta.byName.get(coin)?.szDecimals ?? 8));
        const key = `${coin}:${s}:${e.id}`;
        const was = extremes.key;
        // A reseed (after a reconnect) briefly knows no start; it never drops the one already found.
        if (key === was ? !stale : e.mode === 'live' && was.startsWith(`${coin}:${s}:`) && !was.endsWith(':live')) return;
        restart(key, coin, p, e);
      });
    });
    const offs = [fillEvents.on(onFills), tradeEvents.on(onTrades)];
    return () => (offs.forEach((off) => off()), reset(''));
  });
