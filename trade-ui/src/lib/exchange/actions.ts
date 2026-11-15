import { floatToWire } from '$lib/signing/wire';

export type Tif = 'Alo' | 'Ioc' | 'Gtc';
export type Trigger = { isMarket: boolean; triggerPx: number; tpsl: 'tp' | 'sl' };
export interface OrderSpec {
  asset: number; isBuy: boolean; px: number; sz: number; reduceOnly: boolean;
  type: { tif: Tif } | { trigger: Trigger }; cloid?: string;
}
export interface OrderWire {
  a: number; b: boolean; p: string; s: string; r: boolean;
  t: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };
  c?: string;
}
export type Grouping = 'na' | 'normalTpsl' | 'positionTpsl';

// Key order is the server's hashing order (python SDK order_request_to_order_wire); do not reorder.
export function orderWire(o: OrderSpec): OrderWire {
  const t: OrderWire['t'] = 'tif' in o.type
    ? { limit: { tif: o.type.tif } }
    : { trigger: { isMarket: o.type.trigger.isMarket, triggerPx: floatToWire(o.type.trigger.triggerPx), tpsl: o.type.trigger.tpsl } };
  const w: OrderWire = { a: o.asset, b: o.isBuy, p: floatToWire(o.px), s: floatToWire(o.sz), r: o.reduceOnly, t };
  if (o.cloid) w.c = o.cloid;
  return w;
}

export const orderAction = (orders: OrderWire[], grouping: Grouping = 'na') => ({ type: 'order' as const, orders, grouping });
export const cancelAction = (cancels: { a: number; o: number }[]) => ({ type: 'cancel' as const, cancels });
export const cancelByCloidAction = (cancels: { asset: number; cloid: string }[]) => ({ type: 'cancelByCloid' as const, cancels });
// `a` (always_place) is deliberately never set: with it a filled order is re-placed and overfills.
export const batchModifyAction = (modifies: { oid: number | string; order: OrderWire }[]) => ({ type: 'batchModify' as const, modifies });
export const updateLeverageAction = (asset: number, isCross: boolean, leverage: number) => ({ type: 'updateLeverage' as const, asset, isCross, leverage });
// ntli is signed micro-USD: positive adds margin, negative removes it.
export const updateIsolatedMarginAction = (asset: number, isBuy: boolean, ntli: number) => ({ type: 'updateIsolatedMargin' as const, asset, isBuy, ntli });
export const noopAction = () => ({ type: 'noop' as const });
export type Retracement = { pct: number } | { px: number };
// Key order and the always-present null activationPx are HL's hashing order; pct is its 4dp percent string.
export const trailingStopAction = (asset: number, isBuy: boolean, sz: number, retracement: Retracement, activationPx: number | null) => ({
  type: 'trailingStop' as const, asset, isBuy, sz: floatToWire(sz), reduceOnly: true,
  retracement: 'pct' in retracement ? { pct: `${retracement.pct.toFixed(4)}%` } : { px: floatToWire(retracement.px) },
  activationPx: activationPx === null ? null : floatToWire(activationPx)
});

export type Action = ReturnType<
  typeof orderAction | typeof cancelAction | typeof cancelByCloidAction | typeof batchModifyAction | typeof updateLeverageAction | typeof updateIsolatedMarginAction | typeof noopAction | typeof trailingStopAction
>;
