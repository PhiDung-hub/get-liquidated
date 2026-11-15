import { asset, isSpot, meta, nameOf, symOf } from '$lib/market/meta.svelte';
import { market } from '$lib/market/market.svelte';
import { bbo, book } from '$lib/market/book.svelte';
import { freeOf, inventory, positionOf } from '$lib/account/inventory.svelte';
import { assetData } from '$lib/account/assetData.svelte';
import { feeFor } from '$lib/account/fees.svelte';
import { ticket } from './ticket.svelte';
import { settings, type Sizing } from '$lib/settings/settings.svelte';
import { roundPx, roundSz } from '$lib/signing/wire';

export function markOf(coin: string): number {
  const mark = coin === market.coin ? market.ctx?.markPx : meta.ctxs.get(coin)?.markPx;
  if (!mark) throw new Error(`no mark for ${coin}`);
  return mark;
}

export function refPx(coin: string): number {
  if (coin === market.coin && bbo.bid > 0 && bbo.ask > 0) return (bbo.bid + bbo.ask) / 2;
  return markOf(coin);
}

/** The live mid rounded toward your own side: with a one-tick spread that is the bid for a buy and the ask for a sell, so it never crosses. */
export function midPx(isBuy: boolean): number {
  if (!(bbo.bid > 0 && bbo.ask > 0)) throw new Error('no book yet');
  return roundPx((bbo.bid + bbo.ask) / 2, asset(market.coin), isBuy);
}

/** Coin to USDC rounds to cents; USDC to coin floors to szDecimals. */
export function convertSize(coin: string, v: number, to: 'coin' | 'usd'): number {
  const ref = refPx(coin);
  return to === 'usd' ? Number((v * ref).toFixed(2)) : roundSz(v / ref, asset(coin).szDecimals);
}

/** Average fill of a market order walking the live best level, then the merged book; null when the shown depth cannot fill it. */
export function estFill(isBuy: boolean, sz: number): number | null {
  const best = isBuy ? bbo.ask : bbo.bid;
  // Grouped buckets are coarse and the one past the best already holds the bbo size.
  if (!(best > 0 && sz > 0) || book.bin !== null) return null;
  // A book level at or inside the live best is stale; counting it would fill the same size twice.
  const deeper = (isBuy ? book.asks : book.bids).filter((l) => (isBuy ? l.px > best : l.px < best));
  let left = sz;
  let cost = 0;
  for (const l of [{ px: best, sz: isBuy ? bbo.askSz : bbo.bidSz }, ...deeper]) {
    const take = Math.min(left, l.sz);
    cost += take * l.px;
    left -= take;
    if (left <= 1e-9 * sz) return cost / sz;
  }
  return null;
}

export const ticketSizing = (): Sizing => ({ value: ticket.size, unit: ticket.unit, basis: ticket.basis });

/** The price a spot market buy holds its quote at: the ask plus slippage, which caps marketDraft's price. */
export const marketBuyPx = (coin: string) => (coin === market.coin && bbo.ask > 0 ? bbo.ask : refPx(coin)) * (1 + settings.market.slippage);

/** On spot: the free quote at `px`, the price the buy holds it at (the mid unless given), on a buy; the free base on a sell.
 * On perps: HL's maxTradeSzs, which it sizes at the mark with no fee, cut to what margin and the taker fee cover at `px`, the order's price. */
export function maxSize(coin: string, isBuy: boolean, reduceOnly = ticket.reduceOnly, held?: number, px?: number): number {
  const a = meta.byName.get(coin);
  if (a?.spot) return roundSz(isBuy ? freeOf(a.collateral) / (px || refPx(coin)) : freeOf(a.base), a.szDecimals);
  if (reduceOnly) {
    const szi = held ?? positionOf(coin)?.szi ?? 0;
    return (isBuy ? szi < 0 : szi > 0) ? Math.abs(szi) : 0;
  }
  if (assetData.coin !== coin) return 0;
  const mark = (coin === market.coin ? market.ctx?.markPx : meta.ctxs.get(coin)?.markPx) ?? 0;
  const past = px && mark > 0 && px > mark ? mark / px : 1;
  return (assetData.maxTradeSzs[isBuy ? 0 : 1] * past) / (1 + (assetData.leverage?.value ?? 1) * feeFor(coin).taker);
}

// HYPE and HYPE/USDC share a base name, so a spot coin is named as its pair.
const label = (coin: string) => (isSpot(coin) ? nameOf(coin) : symOf(coin));
function rawSize(coin: string, isBuy: boolean, s: Sizing, held?: number, px?: number): number {
  if (s.unit === 'coin' && s.coin && s.coin !== coin) throw new Error(`size is ${s.value} ${label(s.coin)} and ${label(coin)} is selected — set it in Settings › Execution`);
  if (s.unit === 'coin') return s.value;
  if (s.unit === 'usd') return s.value / refPx(coin);
  if (isSpot(coin)) {
    if (s.basis === 'position') throw new Error(`% of position is perps-only: use % of balance on ${nameOf(coin)}`);
    if (!inventory.spotLoaded) throw new Error('spot balances not loaded yet');
    return maxSize(coin, isBuy, false, undefined, px) * (s.value / 100);
  }
  if (ticket.reduceOnly) return maxSize(coin, isBuy, true, held) * Math.min(s.value / 100, 1);
  if (s.basis === 'position') return Math.abs(held ?? positionOf(coin)?.szi ?? 0) * (s.value / 100);
  if (assetData.coin !== coin) throw new Error(coin === market.coin ? `% of balance: ${symOf(coin)} account data not loaded yet` : `% of balance needs ${coin} selected`);
  return maxSize(coin, isBuy, false, undefined, px) * (s.value / 100);
}

/** `held`, the signed position, defaults to the feed's; `px` is the order's price (on spot, the price a buy holds its quote at). */
export const resolveSize = (coin: string, isBuy: boolean, s = ticketSizing(), held?: number, px?: number) => roundSz(rawSize(coin, isBuy, s, held, px), asset(coin).szDecimals);
