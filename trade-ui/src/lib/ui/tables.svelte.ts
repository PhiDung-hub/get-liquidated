import { MediaQuery } from 'svelte/reactivity';
import { market } from '$lib/market/market.svelte';
import { openSweep, type SweepKind } from '$lib/orders/sweep.svelte';
import { toast } from './toast.svelte';

/** Cards instead of tables: phones, including one held sideways wider than the 900px phone layout. */
export const cards = new MediaQuery('(max-width: 900px), (pointer: coarse) and (max-height: 500px)');

export type AccountSide = 'all' | 'long' | 'short';
/** The open tab's Expand All, while it has cards to open. */
export const cardFold = $state({ open: false, run: null as (() => void) | null });

/** The phone order cards' sort: value high to low, coin A–Z or newest first. */
export const cardSort = $state({ orders: 'value' });
export const accountView = $state({ coin: '', side: 'all' as AccountSide });
// 'active' follows the chart's coin, as Hyperliquid's Active filter does.
const filterCoin = () => (accountView.coin === 'active' ? market.coin : accountView.coin);
export const inFilter = (coin: string, long?: boolean) => {
  const selected = filterCoin();
  return (!selected || coin === selected) && (accountView.side === 'all' || long === undefined || long === (accountView.side === 'long'));
};
/** `filtered`: Cancel All takes the tab's coin and side filter as it stands, with no checklist. */
export function sweepOf(e: MouseEvent, kind: SweepKind, filtered = false) {
  (e.currentTarget as HTMLElement).blur();
  try {
    openSweep(kind, filtered ? { coin: filterCoin(), isBuy: accountView.side === 'all' ? undefined : accountView.side === 'long' } : null);
  } catch (err) {
    toast.error((err as Error).message);
  }
}

export type Column<T> = { key: string; label: string; value: (r: T) => string | number | null; title?: string };
/** Header-click sorting: a first click ascends (time descends), a second flips; empty values sort last either way. */
export class Sorter<T> {
  key = $state('');
  desc = $state(true);
  constructor(readonly columns: Column<T>[], key: string, private tie: (a: T, b: T) => number = () => 0) {
    this.key = key;
  }
  toggle(key: string) {
    this.desc = this.key === key ? !this.desc : key === 'time';
    this.key = key;
  }
  sort(rows: T[], key = this.key, desc = this.desc): T[] {
    const value = this.columns.find((c) => c.key === key)?.value;
    if (!value) return rows;
    return [...rows].sort((a, b) => {
      const x = value(a), y = value(b);
      if (x === null || y === null) return x === y ? this.tie(a, b) : x === null ? 1 : -1;
      const order = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y);
      return (desc ? -order : order) || this.tie(a, b);
    });
  }
}
