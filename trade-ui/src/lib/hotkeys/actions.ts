import { market, selectCoin } from '$lib/market/market.svelte';
import { isSpot, listed, meta } from '$lib/market/meta.svelte';
import { bbo } from '$lib/market/book.svelte';
import { positionOf } from '$lib/account/inventory.svelte';
import { lastGroup } from '$lib/exchange/ledger.svelte';
import { settings, persist, type HotkeyType } from '$lib/settings/settings.svelte';
import { marketBuyPx, resolveSize, refPx } from '$lib/orders/size';
import { limitDraft, bestPx } from '$lib/orders/limit';
import { scaleDrafts, scaleRange } from '$lib/orders/scale';
import { marketEntry, withExits } from '$lib/orders/entry';
import { place, cancelCloids, closePosition, closeAll, assertPerp, REDUCE_SPOT } from '$lib/orders/execute';
import { startChase, stopChase, chaseOwning, capFromPct } from '$lib/orders/chase.svelte';
import { openSweep, stopThenCancel } from '$lib/orders/sweep.svelte';
import { ticket, nudgeSize } from '$lib/orders/ticket.svelte';
import { ui, openSettings } from '$lib/ui/state.svelte';
import { inZen, setZen, toggleZenPart } from '$lib/ui/zen';
import { chartCmd } from '$lib/ui/Chart.svelte';
import { placeTicket, ticketOpen } from '$lib/ui/order/OrderPanel.svelte';
import { cycleAccount } from '$lib/ui/AccountSwitch.svelte';
import { escapeChart } from '$lib/ui/chart/tools.svelte';
import { armTool } from '$lib/ui/chart/drawings.svelte';
import { sideOf, toast } from '$lib/ui/toast.svelte';
import { askBlocked } from '$lib/agent/agent.svelte';
import { INTERVALS } from '$lib/market/candles';
import { topChips } from '$lib/market/views.svelte';
import { setArmed, armed } from './armed.svelte';
import type { ActionId } from './keymap';

const coin = () => market.coin;
/** `held` is the signed position the exchange reported, when the key was given one; otherwise the feed's. `px` is the order's price (on spot, the price a buy holds its quote at). */
const size = (isBuy: boolean, t: HotkeyType, held?: number, px?: number) => {
  const s = settings.hotkeySizes[t];
  const sz = resolveSize(coin(), isBuy, s, held, px);
  if (sz > 0) return sz;
  if (s.basis === 'position' && s.unit === 'pct' && !(held ?? positionOf(coin())?.szi)) throw new Error(`no ${coin()} position to size ${s.value}% of`);
  throw new Error(`${t} size resolves to 0 — set it in Settings › Execution`);
};

/** The order keys that size themselves from a hotkey type. */
export const SIZED: Partial<Record<ActionId, HotkeyType>> = {
  buyMkt: 'market', sellMkt: 'market', bidAlo: 'alo', askAlo: 'alo', chaseBuy: 'chase', chaseSell: 'chase', scaleBuy: 'scale', scaleSell: 'scale'
};

function cycleFavourite(dir: 1 | -1) {
  const favs = settings.display.superstar ? topChips() : [...new Set([...settings.superstars, ...settings.favourites])];
  if (!favs.length) return;
  // Off the list, } goes to the first favourite and { to the last.
  const i = favs.includes(coin()) ? favs.indexOf(coin()) : dir > 0 ? -1 : favs.length;
  selectCoin(favs[(i + dir + favs.length) % favs.length]);
}

function starFavourite() {
  const c = coin();
  const on = settings.favourites.includes(c);
  settings.favourites = on ? settings.favourites.filter((f) => f !== c) : [...settings.favourites, c];
  persist();
}

/** Entry at market or ALO on the coin selected at the press, bracketed with TP/SL when the ticket has it on. */
async function entry(kind: 'market' | 'limit', isBuy: boolean, held?: number) {
  const c = coin();
  const sz = kind === 'market' ? size(isBuy, 'market', held, isSpot(c) ? marketBuyPx(c) : undefined) : size(isBuy, 'alo', held, isSpot(c) ? undefined : bestPx(isBuy));
  const d = kind === 'market' ? await marketEntry(c, isBuy, sz) : limitDraft(c, isBuy, bestPx(isBuy), sz, 'Alo', ticket.reduceOnly);
  if (coin() !== c) throw new Error(`market switched from ${c}, nothing sent`);
  return place(kind, c, ...withExits(c, isBuy, kind, d));
}

const chase = (isBuy: boolean, sz: number, reduceOnly: boolean) =>
  startChase({
    coin: coin(), isBuy, sz, reduceOnly, cap: capFromPct(isBuy, refPx(coin()), settings.chase.capPct),
    timeoutSec: settings.chase.timeoutSec, onStop: settings.chase.onStop
  });

/** A sized Scale ticket on the key's side is placed as staged, with its own size and range; otherwise the key uses its hotkey size. */
export const scaleFromTicket = (isBuy: boolean) => ticket.kind === 'scale' && ticket.isBuy === isBuy && ticket.size > 0 && ticketOpen();

function scale(isBuy: boolean, held?: number) {
  if (scaleFromTicket(isBuy)) return placeTicket();
  const ref = isBuy ? bbo.bid : bbo.ask;
  const { from, to } = scaleRange(isBuy, ref, settings.scale.rangePct, settings.scale.offsetPct);
  const s = settings.scale;
  return place('scale', coin(), scaleDrafts({ coin: coin(), isBuy, from, to, count: s.count, totalSz: size(isBuy, 'scale', held), skew: s.skew, shape: s.shape, reduceOnly: ticket.reduceOnly }));
}

/** A live chase is stopped (it cancels its own order); a stopped chase's resting order or any other group is cancelled by cloid. */
function cancelLast() {
  const group = lastGroup(coin());
  if (!group.length) throw new Error(`nothing placed on ${coin()} yet`);
  const c = chaseOwning(coin(), group[0].isBuy, group[0].cloid);
  return c ? stopChase(c.id, 'cancelled') : cancelCloids(coin(), group.map((e) => e.cloid));
}

async function cancelSide(isBuy: boolean) {
  const here = coin();
  if (!(await stopThenCancel((c) => c === here, false, isBuy, true))) toast.error(`no ${isBuy ? 'buy' : 'sell'} orders on ${here}`, sideOf(isBuy));
}

function closeLimit(held?: number) {
  assertPerp(coin());
  if (settings.closeMode === 'limit') return closePosition(coin(), 'limit', undefined, held);
  const p = positionOf(coin());
  if (!p || p.szi === 0) throw new Error(`no ${coin()} position`);
  return chase(p.szi < 0, Math.abs(p.szi), true);
}

function positionExit(kind: 'TP' | 'SL') {
  const c = coin();
  assertPerp(c);
  if (!positionOf(c)?.szi) throw new Error(`no ${c} position`);
  if (!listed(c)) throw new Error(`${c} is not in the market list yet`);
  ui.overlay = { kind: 'positionTpsl', coin: c, focus: kind };
}

function focusSize() {
  const el = document.querySelector<HTMLInputElement>('[data-testid="panel-size"]');
  el?.focus();
  el?.select();
}

const interval = (i: number) => () => { settings.chart.interval = INTERVALS[i]; persist(); };

export const HANDLERS: Record<ActionId, (held?: number) => unknown> = {
  help: () => (ui.overlay = ui.overlay === 'help' ? null : 'help'),
  settings: () => (ui.overlay === 'settings' ? (ui.overlay = null) : openSettings(ui.settingsTab)),
  arm: () => setArmed(!armed.on),
  picker: () => (ui.overlay = 'picker'),
  prevFav: () => cycleFavourite(-1),
  nextFav: () => cycleFavourite(1),
  starFav: starFavourite,
  sizeDown: () => nudgeSize(-1, meta.byName.get(coin())?.szDecimals ?? 8),
  sizeUp: () => nudgeSize(1, meta.byName.get(coin())?.szDecimals ?? 8),
  focusSize,
  reduceToggle: () => {
    if (isSpot(coin())) throw new Error(REDUCE_SPOT);
    ticket.reduceOnly = !ticket.reduceOnly;
  },
  escape: () => {
    const el = document.activeElement as HTMLElement | null;
    if (!ui.overlay && (!el || el === document.body) && !escapeChart() && inZen()) setZen(false);
    ui.overlay = null;
    el?.blur();
  },
  cancelMarket: () => {
    const here = coin();
    return stopThenCancel((c) => c === here, false, undefined, true);
  },
  cancelBuys: () => cancelSide(true),
  cancelSells: () => cancelSide(false),
  cancelLast,
  cancelAll: () => openSweep('cancel'),
  positionTp: () => positionExit('TP'),
  positionSl: () => positionExit('SL'),
  close: (held) => closePosition(coin(), 'market', undefined, held),
  closeAll: () => closeAll('market'),
  flatten: () => openSweep('flatten'),
  buyMkt: (held) => entry('market', true, held),
  sellMkt: (held) => entry('market', false, held),
  bidAlo: (held) => entry('limit', true, held),
  askAlo: (held) => entry('limit', false, held),
  chaseBuy: () => chase(true, size(true, 'chase'), ticket.reduceOnly),
  chaseSell: () => chase(false, size(false, 'chase'), ticket.reduceOnly),
  scaleBuy: (held) => scale(true, held),
  scaleSell: (held) => scale(false, held),
  closeLimit,
  closeAllAlo: () => closeAll('limit'),
  placeTicket: () => placeTicket(),
  chartUp: () => chartCmd('up'),
  chartDown: () => chartCmd('down'),
  chartReset: () => chartCmd('reset'),
  chartBack: () => chartCmd('back'),
  chartForward: () => chartCmd('forward'),
  chartZoomIn: () => chartCmd('zoomIn'),
  chartZoomOut: () => chartCmd('zoomOut'),
  chartZoomInBoth: () => chartCmd('zoomInBoth'),
  chartZoomOutBoth: () => chartCmd('zoomOutBoth'),
  chartLog: () => chartCmd('log'),
  chartPercent: () => chartCmd('percent'),
  chartInvert: () => chartCmd('invert'),
  toggleFills: () => { settings.chart.indicators.fills.on = !settings.chart.indicators.fills.on; persist(); },
  zen: () => setZen(!inZen()),
  chartFull: () => chartCmd('fullscreen'),
  toggleOrder: () => toggleZenPart('order'),
  togglePositions: () => toggleZenPart('positions'),
  toggleBook: () => toggleZenPart('book'),
  cycleAccount: () => cycleAccount(),
  drawH: () => armTool('h'),
  drawV: () => armTool('v'),
  drawTrend: () => armTool('trend'),
  drawFib: () => armTool('fib'),
  askAi: () => (askBlocked() ? toast.error(askBlocked()) : armTool('ask')),
  indicators: () => chartCmd('indicators'),
  interval1: interval(0), interval2: interval(1), interval3: interval(2), interval4: interval(3),
  interval5: interval(4), interval6: interval(5), interval7: interval(6), interval8: interval(7)
};
