import { batchModifyAction, cancelByCloidAction, orderWire } from '$lib/exchange/actions';
import { ExchangeError, sendAction, statusError, unproven, type Signer } from '$lib/exchange/send';
import { applyStatuses, entryOf, ledger, markOwnCancel, newCloid, unsettled, waitAck } from '$lib/exchange/ledger.svelte';
import { signer, viewAddress } from '$lib/session/session.svelte';
import { orderInfo } from '$lib/transport/info';
import { asset, nameOf } from '$lib/market/meta.svelte';
import { market } from '$lib/market/market.svelte';
import { bbo, watchBbo } from '$lib/market/book.svelte';
import { fillEvents, fills } from '$lib/account/fills.svelte';
import { openOrders, type OpenOrder } from '$lib/account/orders.svelte';
import { MIN_NOTIONAL, roundPx, roundSz, tickSize } from '$lib/signing/wire';
import { settings } from '$lib/settings/settings.svelte';
import { sideOf, toast } from '$lib/ui/toast.svelte';
import { BENIGN_CANCEL, aggressorRef, cancelOrders, freshRef, minLabel, place, spotGrowth, validate } from './execute';
import { grow, reprove, unshown } from '$lib/account/spotPending';
import { limitDraft } from './limit';
import { marketDraft } from './market';

export interface Chase {
  id: string; coin: string; isBuy: boolean; sz: number; cap: number; deadline: number | null; onStop: 'rest' | 'market';
  reduceOnly: boolean; cloid: string; oids: number[]; filled: number; px: number; state: 'chasing' | 'stopping' | 'stopped'; reason: string;
  /** The live order may differ from what orderStatus shows, so no market leg may size from it. */
  uncertain?: boolean;
  /** A flatten or cancel-all vetoed any market leg still to come. */
  abort?: boolean;
  /** The exchange answered 'success' to this chase's own cancel. */
  cleared?: boolean;
}
type Book = { bid: number; ask: number };
type OrderState = { status: string; sz: number; px: number; oid: number };
type Runtime = { offs: (() => void)[]; op: Promise<unknown> | null; lastModify: number; last: Book; timer?: ReturnType<typeof setTimeout> };

export const chases = $state({ list: [] as Chase[] });
// The chase runtime and the ledger live in memory, so a reload or account switch would orphan their orders. A stale entry is no longer checked, so it no longer blocks.
export const busy = () => chases.list.some((c) => c.state !== 'stopped') || ledger.entries.some((x) => unsettled(x) && !x.stale);
const runtime = new Map<string, Runtime>();
const stops = new Map<string, Promise<void>>();
const belowMin = (coin: string) => `remainder below ${minLabel(coin)} minimum`;
const MODIFY_UNKNOWN = 'modify outcome unknown';
const PLACEMENT_UNKNOWN = 'placement unconfirmed';
// Stops that cancel whatever is live under the cloid.
const CANCELS = new Set(['cancelled', MODIFY_UNKNOWN, PLACEMENT_UNKNOWN]);

export const capFromPct = (isBuy: boolean, ref: number, pct: number) => ref * (1 + ((isBuy ? 1 : -1) * pct) / 100);
const beyondCap = (c: { isBuy: boolean; cap: number }, px: number) => (c.isBuy ? px > c.cap : px < c.cap);
const best = (c: { isBuy: boolean }, b: Book) => (c.isBuy ? b.bid : b.ask);
const throttleMs = () => Math.max(500, settings.chase.throttleMs || 2000);
const remaining = (c: Chase) => roundSz(c.sz - c.filled, asset(c.coin).szDecimals);
const filledOf = (c: Chase) => fills.list.reduce((s, f) => s + (f.cloid === c.cloid || c.oids.includes(f.oid) ? f.sz : 0), 0);
const marketsOnStop = (c: Chase, reason: string) =>
  c.onStop === 'market' && (reason === 'cap' || reason === 'timeout' || (reason === belowMin(c.coin) && c.reduceOnly));

const firstBbo = (coin: string) => {
  const cached = coin === market.coin && bbo.bid > 0 && bbo.ask > 0 && Date.now() - bbo.seen < 3000;
  if (cached) return Promise.resolve({ bid: bbo.bid, ask: bbo.ask });
  return new Promise<Book>((resolve, reject) => {
    const timer = setTimeout(() => (off(), reject(new Error(`no ${coin} book within 3s`))), 3000);
    const off = watchBbo(coin, (b) => {
      if (!(b.bid > 0 && b.ask > 0)) return;
      clearTimeout(timer);
      off();
      resolve(b);
    });
  });
};

async function orderState(oid: string | number): Promise<OrderState | null> {
  const r = await orderInfo<any>({ type: 'orderStatus', user: viewAddress(), oid }).catch(() => null);
  if (r?.status !== 'order') return null;
  const o = r.order.order;
  return { status: String(r.order.status), sz: Number(o.sz), px: Number(o.limitPx), oid: Number(o.oid) };
}

/** By cloid first, which also finds an order a timed-out modify created. A closed record for some other oid is checked against the oid we last chased, so a stale record never leads to a second live order. */
async function chasedOrder(c: Chase): Promise<OrderState | null> {
  const byCloid = await orderState(c.cloid);
  const lastOid = c.oids.at(-1);
  if (!byCloid || byCloid.status === 'open' || byCloid.status === 'filled' || lastOid === undefined || byCloid.oid === lastOid) return byCloid;
  return orderState(lastOid);
}

/** Why an ALO at px for sz may not go out, or ''. validate() runs only inside place(), so modifies check here; HL rejects a resting order under $10 even when reduce-only. */
function blocked(c: Chase, px: number, sz: number): string {
  try {
    const d = limitDraft(c.coin, c.isBuy, px, sz, 'Alo', c.reduceOnly);
    if (d.px * d.sz < MIN_NOTIONAL) return belowMin(c.coin);
    validate(c.coin, [d]);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/** Places a fresh ALO; returns '' once it rests, else the stop reason. */
async function placeResting(c: Chase, px: number, sz: number): Promise<string> {
  if (c.state !== 'chasing' || c.abort) return c.reason || 'stopped';
  const [sent] = await place('chase', c.coin, [limitDraft(c.coin, c.isBuy, px, sz, 'Alo', c.reduceOnly)]);
  c.cloid = sent.cloid;
  // An unconfirmed placement stops and cancels by cloid; it must never start chasing or resend.
  const e = sent.state === 'pending' ? await waitAck(sent.cloid, 20_000).catch(() => sent) : sent;
  if (e.oid !== undefined) c.oids.push(e.oid);
  c.px = e.px;
  c.filled = filledOf(c);
  if (e.state === 'resting') return '';
  if (e.state === 'unknown' || e.state === 'pending') return (c.uncertain = true), PLACEMENT_UNKNOWN;
  return e.state === 'filled' ? 'filled' : `placement ${e.state}: ${e.error ?? 'no detail'}`;
}

export async function startChase(p: { coin: string; isBuy: boolean; sz: number; cap: number; timeoutSec: number; onStop: 'rest' | 'market'; reduceOnly: boolean }): Promise<Chase> {
  if (!(p.cap > 0)) throw new Error(`invalid chase cap ${p.cap}`);
  // Listed before the book wait, so a flatten or cancel-all during it stops this chase too.
  chases.list = [...chases.list, {
    id: newCloid(), coin: p.coin, isBuy: p.isBuy, sz: p.sz, cap: p.cap, onStop: p.onStop, reduceOnly: p.reduceOnly,
    deadline: p.timeoutSec > 0 ? Date.now() + p.timeoutSec * 1000 : null, cloid: '', oids: [], filled: 0, px: 0, state: 'chasing', reason: ''
  }];
  const c = chases.list[chases.list.length - 1];
  const rt: Runtime = { offs: [], op: null, lastModify: Date.now(), last: { bid: 0, ask: 0 } };
  runtime.set(c.id, rt);
  const op = firstPlacement(c, rt);
  rt.op = op;
  let why: string;
  try {
    why = await op;
  } catch (e) {
    await stopChase(c.id, (e as Error).message);
    throw e;
  } finally {
    rt.op = null;
  }
  if (why) await stopChase(c.id, why);
  if (c.state === 'chasing') watch(c, rt);
  return c;
}

async function firstPlacement(c: Chase, rt: Runtime): Promise<string> {
  rt.last = await firstBbo(c.coin);
  const px = best(c, rt.last);
  if (beyondCap(c, px)) throw new Error(`best ${px} is already beyond cap ${c.cap}`);
  rt.lastModify = Date.now();
  return placeResting(c, px, c.sz);
}

function watch(c: Chase, rt: Runtime) {
  rt.offs.push(() => clearTimeout(rt.timer));
  rt.offs.push(watchBbo(c.coin, (x) => ((rt.last = x), onBbo(c, rt))));
  rt.offs.push(fillEvents.on(() => onFills(c)));
  if (c.deadline) {
    const t = setTimeout(() => void stopChase(c.id, 'timeout'), c.deadline - Date.now());
    rt.offs.push(() => clearTimeout(t));
  }
  const onHidden = () => void (document.hidden && stopChase(c.id, 'tab hidden'));
  document.addEventListener('visibilitychange', onHidden);
  rt.offs.push(() => document.removeEventListener('visibilitychange', onHidden));
  onHidden();
}

/** HL pushes bbo only on change: a move swallowed by the throttle or an in-flight modify is re-checked from rt.last, not left waiting for a push. */
function recheck(c: Chase, rt: Runtime, ms: number) {
  if (rt.timer || c.state !== 'chasing') return;
  rt.timer = setTimeout(() => ((rt.timer = undefined), onBbo(c, rt)), ms);
}

// A modify's own cancel names the previous oid, so 'canceled' on the oid we chase is someone else's cancel.
function cancelledElsewhere(c: Chase) {
  const e = entryOf(c.cloid);
  return e?.state === 'canceled' && e.oid !== undefined && e.oid === c.oids.at(-1);
}

function onBbo(c: Chase, rt: Runtime) {
  const target = best(c, rt.last);
  if (c.state !== 'chasing' || !(target > 0)) return;
  if (beyondCap(c, target)) return void stopChase(c.id, 'cap');
  if (rt.op) return;
  if (cancelledElsewhere(c)) return void stopChase(c.id, 'cancelled elsewhere');
  const a = asset(c.coin);
  if (Math.abs(target - c.px) < tickSize(c.px, a) / 2) return;
  const wait = rt.lastModify + throttleMs() - Date.now();
  if (wait > 0) return recheck(c, rt, wait);
  rt.lastModify = Date.now();
  rt.op = modify(c, rt, roundPx(target, a, c.isBuy))
    .catch((e: Error) => void stopChase(c.id, e.message))
    .finally(() => ((rt.op = null), recheck(c, rt, throttleMs())));
}

async function modify(c: Chase, rt: Runtime, px: number) {
  let s: Signer;
  try {
    s = signer();
  } catch {
    return void stopChase(c.id, 'signer lost');
  }
  // The fill feed can lag; the exchange's open size for this cloid caps the modify.
  const open = openOrders.list.find((o) => o.cloid === c.cloid);
  const sz = open ? Math.min(remaining(c), open.sz) : remaining(c);
  if (!(sz > 0)) return void stopChase(c.id, 'filled');
  const short = spotGrowth({ coin: c.coin, side: c.isBuy ? 'B' : 'A', limitPx: c.px, sz }, px, sz);
  if (short && unshown(c.cloid)) return;
  const why = blocked(c, px, sz) || short;
  if (why) return void stopChase(c.id, why);
  const wire = orderWire({ asset: asset(c.coin).index, isBuy: c.isBuy, px, sz, reduceOnly: c.reduceOnly, type: { tif: 'Alo' }, cloid: c.cloid });
  const done = grow(c.coin, c.isBuy, { cloid: c.cloid, oid: c.oids.at(-1), px: c.px, sz }, px, sz);
  try {
    const [st] = await sendAction(s, batchModifyAction([{ oid: c.cloid, order: wire }]));
    if (typeof st === 'object' && 'resting' in st) return void (done(st.resting.oid), reprove(), (c.px = px), c.oids.push(st.resting.oid));
    if (typeof st === 'object' && 'filled' in st) return void (done(st.filled.oid), reprove(), stopChase(c.id, 'filled'));
    const err = statusError(st);
    if (err) done(false);
    await (err ? resync(c, rt, err) : unsure(c));
  } catch (e) {
    const refused = e instanceof ExchangeError && e.layer === 'status';
    if (refused) done(false);
    await (refused ? resync(c, rt, (e as Error).message) : unsure(c));
  }
}

const adopt = (c: Chase, o: OrderState) => void ((c.px = o.px), c.oids.includes(o.oid) || c.oids.push(o.oid));

/** After a definite rejection the modify placed nothing new, but its cancel half may have run. Ask, never resend blind. */
async function resync(c: Chase, rt: Runtime, why: string) {
  const o = await chasedOrder(c);
  if (!o) return void stopChase(c.id, `lost track of order: ${why}`);
  if (o.status === 'filled') return void stopChase(c.id, 'filled');
  if (o.status === 'open') return adopt(c, o);
  if (c.state === 'chasing') await replace(c, rt, why, o.sz);
}

/** A modify that may have landed can rest under an oid orderStatus by cloid does not show, so never re-place beside it. */
async function unsure(c: Chase) {
  const o = await orderState(c.cloid);
  if (o?.status === 'open') return adopt(c, o);
  c.uncertain = true;
  void stopChase(c.id, MODIFY_UNKNOWN);
}

async function replace(c: Chase, rt: Runtime, why: string, unfilled: number) {
  if (!(rt.last.bid > 0 && rt.last.ask > 0)) return void stopChase(c.id, `no book to re-place after: ${why}`);
  const px = best(c, rt.last);
  if (beyondCap(c, px)) return void stopChase(c.id, 'cap');
  // Our fill feed can lag the exchange's own record; size from whichever says less is left.
  const sz = Math.min(remaining(c), unfilled);
  const blockedWhy = blocked(c, px, sz);
  if (blockedWhy) return void stopChase(c.id, blockedWhy);
  const reason = await placeResting(c, px, sz).catch((e: Error) => e.message);
  if (reason) void stopChase(c.id, reason === 'filled' || reason === PLACEMENT_UNKNOWN ? reason : `re-place failed after ${why}: ${reason}`);
}

function onFills(c: Chase) {
  c.filled = filledOf(c);
  if (c.state === 'chasing' && remaining(c) <= 0) void stopChase(c.id, 'filled');
}

const named = (c: Chase) => `chase ${c.isBuy ? 'buy' : 'sell'} ${nameOf(c.coin)}`;

/** Always sends: after a modify the ledger state of a chase cloid is not authoritative. True once the exchange answered, so nothing rests under the cloid. */
async function cancelOwn(c: Chase): Promise<boolean> {
  if (!c.cloid) return false;
  markOwnCancel([c.cloid], true);
  try {
    const [st] = await sendAction(signer(), cancelByCloidAction([{ asset: asset(c.coin).index, cloid: c.cloid }]));
    if (statusError(st)) markOwnCancel([c.cloid], false);
    applyStatuses([c.cloid], [st]);
    if (st === 'success') c.cleared = true;
    const err = statusError(st);
    if (err && !BENIGN_CANCEL.test(err)) toast.error(`${named(c)} cancel: ${err}`, sideOf(c.isBuy));
    return st !== undefined;
  } catch (e) {
    if (!unproven(e)) markOwnCancel([c.cloid], false);
    toast.error(`${named(c)} cancel failed: ${(e as Error).message}`, sideOf(c.isBuy));
    return false;
  }
}

/** Markets only what the exchange confirms is no longer resting, so a cancel that did not land never doubles the position. */
async function marketRest(c: Chase) {
  if (c.uncertain) return void (await cancelOwn(c), toast.error(`${named(c)}: order state unconfirmed, market leg skipped`, sideOf(c.isBuy)));
  if (!c.reduceOnly && remaining(c) * c.px < MIN_NOTIONAL) return toast.error(`${named(c)}: ${belowMin(c.coin)}, order left resting`, sideOf(c.isBuy));
  // orderStatus can show a stale record beside a modified order it does not list; only a cancel answer proves the cloid is clear.
  const cleared = await cancelOwn(c);
  // Off the chart coin the price read runs beside orderStatus; the size still comes only from orderStatus.
  const early = cleared && freshRef(c.coin, c.isBuy) === undefined ? aggressorRef(c.coin, c.isBuy) : null;
  early?.catch(() => {});
  const o = cleared ? await chasedOrder(c) : null;
  if (!o || o.status === 'open') return toast.error(`${named(c)}: cancel not confirmed, market leg skipped`, sideOf(c.isBuy));
  const sz = o.status === 'filled' ? 0 : Math.min(remaining(c), o.sz);
  if (!(sz > 0)) return;
  const ref = await (early ?? aggressorRef(c.coin, c.isBuy));
  if (c.abort) return;
  await place('market', c.coin, [marketDraft(c.coin, c.isBuy, sz, ref, { slippage: settings.market.slippage, reduceOnly: c.reduceOnly })]);
}

/** Marks the chase stopping and tears it down at once; the promise settles after its cleanup. `abort` vetoes a market leg still to come, also on a chase already stopping. */
export function stopChase(id: string, reason: string, abort = false): Promise<void> {
  const c = chases.list.find((x) => x.id === id);
  if (!c) return Promise.resolve();
  if (abort) c.abort = true;
  if (c.state !== 'chasing') return stops.get(id) ?? Promise.resolve();
  c.state = 'stopping';
  c.reason = reason;
  const rt = runtime.get(id);
  runtime.delete(id);
  rt?.offs.forEach((off) => off());
  const done = cleanup(c, rt, reason).finally(() => ((c.state = 'stopped'), stops.delete(id)));
  stops.set(id, done);
  return done;
}

async function cleanup(c: Chase, rt: Runtime | undefined, reason: string) {
  // Let an in-flight placement or modify land first, so c.cloid names the order that is actually live.
  await rt?.op?.catch(() => {});
  if (reason !== 'filled' && reason !== 'cancelled') toast.error(`${named(c)} stopped: ${reason}`, sideOf(c.isBuy));
  try {
    if (CANCELS.has(reason)) await cancelOwn(c);
    else if (marketsOnStop(c, reason) && cancelledElsewhere(c)) toast.error(`${named(c)}: cancelled elsewhere, market leg skipped`, sideOf(c.isBuy));
    else if (marketsOnStop(c, reason)) await marketRest(c);
  } catch (e) {
    toast.error(`${named(c)}: ${(e as Error).message}`, sideOf(c.isBuy));
  }
}

/** The live chase behind a chase-kind order. c.cloid is set only after place() returns; the ledger knows a chase cloid from before it is sent. */
export function chaseOwning(coin: string, isBuy: boolean, cloid: string): Chase | undefined {
  const owner = chases.list.find((c) => c.cloid === cloid);
  if (owner || entryOf(cloid)?.kind !== 'chase') return owner?.state === 'chasing' ? owner : undefined;
  // Only chases still in their placement window; a stopped 'rest' chase leaves a chase-kind order behind.
  const placing = chases.list.filter((c) => c.state === 'chasing' && c.coin === coin && c.isBuy === isBuy && !openOrders.list.some((x) => x.cloid === c.cloid));
  return placing.length === 1 ? placing[0] : undefined;
}

/** One open order's Cancel: a running chase would re-place its order, so the chase is stopped instead. True when the exchange confirmed it. */
export async function cancelOpenOrder(o: OpenOrder): Promise<boolean> {
  const c = o.cloid ? chaseOwning(o.coin, o.side === 'B', o.cloid) : undefined;
  if (c) return stopChase(c.id, 'cancelled').then(() => !!c.cleared);
  const r = await cancelOrders([{ coin: o.coin, oid: o.oid }]);
  return r.n > 0 && !r.error;
}
