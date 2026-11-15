import { asset } from '$lib/market/meta.svelte';
import { roundPx, roundSz } from '$lib/signing/wire';
import { settings } from '$lib/settings/settings.svelte';
import { ticket } from './ticket.svelte';
import type { Draft } from './market';

/** Blank falls back to the caller's default; a typo is refused rather than silently replaced. */
export function optPx(text: string, field: string): number | null {
  if (!text.trim()) return null;
  const v = Number(text);
  if (!(Number.isFinite(v) && v > 0)) throw new Error(`invalid ${field} price`);
  return v;
}

/** The ticket's TP/SL legs for an entry (typed prices; a blank leg is left out), or none while the ticket's TP/SL is off. */
export function ticketExits(coin: string, isBuy: boolean, entryPx: number, size: number): Draft[] {
  if (!ticket.tpsl) return [];
  const dir = isBuy ? 1 : -1;
  const tp = optPx(ticket.tp, 'TP');
  const sl = optPx(ticket.sl, 'SL');
  if (tp === null && sl === null) throw new Error('enter a TP or SL price, or turn TP/SL off');
  const [above, below, who] = isBuy ? ['above', 'below', 'long'] : ['below', 'above', 'short'];
  if (tp !== null && dir * (tp - entryPx) <= 0) throw new Error(`TP must be ${above} entry for a ${who}`);
  if (sl !== null && dir * (sl - entryPx) >= 0) throw new Error(`SL must be ${below} entry for a ${who}`);
  return tpslDrafts(coin, isBuy, size, tp, sl, settings.tpsl.slippage);
}

/** Exit legs for grouping 'normalTpsl': reduce-only market triggers with a worst-acceptable limit. */
export function tpslDrafts(coin: string, entryIsBuy: boolean, sz: number, tp: number | null, sl: number | null, slippage: number): Draft[] {
  for (const [name, v] of [['take-profit', tp], ['stop-loss', sl]] as const)
    if (v !== null && !(Number.isFinite(v) && v > 0)) throw new Error(`invalid ${name} price`);
  const a = asset(coin);
  const exitIsBuy = !entryIsBuy;
  const leg = (trigger: number, tpsl: 'tp' | 'sl'): Draft => ({
    isBuy: exitIsBuy,
    px: roundPx(trigger * (exitIsBuy ? 1 + slippage : 1 - slippage), a, exitIsBuy),
    sz: roundSz(sz, a.szDecimals),
    reduceOnly: true,
    type: { trigger: { isMarket: true, triggerPx: roundPx(trigger, a, exitIsBuy), tpsl } }
  });
  return [...(tp ? [leg(tp, 'tp')] : []), ...(sl ? [leg(sl, 'sl')] : [])];
}
