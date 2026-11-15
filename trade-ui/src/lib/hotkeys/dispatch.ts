import { market } from '$lib/market/market.svelte';
import { bbo } from '$lib/market/book.svelte';
import { dexOf, isSpot, meta } from '$lib/market/meta.svelte';
import { ledger } from '$lib/exchange/ledger.svelte';
import { balanceOf, nextFeed, positionOf } from '$lib/account/inventory.svelte';
import { openOrders } from '$lib/account/orders.svelte';
import { balanceOn, positionsOn } from '$lib/orders/execute';
import { viewAddress } from '$lib/session/session.svelte';
import { toast } from '$lib/ui/toast.svelte';
import { ui } from '$lib/ui/state.svelte';
import { ticket } from '$lib/orders/ticket.svelte';
import { isTouch, isTyping } from '$lib/ui/touch';
import { MODIFIER_CODES, ACTIONS, SIDE, dropShadowed, lookup, type ActionDef, type ActionId } from './keymap';
import { armed, touch, queues, clearQueued, type Barrier, type Queued } from './armed.svelte';
import { HANDLERS, SIZED, scaleFromTicket } from './actions';
import { settings } from '$lib/settings/settings.svelte';
import { menus } from '$lib/ui/order/Menu.svelte';

const DOUBLE_MS = 500;
const SWITCH_GUARD_MS = 500;
const STALE_BBO_MS = 3000;
const QUEUE_CAP = 8;
const CATCH_UP_MS = 2000;
let searchPrefixAt = 0;

const help = ACTIONS.find((a) => a.id === 'help')!;
const escape = ACTIONS.find((a) => a.id === 'escape')!;
const placeTicketAction = ACTIONS.find((a) => a.id === 'placeTicket')!;
const lastPress = new Map<string, number>();
const GLOBAL = new Set<ActionId>(['cancelAll', 'flatten', 'closeAll', 'closeAllAlo']);
// These read positions, open orders or the last placement, so they start once everything pressed before them on the coin has settled; so does a key sized at a % of the position.
// Cancels wait only for the acks ahead of them: x and Alt+B/S add what was acked but is not listed yet, and z cancels by cloid.
const CANCELS = new Set<ActionId>(['cancelMarket', 'cancelBuys', 'cancelSells', 'cancelLast']);
const SIZED_BARRIERS = new Set<ActionId>(['close', 'closeLimit', 'chaseBuy', 'chaseSell']);
const ofPosition = (a: ActionDef) => {
  const t = SIZED[a.id];
  return !!t && settings.hotkeySizes[t].unit === 'pct' && settings.hotkeySizes[t].basis === 'position';
};
// A market or limit close and a key sized at a % of the position size from the position read when it succeeds, not the feed.
const fromRead = (a: ActionDef) =>
  a.id === 'close' || (a.id === 'closeLimit' && settings.closeMode === 'limit') || (ofPosition(a) && SIZED[a.id] !== 'chase' && !(SIZED[a.id] === 'scale' && scaleFromTicket(a.id === 'scaleBuy')));
// On spot these are refused before any read: there is no position to close or size from.
const spotRefused = (a: ActionDef) => isSpot(market.coin) && (a.id === 'close' || a.id === 'closeLimit' || ofPosition(a));
const barrierOf = (a: ActionDef): Barrier =>
  CANCELS.has(a.id) ? 'acked' : spotRefused(a) ? null : fromRead(a) ? 'read' : SIZED_BARRIERS.has(a.id) || (a.id === 'placeTicket' && ticket.kind === 'chase') || ofPosition(a) ? 'sized' : null;

// `since` is when the coin's queue last started from empty.
const since = new Map<string, number>();

/** A focused select swallows letters (and type-ahead would change its value), so say why an R or X key did nothing. */
function swallowed(e: KeyboardEvent) {
  const a = lookup(e.code, e.shiftKey);
  if (!a || a.gate === 'A' || !(e.target instanceof HTMLSelectElement)) return;
  e.preventDefault();
  toast.error(`focus is in a form field (${a.label})`, SIDE[a.id]);
}

const ACTIVATE = new Set(['Enter', 'NumpadEnter', 'Space']);
/** Enter or Space that something else used, or a pick in a select that blurs itself, can leave focus on the page, where the next press would be Place ticket. That press does nothing until a plain key or a pointer press. */
let keyUsed = false;
function noteKey(e: KeyboardEvent) {
  const used = ACTIVATE.has(e.code) ? e.target !== document.body || menus.open || !!ui.overlay : e.target instanceof HTMLSelectElement;
  if (used) keyUsed = true;
  else if (!ACTIVATE.has(e.code) && !e.ctrlKey && !e.metaKey && !MODIFIER_CODES.test(e.code)) keyUsed = false;
}
const clearKeyUsed = () => void (keyUsed = false);
// A select's open popup keeps its keys from the page, so only the pick shows.
const noteChange = (e: Event) => void (e.target instanceof HTMLSelectElement && (keyUsed = true));

function resolve(e: KeyboardEvent): ActionDef | undefined {
  if (e.code === 'Escape' && isTyping(e.target)) return escape;
  // In an order-panel text box, the Place ticket key places as it does on the page; numpad Enter counts as Enter.
  if (e.target instanceof HTMLInputElement && isTyping(e.target) && e.target.closest('[data-testid="panel"]'))
    return lookup(e.code === 'NumpadEnter' ? 'Enter' : e.code, e.shiftKey, e.altKey) === placeTicketAction ? placeTicketAction : void swallowed(e);
  if (isTyping(e.target)) return void swallowed(e);
  // Enter and Space belong to a focused button or link; only on the page itself are they hotkeys.
  if (ACTIVATE.has(e.code) && e.target instanceof Element && e.target !== document.body) return;
  if (ACTIVATE.has(e.code) && keyUsed) {
    const a = lookup(e.code, e.shiftKey, e.altKey);
    if (a?.gate !== 'X') return a;
    return void toast.error(blocked(a) ?? `click the page first (${a.label})`, SIDE[a.id]);
  }
  if (e.key === '?' && !e.altKey) return help;
  return lookup(e.code, e.shiftKey, e.altKey);
}

function confirmDouble(a: ActionDef): boolean {
  const now = Date.now();
  const prev = lastPress.get(a.id) ?? 0;
  lastPress.set(a.id, now);
  if (now - prev <= DOUBLE_MS) return lastPress.delete(a.id), true;
  toast.info(`${a.label}: press again to confirm`, SIDE[a.id]);
  return false;
}

/** Returns why an order-sending press must not run, or null. */
function blocked(a: ActionDef): string | null {
  if (a.gate === 'A') return null;
  if (ui.overlay) return 'close the overlay first';
  if (menus.open) return 'close the menu first';
  if (a.gate === 'X' && !armed.on) return `disarmed — press \` to arm (${a.label})`;
  if (a.gate === 'X' && Date.now() - market.switchedAt < SWITCH_GUARD_MS) return 'market just switched';
  if (a.gate === 'X' && Date.now() - bbo.seen > STALE_BBO_MS) return 'book is stale (>3s)';
  return null;
}

async function run(a: ActionDef, held?: number) {
  try {
    await HANDLERS[a.id](held);
  } catch (err) {
    toast.error(`${a.label}: ${(err as Error).message}`, SIDE[a.id]);
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits, at most 2s, until the feeds show what the coin's queue did and anything acked on it in the last 2s: each resting order listed and, after a fill, the size the exchange reports. With `read`, a size the exchange reported is returned at once instead. */
async function caughtUp(coin: string, read: boolean): Promise<number | undefined> {
  const from = since.get(coin) ?? 0, recent = Date.now() - CATCH_UP_MS;
  const done = ledger.entries.filter((e) => e.coin === coin && (e.t >= from || (e.movedAt ?? e.t) >= recent));
  const filled = done.some((e) => e.state === 'filled' || (e.filledSz ?? 0) > 0);
  // On spot the size is the base token's balance.
  const base = meta.byName.get(coin)?.spot ? meta.byName.get(coin)!.base : '';
  const szi = () => (base ? balanceOf(base) : (positionOf(coin)?.szi ?? 0)), was = szi();
  // A refused read (a 429) leaves only the feed: wait, up to the cap, for it to move.
  const reported = () => (base ? balanceOn(base) : positionsOn([dexOf(coin)]).then((m) => m.get(coin) ?? 0));
  const want = filled ? await reported().then((n) => n, () => undefined) : null;
  if (read && typeof want === 'number') return want;
  const sized = () => want === null || (want === undefined ? szi() !== was : Math.abs(szi() - want) < 1e-9);
  const listed = () => done.every((e) => e.state !== 'resting' || !e.oid || openOrders.list.some((o) => o.oid === e.oid));
  // Wakes on each feed push; the 50ms fallback covers what no push announces (a ledger reconcile).
  for (const end = Date.now() + CATCH_UP_MS; !(sized() && listed()) && Date.now() < end; ) await Promise.race([nextFeed(), sleep(Math.min(50, end - Date.now()))]);
}

/** A plain press starts at once unless a barrier is ahead of it; a barrier starts only at the head. */
function pump(coin: string) {
  for (const [i, q] of (queues.get(coin) ?? []).entries()) {
    if (q.barrier && i > 0) return;
    if (!q.started) void start(q);
    if (q.barrier) return;
  }
}

/** What an order key reads: a sized key reads its own size and the ticket's exit and reduce-only fields. */
function uses(a: ActionDef): string {
  const t = SIZED[a.id];
  if (!t || (t === 'scale' && scaleFromTicket(a.id === 'scaleBuy'))) return JSON.stringify(ticket);
  const { reduceOnly, tpsl, tp, sl } = ticket;
  return JSON.stringify({ size: settings.hotkeySizes[t], reduceOnly, tpsl, tp, sl });
}
const changed = (q: Queued) => q.a.gate === 'X' && q.ticket !== uses(q.a);

async function start(q: Queued) {
  q.started = true;
  const held = q.barrier === 'read' || q.barrier === 'sized' ? await caughtUp(q.coin, q.barrier === 'read') : undefined;
  if (!queues.get(q.coin)?.includes(q)) return;
  q.running = true;
  const why = q.coin !== market.coin ? 'market switched' : q.user !== viewAddress() ? 'account switched' : changed(q) ? 'ticket changed' : blocked(q.a);
  if (why) toast.error(`${q.a.label} dropped: ${why}`, SIDE[q.a.id]);
  else await run(q.a, held);
  const rest = (queues.get(q.coin) ?? []).filter((x) => x !== q);
  if (rest.length) queues.set(q.coin, rest);
  else queues.delete(q.coin);
  pump(q.coin);
}

function enqueue(a: ActionDef) {
  const coin = market.coin;
  const q = queues.get(coin) ?? [];
  if (q.length >= QUEUE_CAP) return void toast.error(`${coin}: ${QUEUE_CAP} actions already queued (${a.label})`);
  if (!q.length) since.set(coin, Date.now());
  queues.set(coin, [...q, { a, coin, user: viewAddress(), ticket: uses(a), barrier: barrierOf(a), started: false, running: false }]);
  pump(coin);
}

export function activateAction(a: ActionDef): boolean {
  touch();
  const why = blocked(a);
  if (why) { toast.error(why, SIDE[a.id]); return false; }
  if (a.double && !confirmDouble(a)) return false;
  if (a === escape) clearQueued();
  if (a.gate === 'A' || GLOBAL.has(a.id)) void run(a);
  else enqueue(a);
  return true;
}

function onKeyDown(e: KeyboardEvent) {
  const prefixAt = searchPrefixAt;
  searchPrefixAt = 0;
  if (isTouch() || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
  if (!isTyping(e.target) && !e.altKey && !e.shiftKey) {
    if (!ui.overlay && !menus.open && !lookup(e.code, false, false) && /^[0-9]$/.test(e.key)) {
      e.preventDefault();
      ui.intervalInput = e.key;
      ui.overlay = 'interval';
      return;
    }
    if (e.key === ';') {
      searchPrefixAt = Date.now();
      e.preventDefault();
      return;
    }
    if (e.key === 'r' && prefixAt && Date.now() - prefixAt < 1500) {
      e.preventDefault();
      ui.overlay = 'help';
      document.querySelector<HTMLInputElement>('[data-testid="function-search"]')?.focus();
      return;
    }
  }
  // An Alt combo no binding claims stays the browser's or the OS's.
  if (e.altKey && (isTyping(e.target) || !lookup(e.code, e.shiftKey, true))) return;
  const a = resolve(e);
  if (!a) return;
  e.preventDefault();
  activateAction(a);
}

function confirmActiveForm(e: KeyboardEvent) {
  if (e.defaultPrevented || (e.code !== 'Enter' && e.code !== 'NumpadEnter')) return;
  const dialog = document.querySelector('[role="dialog"]');
  const button = dialog?.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Enter"]');
  if (!button || menus.open) return;
  const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
  if (plain && !e.repeat && !e.isComposing && e.target instanceof HTMLButtonElement && e.target !== button) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!plain || e.repeat || e.isComposing) return;
  const invalid = [...dialog!.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')].find((field) => !field.validity.valid);
  if (invalid) {
    invalid.focus();
    toast.error(invalid.validationMessage);
    return;
  }
  if (button.disabled) {
    toast.error(button.dataset.confirmError || 'Complete the required fields before confirming.');
    return;
  }
  keyUsed = true;
  button.click();
}

export function startHotkeys(): () => void {
  dropShadowed();
  window.addEventListener('keydown', noteKey, true);
  window.addEventListener('keydown', confirmActiveForm, true);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointerdown', clearKeyUsed, true);
  window.addEventListener('change', noteChange, true);
  return () => {
    searchPrefixAt = 0;
    window.removeEventListener('keydown', confirmActiveForm, true);
    window.removeEventListener('keydown', noteKey, true);
    window.removeEventListener('pointerdown', clearKeyUsed, true);
    window.removeEventListener('change', noteChange, true);
    window.removeEventListener('keydown', onKeyDown);
  };
}
