import { emitter } from '$lib/util/emitter';
import { num } from '$lib/util/parse';

export interface Trade { px: number; sz: number; side: 'B' | 'A'; time: number; tid: number }
export const trades = $state({ list: [] as Trade[] });
/** The chart coin's new trades of each message, oldest first, every one of them (the list keeps only the newest 100). */
export const tradeEvents = emitter<Trade[]>();

export const parseTrade = (t: any): Trade => ({ px: num(t.px, 'px'), sz: num(t.sz, 'sz'), side: t.side === 'B' ? 'B' : 'A', time: num(t.time, 'time'), tid: num(t.tid, 'tid') });

export function applyTrades(d: any[]) {
  const seen = new Set(trades.list.map((t) => t.tid));
  const fresh = d.map(parseTrade).filter((t) => !seen.has(t.tid));
  trades.list = [...fresh.toReversed(), ...trades.list].slice(0, 100);
  tradeEvents.emit(fresh);
}
