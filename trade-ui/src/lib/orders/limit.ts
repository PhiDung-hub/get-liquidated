import type { Tif } from '$lib/exchange/actions';
import { asset } from '$lib/market/meta.svelte';
import { bbo } from '$lib/market/book.svelte';
import { roundPx, roundSz } from '$lib/signing/wire';
import type { Draft } from './market';

export function limitDraft(coin: string, isBuy: boolean, px: number, sz: number, tif: Tif, reduceOnly: boolean): Draft {
  if (!(px > 0)) throw new Error('enter a price');
  const a = asset(coin);
  return { isBuy, px: roundPx(px, a, isBuy), sz: roundSz(sz, a.szDecimals), reduceOnly, type: { tif } };
}

export function bestPx(isBuy: boolean): number {
  const px = isBuy ? bbo.bid : bbo.ask;
  if (!(px > 0)) throw new Error('no book yet');
  return px;
}
