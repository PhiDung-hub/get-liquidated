import { arr, num, str } from '$lib/util/parse';

export interface Funding { time: number; coin: string; usdc: number; szi: number; rate: number }
export const funding = $state({ list: [] as Funding[] });

export function applyFundings(d: any) {
  const rows = arr<any>(d.fundings, 'fundings').map((f) => ({
    time: num(f.time, 'time'), coin: str(f.coin, 'coin'), usdc: num(f.usdc, 'usdc'), szi: num(f.szi, 'szi'), rate: num(f.fundingRate, 'fundingRate')
  }));
  const merged = d.isSnapshot ? rows : [...rows, ...funding.list];
  const unique = [...new Map(merged.map((f) => [`${f.time}:${f.coin}`, f])).values()];
  funding.list = unique.sort((a, b) => b.time - a.time).slice(0, 500);
}
