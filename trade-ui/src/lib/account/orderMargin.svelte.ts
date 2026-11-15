import { assetData } from './assetData.svelte';
import { positionOf } from './inventory.svelte';
import { isTrailing, type OpenOrder } from './orders.svelte';
import { isSpot, meta, quoteOf } from '$lib/market/meta.svelte';
import { market } from '$lib/market/market.svelte';

export type OrderMargin = {
  value: number | null;
  quote: string;
  kind: 'estimate' | 'none' | 'conditional' | 'spot' | 'unknown';
  note: string;
  leverage?: number;
};

export function orderMargin(order: OpenOrder): OrderMargin {
  const quote = quoteOf(order.coin);
  if (isSpot(order.coin)) return { value: null, quote, kind: 'spot', note: 'Spot orders hold tokens rather than perpetuals margin.' };
  if (order.reduceOnly) return { value: 0, quote, kind: 'none', note: 'Reduce-only: no additional initial margin. This order cannot open or flip a position.' };
  if (order.isTrigger || isTrailing(order)) return { value: null, quote, kind: 'conditional', note: 'Conditional order: margin is assessed when it activates. No resting-order margin is assigned here.' };

  const leverage = (market.coin === order.coin && assetData.coin === order.coin ? assetData.leverage : null) ?? positionOf(order.coin)?.leverage;
  if (!leverage || !Number.isFinite(leverage.value) || leverage.value <= 0) return { value: null, quote, kind: 'unknown', note: 'Current account leverage is unavailable for this market. Select the market to load it; maximum leverage is not used as a substitute.' };
  const mark = meta.ctxs.get(order.coin)?.markPx;
  if (typeof mark !== 'number' || !Number.isFinite(mark) || mark <= 0 || !Number.isFinite(order.sz) || order.sz < 0) return { value: null, quote, kind: 'unknown', note: 'A valid current mark price and remaining order size are needed to estimate initial margin.' };
  const value = order.sz * mark / leverage.value;
  if (!Number.isFinite(value)) return { value: null, quote, kind: 'unknown', note: 'The order margin estimate could not be calculated from the current account data.' };
  return {
    value, quote, kind: 'estimate', leverage: leverage.value,
    note: `Estimated initial margin: full remaining size × current mark price ÷ ${leverage.value}× ${leverage.type} leverage. Reductions, flips and position offsets may need less. This is not Hyperliquid's exact reserved margin; shared collateral and other orders mean row estimates are not additive allocations.`
  };
}
