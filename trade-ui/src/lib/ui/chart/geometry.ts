/** Fractional bar index of time t: interpolated between bars, extrapolated by one interval per bar outside them. */
export function timeToLogical(times: number[], t: number, step: number): number {
  const n = times.length;
  if (!n) return NaN;
  if (t < times[0]) return (t - times[0]) / step;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const span = lo < n - 1 ? times[lo + 1] - times[lo] : step;
  return lo + (t - times[lo]) / span;
}

export function logicalToTime(times: number[], l: number, step: number): number {
  const n = times.length;
  if (!n) return NaN;
  if (l <= 0) return times[0] + l * step;
  if (l >= n - 1) return times[n - 1] + (l - n + 1) * step;
  const i = Math.floor(l);
  return times[i] + (l - i) * (times[i + 1] - times[i]);
}

export const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** Level 0 sits at the second point and 1 at the first, as TradingView draws a retracement. */
export const fibLevels = (a: number, b: number) => FIB.map((r) => ({ r, price: b + (a - b) * r }));

/** Distance from (x, y) to the segment a–b, in pixels. */
export function segDist(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = dx || dy ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(x - a.x - k * dx, y - a.y - k * dy);
}
