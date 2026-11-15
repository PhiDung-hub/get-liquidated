import { asset } from '$lib/market/meta.svelte';
import { roundPx, roundSz } from '$lib/signing/wire';
import type { Draft } from './market';

export interface ScaleInput { coin: string; isBuy: boolean; from: number; to: number; count: number; totalSz: number; skew: number; shape: 'linear' | 'exp'; reduceOnly: boolean }

/** `skew` = last child size / first child size; 1 is flat. */
export function scaleDrafts(i: ScaleInput): Draft[] {
  if (!Number.isInteger(i.count) || i.count < 2 || i.count > 50) throw new Error('scale count must be 2–50');
  if (!(i.from > 0 && i.to > 0 && i.totalSz > 0 && i.skew > 0)) throw new Error('scale needs positive prices, size and skew');
  const a = asset(i.coin);
  const steps = i.count - 1;
  const weights = Array.from({ length: i.count }, (_, k) => (i.shape === 'exp' ? i.skew ** (k / steps) : 1 + ((i.skew - 1) * k) / steps));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, k) => ({
    isBuy: i.isBuy,
    px: roundPx(i.from + ((i.to - i.from) * k) / steps, a, i.isBuy),
    sz: roundSz((i.totalSz * w) / total, a.szDecimals),
    reduceOnly: i.reduceOnly,
    type: { tif: 'Alo' as const }
  }));
}

export function scaleRange(isBuy: boolean, ref: number, rangePct: number, offsetPct: number) {
  const dir = isBuy ? -1 : 1;
  return { from: ref * (1 + (dir * offsetPct) / 100), to: ref * (1 + (dir * (offsetPct + rangePct)) / 100) };
}
