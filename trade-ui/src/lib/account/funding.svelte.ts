import { arr, num, str } from '$lib/util/parse';

export interface Funding { time: number; coin: string; usdc: number; szi: number; rate: number }
const LIMIT = 500;
export const FUNDING_DAY_MS = 86_400_000;
export const funding = $state({ list: [] as Funding[], ready: false });

export function applyFundings(d: any) {
  const rows = arr<any>(d.fundings, 'fundings').map((f) => ({
    time: num(f.time, 'time'), coin: str(f.coin, 'coin'), usdc: num(f.usdc, 'usdc'), szi: num(f.szi, 'szi'), rate: num(f.fundingRate, 'fundingRate')
  }));
  const merged = d.isSnapshot ? rows : [...rows, ...funding.list];
  const unique = [...new Map(merged.map((f) => [`${f.time}:${f.coin}`, f])).values()];
  funding.list = unique.sort((a, b) => b.time - a.time).slice(0, LIMIT);
  if (d.isSnapshot) funding.ready = true;
}

export function dailyFunding(start: number): Map<string, number> | null {
  const { list, ready } = funding;
  if (!ready || (list.length === LIMIT && list[LIMIT - 1].time >= start)) return null;
  const totals = new Map<string, number>();
  for (const { time, coin, usdc } of list) {
    if (time < start) break;
    if (time < start + FUNDING_DAY_MS) totals.set(coin, (totals.get(coin) ?? 0) + usdc);
  }
  return totals;
}
