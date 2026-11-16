import { inventory } from '$lib/account/inventory.svelte';
import { listed, spotName } from '$lib/market/meta.svelte';
import { isTrailing, openOrders } from '$lib/account/orders.svelte';
import { ledger } from '$lib/exchange/ledger.svelte';
import { toast } from '$lib/ui/toast.svelte';
import { ui } from '$lib/ui/state.svelte';
import { assertOrdersLoaded, cancelOrders, flattenCoins, warnIfNotFlat } from './execute';
import { chaseOwning, chases, stopChase } from './chase.svelte';
import { clearQueued } from '$lib/hotkeys/armed.svelte';

const onSide = (isBuy: boolean | undefined, buy: boolean) => isBuy === undefined || isBuy === buy;

/** Marks every chase in scope (on one side when `isBuy` is given) stopped, also one already stopping, and vetoes its market leg, without waiting on its in-flight op. */
export const stopChases = (inScope: (coin: string) => boolean, isBuy?: boolean) =>
  chases.list.filter((c) => c.state !== 'stopped' && inScope(c.coin) && onSide(isBuy, c.isBuy)).map((c) => stopChase(c.id, 'cancelled', true));

/** Orders acked as resting in the last 2 s that the open-order feed does not list yet; triggers and a running chase's order (its stop cancels it) are left out. */
const unlisted = () =>
  ledger.entries
    .filter((e) => e.state === 'resting' && e.oid !== undefined && !e.trigger && (e.movedAt ?? e.t) >= Date.now() - 2000)
    .filter((e) => !openOrders.list.some((o) => o.oid === e.oid) && !chaseOwning(e.coin, e.isBuy, e.cloid))
    .map((e) => ({ coin: e.coin, oid: e.oid!, cloid: e.cloid, side: e.isBuy ? 'B' : 'A', isTrigger: false }));

/** Cancels at once beside the chase stops; only a chase order whose own cancel the exchange confirmed is left out. With `isBuy`, only that side, and false when it had nothing. With `acked`, also what the exchange acked but the feed does not list yet. */
export async function stopThenCancel(inScope: (coin: string) => boolean, includeTriggers: boolean, isBuy?: boolean, acked = false) {
  const early = acked ? unlisted() : [];
  const stopping = stopChases(inScope, isBuy);
  assertOrdersLoaded();
  const cleared = new Set(chases.list.filter((c) => c.cleared).map((c) => c.cloid));
  const rest = [...openOrders.list, ...early].filter(
    (o) => inScope(o.coin) && (includeTriggers || (!o.isTrigger && !isTrailing(o))) && onSide(isBuy, o.side === 'B') && !(o.cloid && cleared.has(o.cloid))
  );
  if (isBuy !== undefined && !rest.length && !stopping.length) return false;
  if (rest.length || !stopping.length) await cancelOrders(rest);
  await Promise.all(stopping);
  return true;
}

export type SweepKind = 'flatten' | 'cancel';
/** The flatten or cancel-all checklist: the coins it opened with, the ticked ones, and whether it is running. */
export const sweep = $state({ kind: 'flatten' as SweepKind, coins: [] as string[], ticked: [] as string[], scope: null as SweepScope | null, stopped: 0, busy: false });
let stopping: Promise<void>[] = [];

/** The Open orders filter a Cancel All was pressed under: one coin or '' for every coin, one side or both. */
export type SweepScope = { coin: string; isBuy?: boolean };
export const inSweepScope = (s: SweepScope, coin: string, isBuy?: boolean) => (!s.coin || coin === s.coin) && (!spotName(coin) || listed(coin)) && onSide(s.isBuy, isBuy ?? s.isBuy ?? true);

/** Every coin with exposure on every dex, all ticked: positions (flatten only), resting orders and running chases. Spot orders and chases are in cancel-all only: flatten is perps-only. Opening stops every chase and clears the hotkeys still queued. */
export function openSweep(kind: SweepKind, scope: SweepScope | null = null) {
  clearQueued();
  if (kind === 'flatten' && !inventory.loaded) throw new Error('positions not loaded yet');
  assertOrdersLoaded();
  // With a scope there is no checklist: exactly what the filter shows is cancelled, and only its chases stop.
  if (scope) {
    const any = openOrders.list.some((o) => inSweepScope(scope, o.coin, o.side === 'B')) || chases.list.some((c) => c.state !== 'stopped' && inSweepScope(scope, c.coin, c.isBuy));
    if (!any) return void toast.error('nothing to cancel');
    const stops = stopChases((c) => inSweepScope(scope, c), scope.isBuy);
    stopping = [...stopping, ...stops];
    Object.assign(sweep, { kind, coins: [], ticked: [], scope, stopped: stops.length, busy: false });
    return void (ui.overlay = 'sweep');
  }
  const held = kind === 'flatten' ? inventory.positions.filter((p) => p.szi !== 0).map((p) => p.coin) : [];
  const running = chases.list.filter((c) => c.state !== 'stopped' && (kind === 'cancel' || !spotName(c.coin))).map((c) => c.coin);
  const ordered = openOrders.list.map((o) => o.coin).filter((c) => !spotName(c) || (kind === 'cancel' && listed(c)));
  const coins = [...new Set([...held, ...ordered, ...running])];
  if (!coins.length) return void toast.error(`nothing to ${kind === 'flatten' ? 'flatten' : 'cancel'}`);
  const stops = stopChases(() => true);
  stopping = [...stopping, ...stops];
  Object.assign(sweep, { kind, coins, ticked: coins, scope: null, stopped: stops.length, busy: false });
  ui.overlay = 'sweep';
}

export function closeSweep() {
  if (!sweep.busy) ui.overlay = null;
}

/** Flatten closes first and cancels only where flat; cancel-all cancels every order of the ticked coins, TP/SL included. */
export async function runSweep() {
  const coins = sweep.coins.filter((c) => sweep.ticked.includes(c));
  const scope = sweep.scope;
  if (sweep.busy) return;
  if (!scope && !coins.length) return void toast.error('nothing ticked');
  const waits = stopping;
  stopping = [];
  sweep.busy = true;
  try {
    if (scope) await stopThenCancel((c) => inSweepScope(scope, c), true, scope.isBuy);
    else if (sweep.kind === 'cancel') await stopThenCancel((c) => coins.includes(c), true);
    else await flattenCoins(coins);
    await Promise.all(waits);
    if (sweep.kind === 'flatten' && waits.length) await warnIfNotFlat(coins);
  } catch (e) {
    toast.error(`${sweep.kind === 'flatten' ? 'Flatten' : 'Cancel all'}: ${(e as Error).message}`);
  } finally {
    sweep.busy = false;
    ui.overlay = null;
  }
}
