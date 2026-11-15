import type { Grouping } from '$lib/exchange/actions';
import { settings } from '$lib/settings/settings.svelte';
import { ticket, type TicketKind } from './ticket.svelte';
import { isSpot } from '$lib/market/meta.svelte';
import { aggressorRef, freshRef, TRIGGER_SPOT } from './execute';
import { bestPx, limitDraft } from './limit';
import { marketDraft, type Draft } from './market';
import { refPx } from './size';
import { optPx, ticketExits } from './tpsl';
import { isTrigger, triggerDraft } from './trigger';

export const marketEntry = async (c: string, isBuy: boolean, sz: number) =>
  marketDraft(c, isBuy, sz, freshRef(c, isBuy) ?? (await aggressorRef(c, isBuy)), { slippage: settings.market.slippage, reduceOnly: ticket.reduceOnly });

export function withExits(c: string, isBuy: boolean, kind: 'market' | 'limit', d: Draft): [Draft[], Grouping] {
  const exits = isSpot(c) ? [] : ticketExits(c, isBuy, kind === 'market' ? refPx(c) : d.px, d.sz);
  return [[d, ...exits], exits.length ? 'normalTpsl' : 'na'];
}

/** The ticket's single order; Market and Limit carry the ticket's TP/SL as a normalTpsl group. A Stop Limit with TP/SL is refused until HL is proven to accept a trigger parent (tests/testnet). */
export async function ticketDrafts(c: string, isBuy: boolean, k: Exclude<TicketKind, 'chase' | 'scale'>, size: number): Promise<[Draft[], Grouping]> {
  if (isSpot(c) && isTrigger(k)) throw new Error(TRIGGER_SPOT);
  const trigger = isTrigger(k) ? (optPx(ticket.trigger, 'trigger') ?? 0) : 0;
  const limit = k === 'stopLimit' || k === 'takeLimit' ? optPx(ticket.px, 'limit') : null;
  const entry = isTrigger(k)
    ? triggerDraft(c, isBuy, k, trigger, limit, size, ticket.reduceOnly, 'Gtc')
    : k === 'market'
      ? await marketEntry(c, isBuy, size)
      : limitDraft(c, isBuy, optPx(ticket.px, 'limit') ?? bestPx(isBuy), size, ticket.tif, ticket.reduceOnly);
  if (k === 'stopLimit' && ticket.tpsl) throw new Error('TP/SL on a Stop Limit is not verified on Hyperliquid: turn TP/SL off to send the entry alone');
  if (isTrigger(k)) return [[entry], 'na'];
  return withExits(c, isBuy, k, entry);
}
