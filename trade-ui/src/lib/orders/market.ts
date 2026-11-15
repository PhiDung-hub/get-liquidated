import type { OrderSpec } from '$lib/exchange/actions';
import { asset } from '$lib/market/meta.svelte';
import { roundPx, roundSz } from '$lib/signing/wire';

export type Draft = Omit<OrderSpec, 'asset' | 'cloid'>;

/** Market = IOC limit at the aggressor reference ± slippage, rounded so it never pays more than the cap. */
export function marketDraft(coin: string, isBuy: boolean, sz: number, ref: number, opts: { slippage: number; reduceOnly: boolean }): Draft {
  if (!(ref > 0)) throw new Error(`no price for ${coin}`);
  const a = asset(coin);
  const px = roundPx(ref * (isBuy ? 1 + opts.slippage : 1 - opts.slippage), a, isBuy);
  return { isBuy, px, sz: roundSz(sz, a.szDecimals), reduceOnly: opts.reduceOnly, type: { tif: 'Ioc' } };
}
