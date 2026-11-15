import type { Tif } from '$lib/exchange/actions';
import { asset } from '$lib/market/meta.svelte';
import { roundPx, roundSz } from '$lib/signing/wire';
import { settings } from '$lib/settings/settings.svelte';
import type { TicketKind, TriggerKind } from './ticket.svelte';
import { markOf } from './size';
import type { Draft } from './market';

const TRIGGERS = new Set<TicketKind>(['stopLimit', 'stopMarket', 'takeLimit', 'takeMarket']);
export const isTrigger = (k: TicketKind): k is TriggerKind => TRIGGERS.has(k);

/** A Stop fires when the mark moves against the order's side, a Take when it moves with it; Market variants carry the slippage price as their worst fill. */
export function triggerDraft(
  coin: string, isBuy: boolean, kind: TriggerKind, triggerPx: number, limitPx: number | null, sz: number, reduceOnly: boolean, tif: Tif
): Draft {
  if (!(triggerPx > 0)) throw new Error('enter a trigger price');
  const isStop = kind === 'stopLimit' || kind === 'stopMarket';
  const isMarket = kind === 'stopMarket' || kind === 'takeMarket';
  // The trigger wire has no tif field: a triggered limit always rests as GTC.
  if (!isMarket && tif !== 'Gtc') throw new Error(`TIF ${tif.toUpperCase()} is not available on trigger orders`);
  const a = asset(coin);
  const trigger = roundPx(triggerPx, a, isBuy);
  const slip = settings.tpsl.slippage;
  const worst = isMarket ? trigger * (isBuy ? 1 + slip : 1 - slip) : (limitPx ?? 0);
  if (!(worst > 0)) throw new Error('enter a price');
  const above = isStop === isBuy;
  const mark = markOf(coin);
  if (above ? !(trigger > mark) : !(trigger < mark))
    throw new Error(`${isStop ? 'stop' : 'take'} trigger must be ${above ? 'above' : 'below'} mark for a ${isBuy ? 'buy' : 'sell'}`);
  return {
    isBuy, px: roundPx(worst, a, isBuy), sz: roundSz(sz, a.szDecimals), reduceOnly,
    type: { trigger: { isMarket, triggerPx: trigger, tpsl: isStop ? 'sl' : 'tp' } }
  };
}
