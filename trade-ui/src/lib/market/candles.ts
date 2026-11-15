import { info } from '$lib/transport/info';
import { net } from '$lib/transport/network';
import { socket } from '$lib/transport/ws.svelte';
import { arr, num } from '$lib/util/parse';
import { idbDelete, idbGetWithin, idbPut, rememberKey } from '$lib/util/storage';
import type { Interval } from '../../../../agent/src/wire.ts';

export type { Interval };
/** The chart bar's buttons and the Alt+1–8 hotkeys; ALL_INTERVALS adds the rest of Hyperliquid's steps. HL's 1M is a fixed 30 days from the epoch, not a calendar month. */
export const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '12h', '1d', '1w'];
export const ALL_INTERVALS: Interval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'];
export const ivLabel = (i: string) => i.replace(/[dw]$/, (u) => u.toUpperCase());
const UNITS: Record<string, string> = { m: 'minute', h: 'hour', d: 'day', w: 'week', M: 'month' };
export const ivName = (i: Interval) => `${parseInt(i)} ${UNITS[i.at(-1)!]}${parseInt(i) > 1 ? 's' : ''}`;
export const ivGroup = (i: Interval) => (i.endsWith('m') ? 'Minutes' : i.endsWith('h') ? 'Hours' : 'Days');
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }
export const MS: Record<Interval, number> = { '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '8h': 288e5, '12h': 432e5, '1d': 864e5, '3d': 2592e5, '1w': 6048e5, '1M': 2592e6 };

const bar = (c: any): Bar => ({
  time: num(c.t, 't'), open: num(c.o, 'o'), high: num(c.h, 'h'), low: num(c.l, 'l'), close: num(c.c, 'c'), volume: num(c.v, 'v')
});

/** 500 bars back, and at least back to 00:00 UTC so today's VWAP starts at the reset (1m reaches 1,440 bars, under HL's 5,000 cap). */
export const snapshotFrom = (interval: Interval, now: number) => Math.min(now - 500 * MS[interval], now - (now % 864e5));

export async function candleSnapshot(coin: string, interval: Interval, startTime: number, endTime = Date.now()): Promise<Bar[]> {
  const rows = await info({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }, 10_000);
  const bars = arr(rows, 'candles').map(bar);
  // HL's full 3d history repeats a bar, and two bars at one time break the chart.
  return bars.filter((b, i) => b.time !== bars[i + 1]?.time);
}

const cacheKey = (coin: string, interval: Interval) => `candles:${net.current}:${coin}:${interval}`;
/** Bars that reach back to `from` and run in time order, else none. */
const covering = (bars: Bar[], interval: Interval, from: number) =>
  bars.length && bars[0].time <= from + MS[interval] && bars.every((b, i) => !i || b.time > bars[i - 1].time) ? bars.filter((b) => b.time >= from) : [];
const cachedBar = (b: any) => bar({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume });

// `sure` is the newest bar a snapshot answered: bars after it came from the live feed, which a socket outage leaves with gaps, so they are asked for again.
const sure = new Map<string, number>();

async function cachedBars(coin: string, interval: Interval, from: number): Promise<{ at: number; bars: Bar[]; sure: number }> {
  const none = { at: 0, bars: [], sure: from };
  try {
    const c = (await idbGetWithin(cacheKey(coin, interval), 1000)) as any;
    if (c == null) return none;
    const bars = covering(arr(c.bars, 'cached candles').map(cachedBar), interval, from);
    const newest = num(c.sure, 'confirmed bar');
    return bars.length && newest <= bars.at(-1)!.time ? { at: num(c.at, 'cached at'), bars, sure: Math.max(newest, from) } : none;
  } catch (e) {
    console.warn('candle cache unreadable, asking for every bar', e);
    return none;
  }
}

/**
 * The chart's bars from `from`: this browser's cached bars, then HL's from the newest bar a snapshot answered on; no usable cache asks for them all.
 * A cache saved in the last 30 s whose answered bar is still the open one asks for nothing: the live feed sends that whole bar again on its next trade.
 */
export async function chartCandles(coin: string, interval: Interval, from: number, now = Date.now()): Promise<Bar[]> {
  const key = cacheKey(coin, interval);
  const { at, bars: cached, sure: start } = await cachedBars(coin, interval, from);
  if (cached.length && now - at >= 0 && now - at < 30_000 && now < start + MS[interval]) return sure.set(key, start), cached;
  const fetched = await candleSnapshot(coin, interval, start);
  const bars = [...cached.filter((b) => b.time < (fetched[0]?.time ?? Infinity)), ...fetched];
  if (bars.length) sure.set(key, fetched.at(-1)?.time ?? start);
  keepCandles(coin, interval, bars);
  return bars;
}

const saving = new Map<string, Bar[]>();
/** Saved at most every 3 s per coin and interval, and only when the bars reach back to the snapshot start and a snapshot of this session answered some. */
export function keepCandles(coin: string, interval: Interval, bars: Bar[]) {
  const key = cacheKey(coin, interval);
  const queued = saving.has(key);
  saving.set(key, bars);
  if (queued) return;
  setTimeout(() => {
    const list = covering(saving.get(key)!, interval, snapshotFrom(interval, Date.now()));
    saving.delete(key);
    if (!list.length || !sure.has(key)) return;
    idbPut(key, { at: Date.now(), bars: list, sure: sure.get(key) }).catch((e) => console.warn('candle cache: could not save', e));
    rememberKey('trade-ui:candle-keys', key, KEPT, (k) => idbDelete(k).catch((e) => console.warn('candle cache: could not drop', k, e)));
  }, 3000);
}

/** The newest KEPT coin and interval pairs stay cached, so the store does not grow with every market ever opened. */
const KEPT = 12;

export const watchCandles = (coin: string, interval: Interval, f: (b: Bar) => void) =>
  socket.subscribe({ type: 'candle', coin, interval }, (c) => {
    let b: Bar;
    try {
      b = bar(c);
    } catch (e) {
      return console.warn('candle frame dropped', e);
    }
    f(b);
  });
