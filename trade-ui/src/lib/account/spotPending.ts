import { ledger, type Entry, type Move } from '$lib/exchange/ledger.svelte';
import { isSpot, meta } from '$lib/market/meta.svelte';
import { viewAddress } from '$lib/session/session.svelte';
import { freeOf, inventory } from './inventory.svelte';
import { fills } from './fills.svelte';
import { openOrders } from './orders.svelte';

export const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * b;
const shown = (x: { proof?: number }) => x.proof !== undefined && inventory.spotPushes > x.proof;
function filledOf(x: { cloid?: string; oid?: number; t: number }, byOid = false) {
  let n = 0;
  for (const f of fills.list) {
    if (f.time < x.t - 600_000) break;
    if (byOid || !f.cloid ? f.oid === x.oid : f.cloid === x.cloid) n += f.sz;
  }
  return n;
}
const ended = (u: any[], oid?: number, cloid?: string) => u.some((x) => x.status !== 'open' && ((!!cloid && x.order?.cloid === cloid) || (oid !== undefined && x.order?.oid === oid)));
const onBook = (x: { coin: string; cloid?: string; oid?: number; px: number; sz: number }) =>
  openOrders.list.some((o) => o.coin === x.coin && (o.cloid ? o.cloid === x.cloid : o.oid === x.oid) && near(o.limitPx, x.px) && (near(o.sz, x.sz) || near(o.origSz, x.sz)));
// The row a modify replaced still matches by cloid and origSz until HL applies it; only the new oid from its ack proves it.
const landed = (m: Move) => m.oid !== m.was && openOrders.list.some((o) => o.oid === m.oid && near(o.limitPx, m.px) && (near(o.sz, m.sz) || near(o.origSz, m.sz)));

/** Feed handlers and acks: stamps this tab's spot orders and modifies a feed just showed, so the next spotState push settles them. True when any was stamped. */
export function prove(updates: any[] = []): boolean {
  const n = inventory.spotPushes;
  let any = false;
  for (const e of ledger.entries) {
    if (e.proof !== undefined || e.state === 'error' || !isSpot(e.coin)) continue;
    const want = e.state === 'filled' || e.state === 'canceled' ? (e.filledSz ?? e.sz) : e.sz;
    if (ended(updates, e.oid, e.cloid) || filledOf(e) >= want - 1e-9 || onBook(e)) (e.proof = n), (any = true);
  }
  ledger.moves.forEach((m, i) => {
    if (m.proof !== undefined || !(ended(updates, m.oid) || ended(updates, m.was) || (m.oid !== undefined && (filledOf(m, true) >= m.sz - 1e-9 || landed(m))))) return;
    any = true;
    const older = m.cloid ? [...ledger.entries, ...ledger.moves.slice(i + 1)].filter((x) => x.cloid === m.cloid && x.proof === undefined) : [];
    for (const x of [m, ...older]) x.proof = n;
  });
  return any;
}
/** What this tab's own spot order holds or has spent of a token until a spotState push after a feed showed that order. */
function unseen(e: Entry, token: string): number {
  const a = meta.byName.get(e.coin);
  if (!a?.spot || e.state === 'error' || e.stale || shown(e) || e.user !== viewAddress()) return 0;
  const sz = e.state === 'filled' || e.state === 'canceled' ? (e.filledSz ?? e.sz) : e.sz;
  return e.isBuy ? (a.collateral === token ? (e.avgPx ?? e.px) * sz : 0) : a.base === token ? sz : 0;
}
const grown = (m: Move, token: string) => {
  const a = meta.byName.get(m.coin);
  return a && !shown(m) && (m.isBuy ? a.collateral : a.base) === token ? m.more : 0;
};
/** True while a spot order or modify under this cloid is still counted against free. */
export const unshown = (cloid: string) => [...ledger.entries, ...ledger.moves].some((x) => x.cloid === cloid && !shown(x));
export const spotFree = (token: string) => freeOf(token) - ledger.entries.reduce((t, e) => t + unseen(e, token), 0) - ledger.moves.reduce((t, m) => t + grown(m, token), 0);

/** Counts what a modify adds to a spot order until the feeds show it; call the result with the new oid, or false once HL refused it. */
export function grow(coin: string, isBuy: boolean, was: { oid?: number; cloid?: string; px: number; sz: number }, px: number, sz: number): (oid: number | false) => void {
  const more = isBuy ? px * sz - was.px * was.sz : sz - was.sz;
  if (!isSpot(coin) || !(more > 0)) return () => {};
  ledger.moves = [{ coin, isBuy, cloid: was.cloid, was: was.oid, px, sz, more, t: Date.now() }, ...ledger.moves].slice(0, 100);
  const m = ledger.moves[0];
  return (oid) => void (oid === false ? (ledger.moves = ledger.moves.filter((x) => x !== m)) : (m.oid = oid));
}

let respot = () => {};
let nudge: ReturnType<typeof setTimeout> | undefined;
/** A push that beat the feed proving an order leaves it counted until the next push, which HL sends only every few seconds, so a fresh subscribe asks for one at once. */
export const proved = (any: boolean) => {
  if (!any) return;
  clearTimeout(nudge);
  const at = inventory.spotPushes;
  nudge = setTimeout(() => inventory.spotPushes === at && respot(), 0);
};
/** An ack can complete what a feed frame showed before it. */
export const reprove = () => proved(prove());
export function onRespot(fn: () => void) { respot = fn; return () => { clearTimeout(nudge); respot = () => {}; }; }
