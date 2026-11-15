import type { Bar } from '$lib/market/candles';
import { ema, sma, vwap, type Num } from '$lib/market/indicators';
import type { SetupId } from './setups.svelte';

export interface Correlation { r: number | null; n: number; reason: string }
export interface StrategyMetric { id: SetupId; forward: Correlation; signals: number }
export const METHODS: Record<SetupId, string> = {
  vwap: 'UTC session VWAP reclaim or rejection after a close on the other side.',
  breakout: 'Retest of the first 15 minutes of the UTC day, after a close outside the range. Requires an interval of 15m or less.',
  sweep: 'A sweep and close back inside the previous 20-bar high or low.',
  pullback: '9/21 EMA trend alignment with a touch and directional close through the fast EMA.',
  triple: 'Bullish 7 > 30 > 99 SMA stack or the reverse bearish stack, with price beyond the fast SMA.'
};
const IDS = Object.keys(METHODS) as SetupId[];
const DAY = 864e5;
const MIN_PAIRS = 30;

function correlation(x: Num[], y: Num[]): Correlation {
  let n = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i], b = y[i];
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    n++;
    const dx = a - mx, dy = b - my;
    mx += dx / n;
    my += dy / n;
    xx += dx * (a - mx);
    yy += dy * (b - my);
    xy += dx * (b - my);
  }
  if (n < MIN_PAIRS) return { r: null, n, reason: 'At least 30 paired observations are required.' };
  if (!(xx > 0 && yy > 0)) return { r: null, n, reason: 'No variation in the signal or returns.' };
  return { r: Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy))), n, reason: '' };
}

export function strategyMetrics(input: Bar[], step: number, horizon: number) {
  const source = input.slice(-Math.max(599, Math.ceil(DAY / step) + 99));
  const valid = Number.isFinite(step) && step > 0 && [1, 5, 15].includes(horizon) && source.every((b, i) =>
    [b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) && b.open > 0 && b.close > 0 && b.low > 0 && b.volume >= 0 && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && (!i || b.time > source[i - 1].time));
  const bars = valid ? source : [];
  const close = bars.map((b) => b.close);
  const fast = sma(close, 7), middle = sma(close, 30), slow = sma(close, 99);
  const e9 = ema(close, 9), e21 = ema(close, 21);
  const vw = vwap(bars, bars[0]?.time ?? Infinity);
  const scores = Object.fromEntries(IDS.map((id) => [id, bars.map((): Num => null)])) as Record<SetupId, Num[]>;
  let day = NaN, high = -Infinity, low = Infinity, opened = false, rangeBars = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1], start = Math.floor(b.time / DAY) * DAY;
    if (start !== day) { day = start; high = -Infinity; low = Infinity; opened = b.time === start; rangeBars = 0; }
    if (b.time < start + 15 * 6e4) { high = Math.max(high, b.high); low = Math.min(low, b.low); rangeBars++; }
    else if (step <= 15 * 6e4 && 15 * 6e4 % step === 0 && opened && rangeBars === 15 * 6e4 / step && prev) {
      scores.breakout[i] = prev.close > high && b.low <= high && b.close > high ? 1 : prev.close < low && b.high >= low && b.close < low ? -1 : 0;
    }
    if (i && vw[i] !== null && vw[i - 1] !== null && Math.floor(prev.time / DAY) * DAY === start) {
      scores.vwap[i] = prev.close <= vw[i - 1]! && b.close > vw[i]! && b.low <= vw[i]! ? 1 : prev.close >= vw[i - 1]! && b.close < vw[i]! && b.high >= vw[i]! ? -1 : 0;
    }
    if (e9[i] !== null && e21[i] !== null) scores.pullback[i] = e9[i]! > e21[i]! && b.low <= e9[i]! && b.close > e9[i]! && b.close > b.open ? 1 : e9[i]! < e21[i]! && b.high >= e9[i]! && b.close < e9[i]! && b.close < b.open ? -1 : 0;
    if (slow[i] !== null) scores.triple[i] = fast[i]! > middle[i]! && middle[i]! > slow[i]! && b.close > fast[i]! ? 1 : fast[i]! < middle[i]! && middle[i]! < slow[i]! && b.close < fast[i]! ? -1 : 0;
    if (i >= 20) {
      const prior = bars.slice(i - 20, i);
      const lo = Math.min(...prior.map((p) => p.low)), hi = Math.max(...prior.map((p) => p.high));
      const buy = b.low < lo && b.close > lo, sell = b.high > hi && b.close < hi;
      scores.sweep[i] = buy && sell ? null : buy ? 1 : sell ? -1 : 0;
    }
  }
  const from = Math.max(0, bars.length - 500);
  const forward = bars.map((b, i): Num => {
    const next = bars[i + horizon];
    return next && b.close > 0 && bars.slice(i + 1, i + horizon + 1).every((bar, j) => bar.time === b.time + step * (j + 1)) ? next.close / b.close - 1 : null;
  }).slice(from);
  const window = Object.fromEntries(IDS.map((id) => [id, scores[id].slice(from)])) as Record<SetupId, Num[]>;
  return {
    error: valid ? '' : 'Chart data is invalid or out of order. Reload history before using these metrics.',
    bars: bars.length - from, from: bars[from]?.time ?? null, to: bars.at(-1)?.time ?? null,
    strategies: IDS.map((id): StrategyMetric => ({ id, forward: correlation(window[id], forward), signals: window[id].filter((s) => s !== null && s !== 0).length })),
    overlap: IDS.map((a) => IDS.map((b) => correlation(window[a], window[b])))
  };
}
