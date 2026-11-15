import { orderAction, orderWire, cancelAction, cancelByCloidAction, batchModifyAction, trailingStopAction, updateLeverageAction, updateIsolatedMarginAction, type Grouping, type Retracement, type Tif } from '$lib/exchange/actions';
import { sendAction, ExchangeError, statusError, unproven, type Status } from '$lib/exchange/send';
import { applyStatuses, changed, entryOf, ledger, markError, markOwnCancel, markUnknown, newCloid, notFound, track, unsettled, waitAck, type Entry, type OrderKind } from '$lib/exchange/ledger.svelte';
import { refreshAgentExpiry, signer, viewAddress } from '$lib/session/session.svelte';
import { asset, dexOf, isSpot, listed, meta, nameOf, quoteOf, spotName } from '$lib/market/meta.svelte';
import { market } from '$lib/market/market.svelte';
import { bbo } from '$lib/market/book.svelte';
import { orderInfo } from '$lib/transport/info';
import { inventory, positionOf } from '$lib/account/inventory.svelte';
import { isTrailing, openOrders, type OpenOrder } from '$lib/account/orders.svelte';
import { grow, near, reprove, spotFree } from '$lib/account/spotPending';
import { settings } from '$lib/settings/settings.svelte';
import { MIN_NOTIONAL, tickSize } from '$lib/signing/wire';
import { fmtIn, fmtNum, fmtSz } from '$lib/util/format';
import { arr, num, str } from '$lib/util/parse';
import { sideOf, toast } from '$lib/ui/toast.svelte';
import { markOf } from './size';
import { marketDraft, type Draft } from './market';
import { limitDraft, bestPx } from './limit';
import { tpslDrafts } from './tpsl';
import { triggerDraft } from './trigger';
import { chases } from './chase.svelte';
import { closing } from './ticket.svelte';

const isLimit = (d: Draft): d is Draft & { type: { tif: string } } => 'tif' in d.type;
const side = (isBuy: boolean) => (isBuy ? 'BUY' : 'SELL');
// Without an account there is nothing to load, and signing refuses anyway.
const unloaded = (loaded: boolean) => !!viewAddress() && !loaded;

export function assertOrdersLoaded() {
  if (unloaded(openOrders.loaded)) throw new Error('open orders not loaded yet');
}

export function assertPositionsLoaded() {
  if (unloaded(inventory.loaded)) throw new Error('positions not loaded yet');
}

export function assertSpotLoaded() {
  if (unloaded(inventory.spotLoaded)) throw new Error('spot balances not loaded yet');
}

export const REDUCE_SPOT = 'Reduce Only is for perp positions: spot has none';
export const TRIGGER_SPOT = 'Stop/Take and TP/SL are perps-only here';
export function assertPerp(coin: string) {
  if (isSpot(coin)) throw new Error(`${nameOf(coin)} is spot: no position to close — sell from the ticket`);
}
/** What an order is paid in: USDC on perps, the quote on spot. HL's minimum is 10 of it. */
export const quoteIn = (coin: string) => (isSpot(coin) ? quoteOf(coin) : 'USDC');
export const minLabel = (coin: string) => (quoteIn(coin) === 'USDC' ? `$${MIN_NOTIONAL}` : `${MIN_NOTIONAL} ${quoteIn(coin)}`);

/** Every order path (place, moveOrder, the chase's checks) comes through here, so spot refusals live here too. */
export function validate(coin: string, drafts: Draft[]) {
  if (!drafts.length) throw new Error('nothing to place');
  const spot = isSpot(coin);
  if (spot && drafts.some((d) => d.reduceOnly)) throw new Error(REDUCE_SPOT);
  if (spot && drafts.some((d) => 'trigger' in d.type)) throw new Error(TRIGGER_SPOT);
  drafts.forEach((d, i) => {
    const tag = drafts.length > 1 ? ` (order ${i + 1})` : '';
    if (!(d.sz > 0)) throw new Error(`size rounds to 0${tag}`);
    if (!d.reduceOnly && d.px * d.sz < MIN_NOTIONAL) throw new Error(`below ${minLabel(coin)} minimum${tag}: ${fmtIn(d.px * d.sz, quoteIn(coin))}`);
  });
  const tifs = new Set(drafts.filter(isLimit).map((d) => d.type.tif));
  if (tifs.has('Alo') && tifs.size > 1) throw new Error('ALO orders are never batched with IOC/GTC');
  if (spot) return assertSpotLoaded();
  // Reduce-only drafts never add exposure; a trigger entry that is not reduce-only opens it like a limit.
  const opening = drafts.filter((d) => !d.reduceOnly);
  if (opening.length) assertPositionsLoaded();
  const szi = positionOf(coin)?.szi ?? 0;
  // HL lets a market order through to its own cap check; a resting or limit-trigger order that adds exposure is refused here, as HL's UI does.
  const resting = (d: Draft) => ('tif' in d.type ? d.type.tif !== 'Ioc' : !d.type.trigger.isMarket);
  // Summed over the batch: orders that each fit inside the position can still flip it together.
  const placed = opening.filter(resting);
  const increases = placed.some((d) => Math.sign(szi) !== (d.isBuy ? -1 : 1)) || placed.reduce((s, d) => s + d.sz, 0) > Math.abs(szi);
  if (meta.capped.has(coin) && increases) throw new Error(`${coin} is at open-interest cap: only reduce-only orders`);
}

const CAP_REJECTS: [RegExp, (coin: string) => string][] = [
  [/open interest is capped/i, (c) => `${c} is at its open-interest cap: only orders that reduce a position are accepted`],
  [/more aggressive than oracle while at open interest cap/i, (c) => `${c} is at its open-interest cap: the price may not be more aggressive than the oracle`],
  [/open interest too quickly/i, (c) => `${c} open interest is rising too fast: try again shortly`]
];
/** HL's open-interest rejects, reworded with the coin; anything else as HL said it. */
export const readable = (coin: string, error: string) => CAP_REJECTS.find(([re]) => re.test(error))?.[1](coin) ?? error;

/** What went wrong with one order, or null once it fills or rests. A zero-fill cancel inside the report window is the exchange's, as this tab's cancels come after a resting ack. */
function problem(coin: string, e: Entry): string | null {
  // A 'canceled' push can beat the ack of a partly filled IOC; the ack's fill size still counts.
  const filled = e.state === 'filled' ? (e.filledSz ?? e.sz) : e.state === 'canceled' ? (e.filledSz ?? 0) : 0;
  const at = e.avgPx ? ` @ ${e.avgPx}` : '';
  if (filled > 0 && filled < e.sz - 1e-9) return `only ${filled} filled${at}, rest cancelled`;
  if (filled > 0 || e.state === 'resting' || e.state === 'pending') return null;
  if (e.state === 'canceled') return e.ownCancel ? null : readable(coin, e.error ?? 'canceled by Hyperliquid');
  if (e.state === 'error') return readable(coin, e.error ?? '');
  const part = e.filledSz ? `${e.filledSz} filled so far${at}; ` : '';
  return e.stale ? `still unknown — ${part}not resent; check Open Orders and Fills` : `unconfirmed — ${part}checking, don't resend${e.error ? ` (${e.error})` : ''}`;
}

/** One error toast per group, updated in place, and none when every order went through; a stale or 'not found' order can still settle from a feed. A batch (scale, bracket) says how many failed and why, each reason once. */
function report(coin: string, entries: Entry[], group: string, head: string) {
  const show = () => {
    const bad = entries.map((e) => [e, problem(coin, e)] as const).filter((x): x is readonly [Entry, string] => x[1] !== null);
    const why = new Map<string, number>();
    // A failed bracket exit is named, so a missing stop-loss is never hidden behind the entry's side.
    // Definite failures first, so an unknown leg's text cannot push one out of the shown reasons.
    for (const [e, p] of bad.toSorted(([a], [b]) => +(a.state === 'unknown') - +(b.state === 'unknown'))) {
      const k = e.trigger && e.reduceOnly && entries.length > 1 ? `exit @ ${e.px}: ${p}` : p;
      why.set(k, (why.get(k) ?? 0) + 1);
    }
    const reasons = [...why].slice(0, 2).map(([p, n]) => (n > 1 && why.size > 1 ? `${p} (×${n})` : p)).join(' · ') + (why.size > 2 ? ` · +${why.size - 2} more` : '');
    const text = !bad.length ? null : entries.length === 1 ? `${side(bad[0][0].isBuy)} ${bad[0][0].sz} ${nameOf(coin)}: ${reasons}` : `${head} · ${bad.length} of ${entries.length}: ${reasons}`;
    toast.order(group, text, sideOf(entries[0].isBuy), entries.some((e) => e.state === 'unknown'), bad.filter(([e]) => e.state !== 'unknown').map(([, p]) => p).join());
    return entries.some((e) => unsettled(e) || notFound(e));
  };
  if (!show()) return;
  const off = changed.on((e) => {
    if (!entries.some((x) => entryOf(x.cloid)) || (e.group === group && !show())) off();
  });
}

function failure(e: unknown): string {
  if (!(e instanceof ExchangeError)) return (e as Error).message;
  // A key replaced or expired on Hyperliquid fails every order; re-checking it drops it and offers Enable trading.
  if (e.possibleSigFault) refreshAgentExpiry().catch((err) => toast.error(err.message));
  return e.possibleSigFault ? `${e.message} (possible signature or agent fault)` : e.message;
}

/** A spot sell never goes past the free base, nor the quote buys hold (px × sz) past the free quote: under portfolio margin HL would borrow the rest. */
export function spotFunds(coin: string, drafts: Pick<Draft, 'isBuy' | 'px' | 'sz'>[]) {
  const a = asset(coin);
  const quote = quoteOf(coin);
  const sell = drafts.filter((d) => !d.isBuy).reduce((t, d) => t + d.sz, 0);
  const cost = drafts.filter((d) => d.isBuy).reduce((t, d) => t + d.px * d.sz, 0);
  const [free, cash] = [spotFree(a.base), spotFree(quote)];
  if (sell > 0 && sell > free + 1e-12) throw new Error(`only ${fmtSz(Math.max(0, free))} ${a.base} free to sell`);
  if (cost > 0 && cost > cash + 1e-6) throw new Error(`only ${fmtNum(Math.max(0, cash), 2)} ${quote} free to buy`);
}

export function precheck(coin: string, drafts: Draft[]) {
  validate(coin, drafts);
  if (isSpot(coin)) spotFunds(coin, drafts);
}

export async function place(kind: OrderKind, coin: string, drafts: Draft[], grouping: Grouping = 'na'): Promise<Entry[]> {
  precheck(coin, drafts);
  const s = signer();
  const a = asset(coin);
  const group = newCloid();
  const specs = drafts.map((d) => ({ ...d, asset: a.index, cloid: newCloid() }));
  const cloids = specs.map((x) => x.cloid);
  track(specs.map((x) => ({ cloid: x.cloid, coin, asset: a.index, isBuy: x.isBuy, sz: x.sz, px: x.px, reduceOnly: x.reduceOnly, trigger: !isLimit(x), kind, group })));
  const lead = drafts[0];
  // A bracket's reduce-only legs are its exits; its entry may itself be a trigger.
  const counted = grouping === 'na' ? drafts : drafts.filter((d) => !d.reduceOnly);
  const total = Number(counted.reduce((t, d) => t + d.sz, 0).toPrecision(10));
  try {
    applyStatuses(cloids, await sendAction(s, orderAction(specs.map(orderWire), grouping)));
    reprove();
  } catch (e) {
    (unproven(e) ? markUnknown : markError)(cloids, failure(e));
  }
  const entries = cloids.map((c) => entryOf(c)!);
  report(coin, entries, group, `${side(lead.isBuy)} ${total} ${nameOf(coin)} · ${kind}${drafts.length > 1 ? ` ×${drafts.length}` : ''}`);
  return entries;
}

/** The selected coin's live BBO on the aggressor side, when under 3 s old. */
export const freshRef = (coin: string, isBuy: boolean): number | undefined =>
  coin === market.coin && bbo.bid > 0 && bbo.ask > 0 && Date.now() - bbo.seen < 3000 ? (isBuy ? bbo.ask : bbo.bid) : undefined;

/** Aggressor-side reference: live BBO for the selected coin, a fresh allMids read otherwise. */
export async function aggressorRef(coin: string, isBuy: boolean): Promise<number> {
  const fresh = freshRef(coin, isBuy);
  if (fresh !== undefined) return fresh;
  const dex = dexOf(coin);
  const mids = await orderInfo<Record<string, string>>({ type: 'allMids', ...(dex ? { dex } : {}) });
  return Number(mids[coin]);
}

export async function cancelCloids(coin: string, cloids: string[]) {
  // A cancel can execute before a same-moment GTC/IOC placement; wait for each ack first.
  await Promise.allSettled(cloids.filter((c) => entryOf(c)?.state === 'pending').map((c) => waitAck(c)));
  // A chase or chart-drag modify can leave its cloid 'canceled' in the ledger while the modified order rests.
  const live = cloids.filter((c) => {
    const e = entryOf(c);
    return e?.state === 'resting' || e?.state === 'unknown' || e?.state === 'pending' || (e?.kind === 'chase' && e.state === 'canceled') || openOrders.list.some((o) => o.cloid === c);
  });
  if (!live.length) return toast.error('nothing live to cancel');
  const a = asset(coin);
  markOwnCancel(live, true);
  try {
    const statuses = await sendAction(signer(), cancelByCloidAction(live.map((cloid) => ({ asset: a.index, cloid }))));
    markOwnCancel(live.filter((_, i) => statusError(statuses[i])), false);
    // An error answer proves nothing about an unconfirmed order (it may have filled); reconcile settles those.
    applyStatuses(live, statuses.map((st) => (statusError(st) ? undefined : st)) as Status[]);
    // Filled between its ack and the cancel: HL answers 'never placed, already canceled, or filled'.
    const errors = statuses.map(statusError).filter(Boolean);
    const err = errors.find((e) => !BENIGN_CANCEL.test(e!));
    if (err) toast.error(`cancel failed: ${err}`);
    else if (errors.length === statuses.length) toast.error('nothing live to cancel: it filled or was already cancelled. Check Positions');
    else if (errors.length) toast.error(`${errors.length} order(s) not cancelled: already filled or gone. Check Positions`);
  } catch (e) {
    if (!unproven(e)) markOwnCancel(live, false);
    toast.error(`cancel failed: ${failure(e)}`);
  }
}

export const BENIGN_CANCEL = /already canceled|never placed/i;

/** Toasts the outcome unless `quiet`; either way returns how many the exchange confirmed cancelled and the first real failure. */
export async function cancelOrders(all: { coin: string; oid: number }[], quiet = false): Promise<{ n: number; error: string }> {
  const say = (f: (t: string) => void, t: string) => void (quiet || f(t));
  if (all.length && !meta.loaded) return say(toast.error, 'cancel failed: market list not loaded'), { n: 0, error: 'market list not loaded' };
  const list = all.filter((o) => listed(o.coin));
  const hip3 = all.filter((o) => o.coin.includes(':') && !listed(o.coin)).length;
  const spot = all.filter((o) => spotName(o.coin) && !listed(o.coin)).length;
  const missed = [
    hip3 ? `${hip3} HIP-3 order(s) not cancelled: ${meta.hip3 === 'off' ? 'HIP-3 markets off' : 'market not listed'}` : '',
    spot ? `${spot} spot order(s) not cancelled: ${meta.spotState === 'off' ? 'spot markets off' : 'market list loading'}` : ''
  ].filter(Boolean).join(' · ');
  if (missed) say(toast.error, missed);
  if (!list.length) return spot || hip3 || say(toast.error, 'no orders to cancel'), { n: 0, error: missed };
  try {
    const statuses = await sendAction(signer(), cancelAction(list.map((o) => ({ a: asset(o.coin).index, o: o.oid }))));
    const answers = statuses.map(statusError).filter(Boolean) as string[];
    const errors = answers.filter((e) => !BENIGN_CANCEL.test(e));
    const gone = answers.length - errors.length, n = list.length - answers.length;
    if (errors.length) say(toast.error, `${errors.length} cancel(s) failed: ${errors[0]}`);
    if (gone) say(toast.error, `${gone} order(s) not cancelled: already filled or gone. Check Positions`);
    const error = [errors.length ? `${errors.length} cancel(s) failed: ${errors[0]}` : '', missed].filter(Boolean).join(' · ');
    return { n, error };
  } catch (e) {
    say(toast.error, `cancel failed: ${failure(e)}`);
    return { n: 0, error: [`cancel failed: ${failure(e)}`, missed].filter(Boolean).join(' · ') };
  }
}

export const cancelMarket = (coin: string, includeTriggers: boolean) =>
  cancelOrders(openOrders.list.filter((o) => o.coin === coin && (includeTriggers || (!o.isTrigger && !isTrailing(o)))));

export const cancelEverything = () => cancelOrders(openOrders.list);

/** `held` is the signed position, the feed's unless the exchange just reported it. */
export async function closePosition(coin: string, mode: 'market' | 'limit', ref?: number, held = positionOf(coin)?.szi ?? 0): Promise<Entry[]> {
  assertPerp(coin);
  if (!held) throw new Error(`no ${coin} position`);
  if (mode === 'limit' && coin !== market.coin) throw new Error(`select ${coin} to close at limit`);
  return closePart(coin, Math.abs(held), mode === 'limit' ? bestPx(held < 0) : undefined, ref, held, 'Alo');
}

/** `sz` of the position: a reduce-only limit at `px` (GTC by default), else reduce-only IOC at the aggressor reference ± slippage. */
export async function closePart(coin: string, sz: number, px?: number, ref?: number, held = positionOf(coin)?.szi ?? 0, tif: Tif = 'Gtc'): Promise<Entry[]> {
  assertPerp(coin);
  if (!held) throw new Error(`no ${coin} position`);
  if (sz > Math.abs(held) + 1e-12) throw new Error(`more than the ${Math.abs(held)} ${coin} position`);
  const isBuy = held < 0;
  if (px !== undefined) return place('close', coin, [limitDraft(coin, isBuy, px, sz, tif, true)]);
  return closeAtMarket(coin, Math.sign(held) * sz, ref ?? (await aggressorRef(coin, isBuy)));
}

const closeAtMarket = (coin: string, szi: number, ref: number) =>
  place('close', coin, [marketDraft(coin, szi < 0, Math.abs(szi), ref, { slippage: settings.market.slippage, reduceOnly: true })]);

const onDex = (dex: string) => (dex ? { dex } : {});
const dexesOf = (coins: string[]) => [...new Set(coins.map(dexOf))];

/** A spot token's total straight from the exchange; the socket balances can lag a fill that just landed. */
export async function balanceOn(token: string): Promise<number> {
  const s = await orderInfo<any>({ type: 'spotClearinghouseState', user: viewAddress() });
  return num(arr<any>(s.balances, 'balances').find((b) => b?.coin === token)?.total ?? 0, 'total');
}

/** Sizes straight from the exchange, one clearinghouseState per dex; the socket inventory can lag a fill that just landed. */
export async function positionsOn(dexes: string[]): Promise<Map<string, number>> {
  const states = await Promise.all(dexes.map((dex) => orderInfo<any>({ type: 'clearinghouseState', user: viewAddress(), ...onDex(dex) })));
  const sizes = states.flatMap((s) => arr<any>(s.assetPositions, 'assetPositions').map((ap) => [str(ap.position?.coin, 'coin'), num(ap.position?.szi, 'szi')] as const));
  return new Map(sizes.filter(([, szi]) => szi !== 0));
}

/** An order that may still land can change the position after the read below. The caller's own send is one of `closing`. */
function assertSettled(coin: string) {
  if (closing.n > 1) throw new Error('Another send is still in flight: nothing sent, wait for it to finish');
  if (ledger.entries.some((e) => e.coin === coin && unsettled(e) && !e.stale)) throw new Error(`${coin} has an unconfirmed order: nothing sent, wait for it to settle`);
}

/** Signed: a finished flip leaves the same absolute size, and the card's side must be the one sent. */
async function assertHeld(coin: string, shown: number) {
  const szi = (await positionsOn([dexOf(coin)]).catch((e) => { throw new Error(`could not read the ${coin} position: ${(e as Error).message}`); })).get(coin) ?? 0;
  if (!szi || szi !== shown) throw new Error(`${coin} position changed: ${szi || 'none'} now, ${shown} shown. Nothing sent`);
}

/** One market order of twice the position, not reduce-only, the last read right before it: a stale size here would open a new position. */
export async function reversePosition(coin: string, shown: number, ref?: number): Promise<Entry[]> {
  assertPerp(coin);
  assertSettled(coin);
  if (chases.list.some((c) => c.coin === coin && c.state !== 'stopped')) throw new Error(`${coin} has a running chase: stop it first`);
  if (meta.capped.has(coin)) throw new Error(`${coin} is at open-interest cap: HL refuses a flip`);
  const isBuy = shown < 0;
  const px = ref ?? (await aggressorRef(coin, isBuy));
  await assertHeld(coin, shown);
  return place('market', coin, [marketDraft(coin, isBuy, 2 * Math.abs(shown), px, { slippage: settings.market.slippage, reduceOnly: false })]);
}

/** A reduce-only trailing stop, sent as HL's own action: no cloid, so no ledger entry, and an unproven send is never retried. Resolves once HL took it or it is unproven; throws when nothing was placed. */
export async function placeTrailing(coin: string, shown: number, sz: number, retracement: Retracement, activationPx: number | null) {
  assertPerp(coin);
  assertSettled(coin);
  await assertHeld(coin, shown);
  if (!(sz > 0) || sz > Math.abs(shown)) throw new Error(`size must be within the ${Math.abs(shown)} ${coin} position`);
  const isBuy = shown < 0;
  const what = `${side(isBuy)} ${sz} ${nameOf(coin)} trailing stop`;
  const had = new Set(openOrders.list.map((o) => o.oid));
  let st;
  try {
    [st] = await sendAction(signer(), trailingStopAction(asset(coin).index, isBuy, sz, retracement, activationPx));
  } catch (e) {
    if (!unproven(e)) throw new Error(`${what} refused: ${readable(coin, failure(e))}`);
    return toast.error(`${what} not confirmed (${failure(e)}): check Open orders before retrying`, sideOf(isBuy));
  }
  const err = st === undefined ? null : statusError(st);
  if (err) throw new Error(`${what} refused: ${readable(coin, err)}`);
  setTimeout(() => {
    if (!openOrders.list.some((o) => o.coin === coin && isTrailing(o) && !had.has(o.oid))) toast.error(`${what}: no row in Open orders yet, check before retrying`, sideOf(isBuy));
  }, 5000);
}

/** A chase fill can land after flatten's re-check; say so rather than report flat. */
export async function warnIfNotFlat(coins: string[]) {
  const left = await positionsOn(dexesOf(coins)).catch(() => null);
  if (!left) return void toast.error('could not re-check positions after chase stops — check Positions');
  const still = coins.filter((c) => left.has(c));
  if (still.length) toast.error(`not flat on ${still.join(', ')} after chase stops — flatten again`);
}

const fullyFilled = (e: Entry) => e.state === 'filled' && (e.filledSz ?? 0) >= e.sz - 1e-9;
const whyNot = (r: PromiseSettledResult<Entry[]>) =>
  r.status === 'rejected' ? (r.reason as Error)?.message || 'failed' : r.value.every(fullyFilled) ? '' : (r.value.find((e) => !fullyFilled(e))?.error ?? 'not filled');

/** Closes the chosen coins first, then cancels their orders only where the exchange confirms them flat: cancelling first would strip stop-losses if a close then fails. */
export async function flattenCoins(coins: string[]) {
  if (!inventory.loaded) throw new Error('positions not loaded yet');
  assertOrdersLoaded();
  const dexes = dexesOf(coins);
  const [mids, held] = await Promise.all([Promise.all(dexes.map((dex) => orderInfo<Record<string, string>>({ type: 'allMids', ...onDex(dex) }))), positionsOn(dexes)]);
  const px: Record<string, string> = Object.assign({}, ...mids);
  const open = coins.filter((c) => held.has(c));
  const results = await Promise.allSettled(open.map(async (c) => closeAtMarket(c, held.get(c)!, Number(px[c]))));
  // A coin still holding size (a close that did not fill, or a late fill) keeps its stops; so does every coin if the re-check fails.
  const left = await positionsOn(dexes).catch(() => held);
  const failed = new Map(open.map((c, i) => [c, whyNot(results[i])] as const).filter(([, why]) => why));
  for (const c of coins) if (left.has(c) && !failed.has(c)) failed.set(c, 'still open');
  const cancel = await cancelOrders(openOrders.list.filter((o) => coins.includes(o.coin) && !failed.has(o.coin)), true);
  const closed = open.filter((c) => !failed.has(c));
  const parts = [
    closed.length ? `closed ${closed.join(', ')}` : '',
    cancel.n ? `cancelled ${cancel.n} order(s)` : '',
    failed.size ? `not flat on ${[...failed].map(([c, why]) => `${c} (${readable(c, why)})`).join(', ')} — their orders left in place` : '',
    cancel.error
  ].filter(Boolean);
  if (failed.size || cancel.error || !parts.length) toast.error(`Flatten: ${parts.join(' · ') || 'nothing to do'}`);
}

/** The best price on the passive side for a reduce-only ALO: this market's live book, else one l2Book read. */
async function passivePx(coin: string, isBuy: boolean): Promise<number> {
  if (coin === market.coin) return bestPx(isBuy);
  const book = await orderInfo<any>({ type: 'l2Book', coin });
  const px = num(arr<any>(arr<any>(book?.levels, 'levels')[isBuy ? 0 : 1], 'book side')[0]?.px, 'best price');
  if (!(px > 0)) throw new Error('no book');
  return px;
}

/** Every perp position closed at once as `c` (market) or Shift+C (reduce-only ALO at its best price) would close it; orders are left alone. */
export async function closeAll(mode: 'market' | 'limit') {
  if (!inventory.loaded) throw new Error('positions not loaded yet');
  const coins = inventory.positions.filter((p) => p.szi !== 0 && !isSpot(p.coin)).map((p) => p.coin);
  if (!coins.length) return void toast.error('no positions to close');
  const held = await positionsOn(dexesOf(coins));
  const open = coins.filter((c) => held.has(c));
  if (!open.length) return void toast.error('no positions to close');
  const results = await Promise.allSettled(open.map(async (c) => {
    const szi = held.get(c)!;
    return closePart(c, Math.abs(szi), mode === 'limit' ? await passivePx(c, szi < 0) : undefined, undefined, szi, 'Alo');
  }));
  const failed = open.map((c, i) => [c, results[i].status === 'rejected' ? (results[i].reason as Error)?.message || 'failed' : ''] as const).filter(([, why]) => why);
  const sent = open.length - failed.length;
  const head = `Close all ${mode === 'market' ? 'at market' : 'with ALO'}: ${sent} of ${open.length} sent`;
  if (failed.length) toast.error(`${head} · failed ${failed.map(([c, why]) => `${nameOf(c)} (${readable(c, why)})`).join(', ')}`);
}

export async function setLeverage(coin: string, isCross: boolean, leverage: number) {
  try {
    await sendAction(signer(), updateLeverageAction(asset(coin).index, isCross, leverage));
  } catch (e) {
    toast.error(`leverage update failed: ${failure(e)}`);
    throw e;
  }
}

/** One updateIsolatedMargin; a dropped or errored post is not proof it was refused, so that toast says to check before retrying. */
export async function adjustMargin(coin: string, isBuy: boolean, usd: number) {
  const ntli = Math.round(usd * 1e6);
  if (!ntli) throw new Error('margin amount rounds to $0');
  const what = `${coin} margin ${usd > 0 ? '+' : '−'}$${fmtNum(Math.abs(usd), 2)}`;
  try {
    await sendAction(signer(), updateIsolatedMarginAction(asset(coin).index, isBuy, ntli));
  } catch (e) {
    toast.error(unproven(e) ? `${what} not confirmed (${failure(e)}): check Margin before retrying` : `${what} failed: ${failure(e)}`);
    throw e;
  }
}

const TIFS = new Set(['Gtc', 'Alo', 'Ioc']);

/** Why a resting spot order may not become px × sz, or ''. Its own hold is already out of `free`, so only what it adds must be free: base for a sell, quote (px × sz) for a buy. */
export function spotGrowth(o: Pick<OpenOrder, 'coin' | 'side' | 'limitPx' | 'sz'>, px: number, sz: number): string {
  const isBuy = o.side === 'B';
  const more = isBuy ? px * sz - o.limitPx * o.sz : sz - o.sz;
  if (!isSpot(o.coin) || !(more > 0)) return '';
  try {
    spotFunds(o.coin, [isBuy ? { isBuy, px: 1, sz: more } : { isBuy, px: o.limitPx, sz: more }]);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/** A dragged or edited order at px and sz: same side, TIF and reduce-only; a trigger keeps its kind and a limit trigger its limit's offset. A limit that would cross the book (the chart coin's, unless one is given), or a trigger on the wrong side of mark, is refused. */
function movedDraft(o: OpenOrder, px: number, sz: number, book?: { bid: number; ask: number }): Draft {
  if (isTrailing(o)) throw new Error('a trailing stop cannot be moved: cancel it and place another');
  const isBuy = o.side === 'B';
  if (o.isTrigger) {
    const isMarket = o.orderType.endsWith('Market');
    const kind = `${o.orderType.startsWith('Take') ? 'take' : 'stop'}${isMarket ? 'Market' : 'Limit'}` as const;
    const d = triggerDraft(o.coin, isBuy, kind, px, isMarket ? null : o.limitPx + px - o.triggerPx, sz, o.reduceOnly, 'Gtc');
    if (!o.reduceOnly) validate(o.coin, [d]);
    return d;
  }
  if (!TIFS.has(o.tif ?? '')) throw new Error(`a ${o.orderType} order cannot be moved`);
  const b = book ?? (o.coin === market.coin ? bbo : undefined);
  if (!b || !(b.bid > 0 && b.ask > 0)) throw new Error('no book yet');
  if (isBuy ? px >= b.ask : px <= b.bid) throw new Error(`a ${isBuy ? 'buy at or above the ask' : 'sell at or below the bid'} would fill: not moved`);
  const d = limitDraft(o.coin, isBuy, px, sz, o.tif as Tif, o.reduceOnly);
  validate(o.coin, [d]);
  const short = spotGrowth(o, d.px, d.sz);
  if (short) throw new Error(short);
  return d;
}

/** Why moving o to px would be refused before anything is sent, or ''. */
export function moveRefusal(o: OpenOrder, px: number): string {
  try {
    movedDraft(o, px, o.sz);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/** One batchModify of a resting order to px (and sz); the outcome toasts. True when HL accepted it. */
export async function moveOrder(o: OpenOrder, px: number, sz = o.sz, book?: { bid: number; ask: number }): Promise<boolean> {
  const d = movedDraft(o, px, sz, book);
  const done = grow(o.coin, d.isBuy, { oid: o.oid, cloid: o.cloid, px: o.limitPx, sz: o.sz }, d.px, d.sz);
  const at = 'trigger' in d.type ? d.type.trigger.triggerPx : d.px;
  const what = `${side(d.isBuy)} ${d.sz || 'position'} ${nameOf(o.coin)}`;
  try {
    const [st] = await sendAction(signer(), batchModifyAction([{ oid: o.oid, order: orderWire({ ...d, asset: asset(o.coin).index, cloid: o.cloid }) }]));
    const err = st === undefined ? 'no status' : statusError(st);
    if (err) return st !== undefined && done(false), toast.error(`${what} not moved: ${readable(o.coin, err)}`, sideOf(d.isBuy)), false;
    if (typeof st === 'object' && !('error' in st)) done('resting' in st ? st.resting.oid : st.filled.oid), reprove();
    return true;
  } catch (e) {
    const unsure = unproven(e);
    if (!unsure) done(false);
    else void orderInfo<any>({ type: 'orderStatus', user: viewAddress(), oid: o.oid }).then((r) => r?.status === 'order' && r.order.status === 'open' && near(Number(r.order.order.limitPx), o.limitPx) && near(Number(r.order.order.sz), o.sz) && done(false), () => {});
    toast.error(`${what} ${unsure ? 'move not confirmed' : 'not moved'}: ${failure(e)}${unsure ? ': check Open orders' : ''}`, sideOf(d.isBuy));
    return false;
  }
}

/** Whether the coin's position already has a TP (tp) or an SL resting. */
export function hasExit(coin: string, tp: boolean) {
  const exit = (positionOf(coin)?.szi ?? 0) > 0 ? 'A' : 'B';
  return openOrders.list.some((o) => o.coin === coin && o.isTrigger && !isTrailing(o) && o.side === exit && o.orderType.startsWith('Take') === tp);
}

/** Why a whole-position TP or SL at px would be refused, or ''. */
export function exitRefusal(coin: string, px: number): string {
  const p = positionOf(coin);
  if (!p?.szi) return `no ${coin} position`;
  let mark: number;
  try {
    mark = markOf(coin);
  } catch (e) {
    return (e as Error).message;
  }
  if (Math.abs(px - mark) < tickSize(mark, asset(coin))) return 'TP/SL at mark: not placed';
  const tp = p.szi > 0 ? px > mark : px < mark;
  return hasExit(coin, tp) ? `${coin} already has ${tp ? 'a TP' : 'an SL'}: drag that one` : '';
}

/** A TP (px on the profit side of mark) or SL, a reduce-only trigger market for the whole position or for `sz` of it; refused while the position has one of that kind. */
export async function addPositionExit(coin: string, px: number, sz?: number): Promise<boolean> {
  const why = exitRefusal(coin, px);
  if (why) throw new Error(why);
  const p = positionOf(coin)!;
  const [long, mark] = [p.szi > 0, markOf(coin)];
  const tp = long ? px > mark : px < mark;
  const drafts = tpslDrafts(coin, long, sz ?? Math.abs(p.szi), tp ? px : null, tp ? null : px, settings.tpsl.slippage);
  // An unknown (dropped or 429'd post) is not an accepted exit. A sized exit stands alone; a whole-position one follows the position.
  return (await place('tpsl', coin, drafts, sz ? 'na' : 'positionTpsl')).every((e) => e.state === 'resting' || e.state === 'filled');
}
