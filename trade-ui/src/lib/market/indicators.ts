import type { Bar } from './candles';

export type Num = number | null;
const DAY = 864e5;

/** Mean of the last n values; null until n values in a row exist (a null inside the window voids it, as Pine's ta.sma). */
export function sma(xs: Num[], n: number): Num[] {
  let sum = 0;
  let run = 0;
  return xs.map((x, i) => {
    sum += (x ?? 0) - (i >= n ? xs[i - n] ?? 0 : 0);
    run = x === null ? 0 : run + 1;
    return run >= n ? sum / n : null;
  });
}

/** k = 2/(n+1), seeded with the SMA of the first n values; a null restarts the seed. */
export function ema(xs: Num[], n: number, k = 2 / (n + 1)): Num[] {
  const seed = sma(xs, n);
  let prev: Num = null;
  return xs.map((x, i) => (prev = x === null ? null : prev === null ? seed[i] : x * k + prev * (1 - k)));
}

/** Wilder's smoothing (Pine's ta.rma and the Smoothed Moving Average): an EMA with k = 1/n. */
export const rma = (xs: Num[], n: number) => ema(xs, n, 1 / n);

/** Weights n for the newest value down to 1 for the oldest. */
export function wma(xs: Num[], n: number): Num[] {
  const d = (n * (n + 1)) / 2;
  return xs.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = 0; j < n; j++) {
      const x = xs[i - j];
      if (x === null) return null;
      s += x * (n - j);
    }
    return s / d;
  });
}

const zip = (a: Num[], b: Num[], f: (x: number, y: number) => number): Num[] => a.map((x, i) => (x === null || b[i] === null ? null : f(x, b[i]!)));

/** Hull: wma(2·wma(n/2) − wma(n), √n), with n/2 and √n rounded as Hyperliquid's chart does (9 gives 5 and 3, 14 gives 7 and 4). */
export const hma = (xs: Num[], n: number) => wma(zip(wma(xs, Math.max(1, Math.round(n / 2))), wma(xs, n), (h, f) => 2 * h - f), Math.max(1, Math.round(Math.sqrt(n))));

export const vwma = (xs: Num[], vol: number[], n: number) => zip(sma(zip(xs, vol, (x, v) => x * v), n), sma(vol, n), (pv, v) => pv / v).map((x) => (Number.isFinite(x) ? x : null));

/** Population standard deviation over n values (Pine's ta.stdev). */
export function stdev(xs: Num[], n: number): Num[] {
  const mean = sma(xs, n);
  return mean.map((m, i) => {
    if (m === null) return null;
    let s = 0;
    for (let j = 0; j < n; j++) s += (xs[i - j]! - m) ** 2;
    return Math.sqrt(s / n);
  });
}

export type Source = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';
const SOURCES: Record<Source, (b: Bar) => number> = {
  open: (b) => b.open, high: (b) => b.high, low: (b) => b.low, close: (b) => b.close,
  hl2: (b) => (b.high + b.low) / 2, hlc3: (b) => (b.high + b.low + b.close) / 3, ohlc4: (b) => (b.open + b.high + b.low + b.close) / 4
};
export const source = (bars: Bar[], s: Source = 'close') => bars.map(SOURCES[s]);

/** True range; the first bar has no previous close, so it is high − low. */
export const tr = (bars: Bar[]) => bars.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low));
export const atr = (bars: Bar[], n: number) => rma(tr(bars), n);

export type Anchor = 'Session' | 'Week' | 'Month' | 'Quarter' | 'Year';
/** Start of the anchor period holding t, in UTC; weeks start on Monday. */
export function anchorStart(t: number, anchor: Anchor): number {
  const day = Math.floor(t / DAY) * DAY;
  if (anchor === 'Session') return day;
  if (anchor === 'Week') return day - ((Math.floor(t / DAY) + 3) % 7) * DAY;
  const d = new Date(t);
  const m = d.getUTCMonth();
  return Date.UTC(d.getUTCFullYear(), anchor === 'Month' ? m : anchor === 'Quarter' ? m - (m % 3) : 0, 1);
}

/** Σ(src·v)/Σv, reset at each anchor period; null while the period has no volume, and for a period that began before `since` (its first bars were never loaded). */
export function vwap(bars: Bar[], since = -Infinity, anchor: Anchor = 'Session', src: Source = 'hlc3'): Num[] {
  let start = NaN;
  let pv = 0;
  let vol = 0;
  return bars.map((b) => {
    const s = anchorStart(b.time, anchor);
    if (s !== start) [start, pv, vol] = [s, 0, 0];
    pv += SOURCES[src](b) * b.volume;
    vol += b.volume;
    return vol > 0 && s >= since ? pv / vol : null;
  });
}

export function rsi(closes: Num[], n: number): Num[] {
  let gain = 0, loss = 0;
  return closes.map((close, i) => {
    if (!i || close === null || closes[i - 1] === null) return null;
    const delta = close - closes[i - 1]!;
    if (i <= n) {
      gain += Math.max(delta, 0) / n;
      loss += Math.max(-delta, 0) / n;
    } else {
      gain = (gain * (n - 1) + Math.max(delta, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-delta, 0)) / n;
    }
    return i < n ? null : loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
  });
}

/** 100·(x − lowest low)/(highest high − lowest low) over n bars; null on a flat window, as Pine's ta.stoch. */
export function stoch(xs: Num[], high: Num[], low: Num[], n: number): Num[] {
  return xs.map((x, i) => {
    if (x === null || i < n - 1) return null;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (high[j] === null || low[j] === null) return null;
      hh = Math.max(hh, high[j]!);
      ll = Math.min(ll, low[j]!);
    }
    return hh === ll ? null : (100 * (x - ll)) / (hh - ll);
  });
}

export function macd(xs: Num[], fast: number, slow: number, signal: number) {
  const m = zip(ema(xs, fast), ema(xs, slow), (f, s) => f - s);
  const sig = ema(m, signal);
  return { macd: m, signal: sig, hist: zip(m, sig, (a, b) => a - b) };
}

/** Pine's ta.supertrend(factor, n) on hl2: dir −1 is an up trend (the line is the lower band), 1 a down trend. */
export function supertrend(bars: Bar[], factor: number, n: number) {
  const a = atr(bars, n);
  const value: Num[] = [];
  const dir: Num[] = [];
  let up = 0, down = 0, prev: Num = null;
  bars.forEach((b, i) => {
    if (a[i] === null) return void (value.push(null), dir.push(null));
    const mid = (b.high + b.low) / 2;
    const close1 = bars[i - 1]?.close ?? 0;
    const lo = mid - factor * a[i]!;
    const hi = mid + factor * a[i]!;
    const [up1, down1] = [up, down];
    up = lo > up1 || close1 < up1 ? lo : up1;
    down = hi < down1 || close1 > down1 ? hi : down1;
    const d = a[i - 1] == null ? 1 : prev === down1 ? (b.close > down ? -1 : 1) : b.close < up ? 1 : -1;
    prev = d === -1 ? up : down;
    value.push(prev);
    dir.push(d);
  });
  return { value, dir };
}

export function sar(bars: Bar[], start: number, increment: number, maximum: number): Num[] {
  let value = 0, extreme = 0, acceleration = start;
  let below = false;
  return bars.map((b, i) => {
    if (!i) return null;
    let first = i === 1;
    if (first) {
      below = b.close > bars[i - 1].close;
      extreme = below ? b.high : b.low;
      value = below ? bars[i - 1].low : bars[i - 1].high;
    }
    value += acceleration * (extreme - value);
    if (below ? value > b.low : value < b.high) {
      value = below ? Math.max(b.high, extreme) : Math.min(b.low, extreme);
      below = !below;
      extreme = below ? b.high : b.low;
      acceleration = start;
      first = true;
    }
    if (!first && (below ? b.high > extreme : b.low < extreme)) {
      extreme = below ? b.high : b.low;
      acceleration = Math.min(acceleration + increment, maximum);
    }
    const prior = bars.slice(Math.max(0, i - 2), i);
    value = below ? Math.min(value, ...prior.map((p) => p.low)) : Math.max(value, ...prior.map((p) => p.high));
    return value;
  });
}
