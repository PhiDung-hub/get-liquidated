import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { orderInfo } from '$lib/transport/info';
import { socket } from '$lib/transport/ws.svelte';
import { session } from '$lib/session/session.svelte';
import { emitter } from '$lib/util/emitter';
import type { TicketKind } from '$lib/orders/ticket.svelte';
import type { Status } from './send';

export type OrderKind = TicketKind | 'tpsl' | 'close';
export type LedgerState = 'pending' | 'resting' | 'filled' | 'canceled' | 'error' | 'unknown';
export interface Entry {
  cloid: string; coin: string; asset: number; isBuy: boolean; sz: number; px: number; kind: OrderKind; group: string; user: string;
  /** Reconcile gave up: still unknown (never 'not placed'), no longer polled, no longer blocking an account switch. */
  stale?: boolean;
  /** This tab sent a cancel for it, so a zero-fill 'canceled' is the user's own and no failure. */
  ownCancel?: boolean;
  reduceOnly?: boolean; trigger?: boolean; state: LedgerState; oid?: number; avgPx?: number; filledSz?: number; error?: string; t: number; movedAt?: number; proof?: number;
}

export interface Move { coin: string; isBuy: boolean; cloid?: string; was?: number; oid?: number; px: number; sz: number; more: number; t: number; proof?: number }
export const ledger = $state({ entries: [] as Entry[], moves: [] as Move[] });
// e2e sets this to null to read every order's state: 'resting' and 'pending' show nowhere on screen.
if (globalThis.window?.__hlLedger === null) window.__hlLedger = ledger;
const waiters = new Map<string, ((e: Entry) => void)[]>();
/** An entry's state changed, or reconcile gave up on it. */
export const changed = emitter<Entry>();
export const unsettled = (e: Entry) => e.state === 'pending' || e.state === 'unknown';
const NOT_FOUND = 'not found on exchange — order was not placed';
/** Reconcile's 'not found' is read from orderStatus, not proven: a feed row or fill under the cloid overturns it. */
export const notFound = (e: Entry) => e.state === 'error' && e.error === NOT_FOUND;

export const newCloid = () => '0x' + bytesToHex(randomBytes(16));
const find = (cloid: string) => ledger.entries.find((e) => e.cloid === cloid);
export const entryOf = find;

const RANK: Record<LedgerState, number> = { pending: 0, unknown: 0, error: 1, resting: 2, filled: 3, canceled: 3 };

/** States only move forward: a late ack or a stale reconcile answer never regresses an entry, and filled/canceled are final. */
function settle(e: Entry, { state, ...rest }: Partial<Entry>) {
  if (state && RANK[state] < RANK[e.state]) return;
  const was = e.state;
  Object.assign(e, rest);
  if (state && RANK[e.state] < 3 && e.state !== state) (e.state = state), (e.movedAt = Date.now());
  if (e.state !== was || rest.stale || 'filledSz' in rest) changed.emit(e);
  if (unsettled(e) && !e.stale) return;
  for (const f of waiters.get(e.cloid) ?? []) f(e);
  waiters.delete(e.cloid);
}

/** Each entry keeps the account that signed it, so its checks never follow the viewed account. */
export function track(rows: Omit<Entry, 'state' | 't' | 'user'>[]) {
  const [t, user] = [Date.now(), session.master ?? ''];
  ledger.entries = [...rows.map((r) => ({ ...r, state: 'pending' as const, t, user })), ...ledger.entries].slice(0, 300);
  if (ledger.entries[0]) changed.emit(ledger.entries[0]);
}

export const markOwnCancel = (cloids: string[], on: boolean) => cloids.forEach((c) => { const e = entryOf(c); if (e && (on || e.state !== 'canceled')) e.ownCancel = on; });

function fromStatus(s: Status): Partial<Entry> {
  if (s === 'success') return { state: 'canceled', error: undefined };
  if (s === 'waitingForFill' || s === 'waitingForTrigger') return { state: 'resting' };
  if ('resting' in s) return { state: 'resting', oid: s.resting.oid };
  if ('filled' in s) return { state: 'filled', oid: s.filled.oid, avgPx: Number(s.filled.avgPx), filledSz: Number(s.filled.totalSz) };
  return { state: 'error', error: s.error };
}

export function applyStatuses(cloids: string[], statuses: Status[]) {
  cloids.forEach((c, i) => {
    const e = find(c);
    if (e && statuses[i] !== undefined) settle(e, fromStatus(statuses[i]));
  });
  const missing = cloids.filter((_, i) => statuses[i] === undefined);
  if (missing.length) markUnknown(missing, 'no status in ack');
}

export function markUnknown(cloids: string[], reason: string) {
  for (const c of cloids) {
    const e = find(c);
    if (e?.state === 'pending') settle(e, { state: 'unknown', error: reason });
  }
  cloids.forEach(reconcile);
}

export function markError(cloids: string[], reason: string) {
  for (const c of cloids) {
    const e = find(c);
    if (e?.state === 'pending') settle(e, { state: 'error', error: reason });
  }
}

const ORDER_STATE: Record<string, LedgerState> = { open: 'resting', filled: 'filled', triggered: 'filled' };
const toState = (status: string): LedgerState => ORDER_STATE[status] ?? (status.endsWith('Rejected') ? 'error' : 'canceled');

/** Before an ack or fill settled it: 'filled' means its whole size, and a canceled order's origSz - sz is what filled. A size the fills did not give drops their average. */
export function applyOrderUpdate(cloid: string | undefined, status: string, oid: number, o?: { origSz: string; sz: string }) {
  const e = cloid ? find(cloid) : ledger.entries.find((x) => x.oid === oid);
  if (!e) return;
  const state = toState(status);
  const done = RANK[e.state] === 3 ? undefined : status === 'filled' ? e.sz : o && state === 'canceled' ? +(Number(o.origSz) - Number(o.sz)).toFixed(8) : undefined;
  const size = done === undefined || Math.abs(done - (e.filledSz ?? -1)) < 1e-9 ? {} : { filledSz: done, avgPx: undefined };
  settle(e, { state, oid, ...size, error: state === 'error' ? status : undefined });
}

/**
 * A feed listed these orders, or fills of them, under their cloids: placed, whatever the ack said. Fills add up over pushes (a snapshot restates them) and settle it filled once they cover the size;
 * fewer only record the size so far, since an IOC never rests: orderUpdates or orderStatus give the final state.
 */
export function seen(rows: { cloid?: string | null; oid: number; sz?: number | string; px?: number | string }[], fills?: 'snapshot' | 'update') {
  const open = new Map(ledger.entries.filter((e) => unsettled(e) || notFound(e)).map((e) => [e.cloid, e]));
  if (!open.size) return;
  const got = new Map<Entry, { oid: number; sz: number; usd: number }>();
  for (const r of rows) {
    const e = r.cloid ? open.get(r.cloid) : undefined;
    if (!e) continue;
    const prior = fills === 'update' ? (e.filledSz ?? 0) : 0;
    const g = got.get(e) ?? { oid: Number(r.oid), sz: prior, usd: prior * (e.avgPx ?? 0) };
    if (fills) (g.sz += Number(r.sz)), (g.usd += Number(r.sz) * Number(r.px));
    got.set(e, g);
  }
  for (const [e, g] of got) {
    if (notFound(e)) Object.assign(e, { state: 'unknown', stale: true, error: 'a feed showed it after orderStatus did not' });
    settle(e, !fills ? { state: 'resting', oid: g.oid } : { oid: g.oid, filledSz: +g.sz.toFixed(8), avgPx: g.usd / g.sz, ...(g.sz >= e.sz - 1e-9 ? { state: 'filled' as const } : {}) });
  }
}

/** Cloids with a reconcile chain running; every socket reconnect calls reconcileAll, which must not start another. */
const asking = new Set<string>();
const FIRST_MS = 2000;
const MAX_FAILS = 5;
const ROUND_MS = 120_000;

/**
 * Ask the exchange what happened to a cloid, as the account that placed it; never resend. Each check waits a moment, and out any 429 hold, so the feeds can settle it for free first.
 * A failed read (a 429, a dropped post) proves nothing; after 5 of them, or 2 minutes, the entry goes stale: still unknown and no longer polled.
 */
export function reconcile(cloid: string) {
  const e = find(cloid);
  if (!e?.user || e.stale || !unsettled(e) || asking.has(cloid)) return;
  asking.add(cloid);
  const since = Date.now();
  let [missing, fails] = [0, 0];
  const later = (ms: number) => void setTimeout(check, Math.max(ms, socket.holdLeft()));
  const check = async () => {
    if (!unsettled(e)) return void asking.delete(cloid);
    try {
      const r = await orderInfo<any>({ type: 'orderStatus', user: e.user, oid: cloid });
      if (r?.status !== 'order' && r?.status !== 'unknownOid') throw new Error('orderStatus returned an invalid status');
      if (r.status !== 'order' && e.filledSz) throw new Error('orderStatus does not list it yet, though a fill did');
      if (r.status !== 'order' && ++missing < 3) return later(FIRST_MS);
      asking.delete(cloid);
      if (r.status === 'order') return applyOrderUpdate(cloid, r.order.status, r.order.order.oid, r.order.order);
      settle(e, { state: 'error', error: NOT_FOUND });
    } catch (err) {
      console.warn(`reconcile ${cloid} failed`, err);
      const wait = Math.max(Math.min(30_000, FIRST_MS * 2 ** fails), socket.holdLeft());
      if (++fails < MAX_FAILS && Date.now() + wait - since <= ROUND_MS) return later(wait);
      asking.delete(cloid);
      if (unsettled(e)) settle(e, { stale: true });
    }
  };
  later(FIRST_MS);
}

export const reconcileAll = () => ledger.entries.filter(unsettled).forEach((e) => reconcile(e.cloid));

export function waitAck(cloid: string, timeoutMs = 8000): Promise<Entry> {
  const e = find(cloid);
  if (!e) return Promise.reject(new Error(`unknown cloid ${cloid}`));
  if (!unsettled(e) || e.stale) return Promise.resolve(e);
  return new Promise((resolve, reject) => {
    const done = (x: Entry) => (clearTimeout(timer), resolve(x));
    const timer = setTimeout(() => {
      const remaining = (waiters.get(cloid) ?? []).filter((f) => f !== done);
      if (remaining.length) waiters.set(cloid, remaining);
      else waiters.delete(cloid);
      reject(new Error(`no ack for ${cloid} after ${timeoutMs}ms`));
    }, timeoutMs);
    waiters.set(cloid, [...(waiters.get(cloid) ?? []), done]);
  });
}

export function lastGroup(coin: string): Entry[] {
  const head = ledger.entries.find((e) => e.coin === coin && e.user === session.master);
  return head ? ledger.entries.filter((e) => e.group === head.group) : [];
}
