import { applyOrderUpdate, ledger, seen } from '$lib/exchange/ledger.svelte';
import { viewAddress } from '$lib/session/session.svelte';
import { filledSizeOf, type Fill } from './fills.svelte';
import { fed } from './inventory.svelte';
import { arr, num, str } from '$lib/util/parse';

export interface OpenOrder {
  coin: string; side: 'B' | 'A'; limitPx: number; sz: number; origSz: number; origSzKnown?: boolean; oid: number; cloid?: string; timestamp: number;
  reduceOnly: boolean; isTrigger: boolean; triggerPx: number; orderType: string; tif: string | null; triggerCondition: string;
}
export const openOrders = $state({ list: [] as OpenOrder[], loaded: false });

export function fillProgress(f: Fill) {
  const order = openOrders.list.find(o => o.oid === f.oid && o.coin === f.coin && o.side === f.side);
  const entry = ledger.entries.find(e => e.user === viewAddress() && e.coin === f.coin && e.isBuy === (f.side === 'B')
    && (e.oid === f.oid || (e.oid === undefined && f.cloid && e.cloid === f.cloid)));
  const total = (order?.origSzKnown && order.origSz > 0 && order.origSz >= order.sz ? order.origSz : undefined) ?? entry?.sz;
  if (!(total !== undefined && total > 0)) return null;
  const filled = Math.min(total, Math.max(filledSizeOf(f), entry?.filledSz ?? 0, order ? total - order.sz : 0));
  const remaining = Math.max(0, total - filled);
  const terminal = entry && (entry.state === 'filled' || entry.state === 'canceled' || entry.state === 'error');
  const working = !terminal && (!!order || entry?.state === 'resting');
  return { total, filled, remaining, working, partial: remaining > Math.max(1e-9, total * 1e-9) };
}

const order = (o: any): OpenOrder => ({
  coin: str(o.coin, 'coin'), side: o.side === 'B' ? 'B' : 'A', limitPx: num(o.limitPx, 'limitPx'), sz: num(o.sz, 'sz'),
  origSz: num(o.origSz ?? o.sz, 'origSz'), origSzKnown: o.origSz != null, oid: num(o.oid, 'oid'), cloid: o.cloid ?? undefined, timestamp: num(o.timestamp, 'timestamp'),
  reduceOnly: !!o.reduceOnly, isTrigger: !!o.isTrigger, triggerPx: Number(o.triggerPx ?? 0), orderType: o.orderType ?? 'Limit', tif: o.tif ?? null,
  triggerCondition: o.triggerCondition ?? ''
});
/** By type, never isTrigger: what a live row carries there is unknown. Not an SL: its trigger moves, and it can neither be moved nor edited. */
export const isTrailing = (o: { oid: number; orderType?: string }) => o.orderType === 'Trailing Stop Market';

// One part per feed: a single ALL_DEXS feed, or one per dex when HL refuses it. Each push replaces its own part.
const parts = new Map<string, OpenOrder[]>();
let feeds = 1;

export function resetOrders(n = 1) {
  parts.clear();
  feeds = n;
  Object.assign(openOrders, { list: [], loaded: false });
}

export function applyOpenOrders(d: any) {
  parts.set(feeds === 1 ? '' : String(d.dex ?? ''), arr<any>(d.orders, 'orders').map(order));
  Object.assign(openOrders, { list: [...parts.values()].flat(), loaded: parts.size >= feeds });
  seen(openOrders.list);
  fed();
}

export function applyOrderUpdates(d: any[]) {
  for (const u of d) applyOrderUpdate(u.order?.cloid ?? undefined, str(u.status, 'status'), num(u.order?.oid, 'oid'), u.order);
  fed();
}
