import { LineStyle, type IPriceLine, type ISeriesApi, type ISeriesPrimitive, type Time } from 'lightweight-charts';
import { tick, untrack } from 'svelte';
import { MediaQuery, SvelteSet } from 'svelte/reactivity';
import { liqDist, positionOf, type Position } from '$lib/account/inventory.svelte';
import { isTrailing, openOrders, type OpenOrder } from '$lib/account/orders.svelte';
import { market } from '$lib/market/market.svelte';
import { meta } from '$lib/market/meta.svelte';
import { cancelOpenOrder, chaseOwning } from '$lib/orders/chase.svelte';
import { addPositionExit, exitRefusal, hasExit, moveOrder, moveRefusal } from '$lib/orders/execute';
import { editable, editOrder } from '$lib/ui/order/EditOrderModal.svelte';
import { session } from '$lib/session/session.svelte';
import { ui } from '$lib/ui/state.svelte';
import { settings } from '$lib/settings/settings.svelte';
import { priceDecimals, tickSize } from '$lib/signing/wire';
import { socket } from '$lib/transport/ws.svelte';
import { toast } from '$lib/ui/toast.svelte';
import { fmtPct, fmtPx, fmtSz, fmtUsd, fmtUsdShort, pxDecimals } from '$lib/util/format';
import { extremes, type Pt } from './extremes.svelte';

type Kind = 'position' | 'liq' | 'order' | 'exit' | 'mfe' | 'mae';
interface Line { key: string; kind: Kind; price: number; parts: string[]; buy: boolean; o?: OpenOrder; sz?: number; tag?: boolean; est?: string; pnl?: number; gain?: number; why?: string; hint?: string }
interface Tag { key: string; price: number; under: boolean; y: number; left: number; w: number; over?: boolean }
interface Label extends Line, Tag { x: boolean; drag: boolean; busy: boolean; group: string; cap: number; over: boolean }
interface Row { key: string; o: OpenOrder; cells: string[]; filled: number; projected: number; pnl?: number; phase: 'close' | 'flip' | 'add' | 'open'; x: boolean; busy: boolean; under: boolean }
interface Group extends Tag { buy: boolean; text: string; members: string[]; rows: Row[]; up: boolean; room: number; vx: number; vy: number; span: number }
export interface Box { top: number; bot: number; left: number; w: number; t?: Tag; hit?: boolean }
interface Held { coin: string; key: string; from: number; px: number; ghost: IPriceLine; sent: boolean; why: string; end: () => void }
const PAD = 8;
const GAP = 4;
const SETTLE = 400;
const GRAB = 4;
const DEAD = 4;
const HOLD = 3000;
// Phones and touch screens keep the ✕ only, so a scroll or a tap never moves an order.
const narrow = new MediaQuery('(max-width: 900px), (pointer: coarse)');
const phone = new MediaQuery('max-width: 900px');
const chased = (o?: OpenOrder) => !!o?.cloid && !!chaseOwning(o.coin, o.side === 'B', o.cloid);
const quiet = (l: Line) => l.kind === 'mfe' || l.kind === 'mae';
export const signed = (v: number) => ((r) => `${r >= 0 ? '+' : ''}${fmtUsdShort(r)}`)(Math.round(v * 100) / 100 || 0);
// lightweight-charts floors a price to the axis precision, so an averaged entry or a liquidation price is rounded first.
const round = (px: number, dec = 0) => Number(px.toFixed(pxDecimals(px, dec)));

/** Each line's label, centred on its line in the price pane (see follow): y and left in chart pixels, y -1 off the price pane; x when it has a ✕, busy while that ✕'s cancel is in flight or confirmed, under while a later label, the legend or the open group list overlaps it; cap the width an MFE or MAE label clips at off home (0: max), over while one is drawn over the legend's text. */
export const lineLabels = $state({ list: [] as Label[], groups: [] as Group[], open: '', size: 0, max: 0 });
export const toggleGroup = (key: string) => (lineLabels.open = lineLabels.open === key ? '' : key);
// Oids in flight or confirmed cancelled; an oid is never reused, so a confirmed one stays disabled until its order leaves the feed.
const cancelling = new SvelteSet<number>();

export function cancelLine(o: OpenOrder) {
  cancelling.add(o.oid);
  cancelOpenOrder(o)
    .catch((err) => (toast.error(err?.message || 'failed'), false))
    .then((ok) => ok || cancelling.delete(o.oid));
}

function orderLine(o: OpenOrder, p: Position | undefined, dec: number | undefined, price = o.isTrigger ? o.triggerPx : o.limitPx): Line {
  const reduces = !!p && ((o.side === 'B') !== p.szi > 0 || o.reduceOnly);
  // A position TP/SL rests with size 0: it closes the whole position.
  const sz = o.sz || Math.abs(p?.szi ?? 0);
  // The side names a resting limit; a trigger keeps its kind after the side.
  const kind = `${o.side === 'B' ? 'Buy' : 'Sell'}${!o.isTrigger ? '' : o.orderType.startsWith('Take') ? ' TP' : reduces ? ' SL' : ' Stop'}`;
  // An order on the other side of the position shows its close PnL before fees.
  const pnl = p && (o.side === 'B') !== p.szi > 0 ? Math.round((price - p.entryPx) * Math.sign(p.szi) * Math.min(sz, Math.abs(p.szi)) * 100) / 100 : undefined;
  const estimate = pnl === undefined ? '' : signed(pnl);
  const move = o.isTrigger && estimate && p && p.entryPx > 0 ? fmtPct((price - p.entryPx) / p.entryPx) : '';
  const est = move ? `${estimate} (${move})` : estimate;
  const at = `${kind} ${fmtPx(price, dec, meta.byName.get(o.coin)?.spot)}`;
  const parts = est ? [at, est, fmtSz(sz, dec)] : [at, fmtSz(sz, dec)];
  const hint = move && p ? `Estimated close PnL before fees ${estimate}. Price move from entry (${fmtPx(p.entryPx, dec)}) ${move}.` : undefined;
  return { key: `o${o.oid}`, kind: 'order', price, parts, buy: o.side === 'B', o, sz, tag: !o.isTrigger, est, pnl, hint };
}

/** The whole-position TP (px on the profit side of mark) or SL a position-label drag would place at px. */
function exitLine(p: Position, px: number, dec: number | undefined): Line {
  const long = p.szi > 0;
  const tp = long === px > (market.ctx?.markPx ?? p.entryPx);
  const o = { coin: p.coin, side: long ? 'A' : 'B', isTrigger: true, orderType: tp ? 'Take Profit Market' : 'Stop Market', reduceOnly: true, sz: 0, limitPx: px, triggerPx: px, tif: null } as OpenOrder;
  return { ...orderLine(o, p, dec), key: 'exit', kind: 'exit', o: undefined };
}

/** The best (MFE) and worst (MAE) PnL since the position opened, at the price it was seen, as a share of the largest cost basis held by then, with R against the SL nearest the entry while that SL risks a loss. */
function extremeLines(p: Position, dec: number | undefined): Line[] {
  const side = Math.sign(p.szi);
  const { mfe, mae } = extremes;
  if (!extremes.key.startsWith(`${p.coin}:${side}:`) || !mfe || !mae) return [];
  const away = (o: OpenOrder) => Math.abs(o.triggerPx - p.entryPx);
  const sl = openOrders.list.filter((o) => o.coin === p.coin && o.isTrigger && o.reduceOnly && o.orderType.startsWith('Stop') && (o.side === 'B') !== side > 0).sort((a, b) => away(a) - away(b))[0];
  const risk = sl ? Math.abs(p.szi) * (p.entryPx - sl.triggerPx) * side : 0;
  const since = extremes.mode === 'since' ? ` · since ${new Date(extremes.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : '';
  const line = (kind: 'mfe' | 'mae', at: Pt): Line => {
    const r = risk > 0 ? ` · ${(Math.round((at.v / risk) * 10) / 10 || 0).toFixed(1)}R` : '';
    // The price and $ never clip; the rest does.
    const parts = [`${kind.toUpperCase()} ${fmtPx(at.px, dec)} · ${signed(at.v)}`, `(${fmtPct(at.v / at.base, 1)})${r}${since}${extremes.candles ? '' : ' · live'}`];
    return { key: kind, kind, price: round(at.px, dec), parts, buy: kind === 'mfe', pnl: at.v };
  };
  return [line('mfe', mfe), line('mae', mae)];
}

/** The coin's lines, resting limits' tags first (they sit under every other label); a held drag shows its order's label at the held price, or for the position the exit it would place, with why that would be refused in place of its PnL. */
function linesFor(coin: string, held?: { key: string; px: number; why?: string } | null): Line[] {
  const dec = meta.byName.get(coin)?.szDecimals;
  const found = positionOf(coin);
  const p = found?.szi ? found : undefined;
  const at = (o: OpenOrder) => (held?.key === `o${o.oid}` ? held.px : undefined);
  const dragged = held?.key === 'position' ? 'exit' : held?.key;
  const refused = (l: Line): Line => (!held?.why || l.key !== dragged ? l : { ...l, parts: [l.parts[0], held.why, ...l.parts.slice(l.est ? 2 : 1)], est: '', pnl: undefined, hint: undefined, why: held.why });
  const all = openOrders.list.filter((o) => o.coin === coin && !isTrailing(o)).map((o) => refused(orderLine(o, p, dec, at(o)))).sort((a, b) => b.price - a.price);
  const [tags, orders] = [all.filter((l) => l.tag), all.filter((l) => !l.tag)];
  if (!p) return [...tags, ...orders];
  const pos: Line = { key: 'position', kind: 'position', price: round(p.entryPx, dec), parts: [`PnL ${fmtUsdShort(p.uPnl)}`, fmtSz(p.szi, dec)], hint: `Funding since open: ${fmtUsd(-p.fundingSinceOpen)} (positive received, negative paid)`, buy: p.szi > 0, pnl: p.uPnl, gain: market.ctx?.markPx ? (market.ctx.markPx - p.entryPx) * Math.sign(p.szi) : p.uPnl };
  const liq: Line[] = p.liqPx ? [{ key: 'liq', kind: 'liq', price: round(p.liqPx, dec), parts: [`Liq ${fmtPx(p.liqPx, dec)} · ${liqDist(p)}`], buy: false }] : [];
  const exit = held?.key === 'position' ? [refused(exitLine(p, held.px, dec))] : [];
  return [...tags, pos, ...liq, ...orders, ...exit, ...extremeLines(p, dec)];
}

/** Same-side resting limits (never a trigger, a chase's order or the one being dragged) whose lines at y, on the pane or past its edge, chain closer than h px (1.25 h within a group already), in runs of 3 or more. */
function clusters(list: Label[], h: number, y: (t: Label) => number | null, held?: string): Label[][] {
  const out: Label[][] = [];
  const at = new Map(list.map((t) => [t, y(t)]));
  const free = list.filter((t) => t.kind === 'order' && t.o && !t.o.isTrigger && !chased(t.o) && t.key !== held && at.get(t) !== null);
  for (const buy of [true, false]) {
    let run: Label[] = [];
    const flush = () => (run.length >= 3 && out.push(run), (run = []));
    for (const t of free.filter((t) => t.buy === buy).sort((a, b) => at.get(a)! - at.get(b)!)) {
      const prev = run.at(-1);
      if (prev && at.get(t)! - at.get(prev)! >= (t.group && t.group === prev.group ? h * 1.25 : h)) flush();
      run.push(t);
    }
    flush();
  }
  return out;
}

/** Anchor the tag at the nearest visible order and list the run in fill order, from the market outward. */
function groupOf(run: Label[], coin: string, dec: number | undefined, fits: (y: number) => boolean): Group {
  const byFillPrice = (a: Line, b: Line) => run[0].buy ? b.price - a.price : a.price - b.price;
  const rows = [...run].sort(byFillPrice);
  const at = rows.find((t) => fits(t.y)) ?? rows.find((t) => t.y >= 0) ?? rows[0];
  const p = positionOf(coin);
  let position = p?.szi ?? 0;
  const projections = new Map<string, { position: number; filled: number; phase: Row['phase']; transition: string; pnl?: number }>();
  const fills = openOrders.list.filter((o) => o.coin === coin && !o.isTrigger && !isTrailing(o) && (o.side === 'B') === at.buy)
    .map((o) => orderLine(o, p, dec)).sort(byFillPrice);
  for (const t of fills) {
    const direction = t.buy ? 1 : -1;
    const opposing = position * direction < 0;
    const quantity = t.o!.reduceOnly ? opposing ? Math.min(t.sz ?? 0, Math.abs(position)) : 0 : t.sz ?? 0;
    const closed = opposing ? Math.min(quantity, Math.abs(position)) : 0;
    const opened = quantity - closed;
    // What this fill closes after the rows before it: the entry stays put while a position shrinks.
    const pnl = closed > 0 ? Math.round((t.price - p!.entryPx) * Math.sign(position) * closed * 100) / 100 : undefined;
    const phase: Row['phase'] = opened > 0 ? closed > 0 || position === 0 && !!p?.szi && Math.sign(p.szi) !== direction ? 'flip' : position === 0 ? 'open' : 'add' : 'close';
    position = Number((position + direction * quantity).toFixed(8));
    const transition = opened > 0 ? `${phase === 'flip' ? 'Flip to' : phase === 'open' ? 'Open' : 'Add to'} ${t.buy ? 'long' : 'short'} ${fmtSz(opened, dec)}` : '';
    projections.set(t.key, { position, filled: quantity, phase, transition, pnl });
  }
  const spot = meta.byName.get(coin)?.spot;
  const first = rows[0].price, last = rows.at(-1)!.price;
  const lo = fmtPx(Math.min(first, last), dec, spot), hi = fmtPx(Math.max(first, last), dec, spot);
  const text = `${at.buy ? 'Buy' : 'Sell'} ×${run.length} · ${lo === hi ? lo : `${lo}–${hi}`}`;
  const row = (t: Label): Row => {
    const projection = projections.get(t.key)!;
    return { key: t.key, o: t.o!, cells: [fmtPx(t.price, dec, spot), fmtSz(t.sz ?? 0, dec), projection.transition], filled: projection.filled, projected: projection.position, pnl: projection.pnl, phase: projection.phase, x: t.x, busy: t.busy, under: true };
  };
  return { key: `g${at.key}`, price: at.price, buy: at.buy, text, members: run.map((t) => t.key), rows: rows.map(row), under: false, y: at.y, left: PAD, w: 0, up: false, room: 0, vx: 0, vy: 0, span: 0 };
}

export const meets = (a: Box, gap: number) => (b: Box) => a.top < b.bot && b.top < a.bot && a.left < b.left + b.w + gap && b.left < a.left + a.w + gap;

/** The legend's text items in chart pixels, hit when one is or holds a control. */
export function legendBoxes(el: HTMLElement): Box[] {
  const o = el.getBoundingClientRect();
  return [...el.querySelectorAll('.legends .ohlc > *, .legends .ind > *')].map((n) => {
    const r = n.getBoundingClientRect();
    return { top: r.top - o.top, bot: r.bottom - o.top, left: r.left - o.left, w: r.width, hit: n.matches('button, summary') || !!n.querySelector('button, summary') };
  });
}

/** Puts each label on its line at home, stepping right past each box it meets; one that no longer fits goes back home, on top, and the labels it covers there lose their ✕. Returns the boxes placed. */
function place(list: Tag[], placed: Box[], h: number, home: number, fits: (x: number, t: Tag) => boolean): Box[] {
  for (const t of list) {
    const a: Box = { top: t.y - h / 2, bot: t.y + h / 2, left: home, w: t.w, t };
    for (let hit = placed.find(meets(a, GAP)); hit && t.y >= 0; hit = placed.find(meets(a, GAP))) a.left = hit.left + hit.w + GAP;
    a.left = fits(a.left, t) ? a.left : home;
    [t.left, t.under] = [a.left, placed.some((b) => !b.t && meets(a, 0)(b))];
    if (t.y < 0) continue;
    placed.filter(meets(a, 0)).forEach((b) => b.t && (b.t.under = true));
    placed.push(a);
  }
  return placed;
}

/** Where a label w wide on line y, h tall, first meets none of bs, from home rightwards. */
function slot(y: number, w: number, h: number, home: number, bs: Box[]) {
  const a: Box = { top: y - h / 2, bot: y + h / 2, left: home, w };
  for (let hit = bs.find(meets(a, GAP)); hit; hit = bs.find(meets(a, GAP))) a.left = hit.left + hit.w + GAP;
  return a.left;
}

/** Draws the chart coin's position, liquidation and resting-order lines on `series` and keeps each one's label on its line, packed from the left so candles stay clear, left of x `newest()` (the newest bars) when that leaves over half the pane; kick() makes them follow a price scale change. Mirrors them into el's data-lines, and the position's MFE and MAE lines into data-extremes. */
export function positionLines(series: ISeriesApi<'Candlestick'>, el: HTMLElement, newest: () => number | null, inset = () => 0, legendBottom = () => Infinity) {
  const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = { buy: css('--buy'), sell: css('--sell'), neutral: css('--dim') };
  let drawn = new Map<string, { line: IPriceLine; l: Line }>();
  let held: Held | null = null;
  const ghostColor = (l: Line, why = '') => (l.buy !== (l.kind === 'position') ? color.buy : color.sell) + (why ? '50' : '');
  const style = (l: Line, faint = false, end = false) => {
    const gain = l.gain ?? 0;
    const base = l.kind === 'position' ? gain > 0 ? color.buy : gain < 0 ? color.sell : color.neutral : l.buy ? color.buy : color.sell;
    const alpha = faint ? '30' : l.kind === 'position' ? '99' : quiet(l) ? '80' : '';
    return { color: base + alpha, axisLabelVisible: !quiet(l) && (!faint || end), axisLabelColor: faint ? base : '' };
  };
  // A grouped order keeps a faint line; only a group's lowest and highest orders keep an axis label. Lines are restyled only when the groups change.
  let sig = '';
  let grouped = new Set<string>();
  let ends = new Set<string>();
  const restyle = () => drawn.forEach((d, key) => d.line.applyOptions(style(d.l, grouped.has(key), ends.has(key))));
  const regroup = (next: Group[]) => {
    const member = new Map(next.flatMap((g) => g.members.map((k) => [k, g.key] as const)));
    for (const t of lineLabels.list) t.group = member.get(t.key) ?? '';
    const s = JSON.stringify(next.map((g) => [g.key, g.text, g.rows.map((r) => [r.key, r.cells, r.filled, r.projected, r.pnl, r.phase, r.x, r.busy])]));
    if (s === sig) return next.forEach((g, i) => (lineLabels.groups[i].y = g.y));
    sig = s;
    grouped = new Set(member.keys());
    ends = new Set(next.flatMap((g) => {
      const byPx = lineLabels.list.filter((t) => t.group === g.key).sort((a, b) => a.price - b.price);
      return [byPx[0]?.key, byPx.at(-1)?.key].filter((k) => k !== undefined);
    }));
    restyle();
    // Keyed as Chart.svelte keys the group's element, which keeps its measured width under a new anchor.
    const w = new Map(lineLabels.groups.map((g) => [g.rows[0].key, g.w]));
    const was = lineLabels.groups.find((g) => g.key === lineLabels.open);
    // An open list stays open while its group lives on, under a new anchor too; it closes once the group dissolves.
    if (was) lineLabels.open = next.find((g) => g.key === was.key || g.members.some((k) => was.members.includes(k)))?.key ?? '';
    lineLabels.groups = next.map((g) => ({ ...g, w: w.get(g.rows[0].key) ?? 0 }));
  };
  const yOf = (price: number) => {
    const y = series.priceToCoordinate(price);
    return y === null || y < 0 || y > series.getPane().getHeight() ? -1 : Math.round(y);
  };
  const legend = () => legendBoxes(el);
  const listBox = (g: Group | undefined, h: number): Box | undefined => {
    const r = g && el.querySelector('[data-testid=group-list]')?.getBoundingClientRect();
    if (!g || !r) return;
    const top = g.up ? g.y - h / 2 - r.height : g.y + h / 2;
    return { top, bot: top + r.height, left: g.left, w: r.width };
  };
  // Every label starts at the left and steps right only past what is already on its line.
  // An MFE or MAE label then steps right of the legend text and the other labels by its price and $ (head), clipping the rest at the room; where its head does not fit there it steps past the legend's controls only and draws over its text.
  // A label anything but an MFE or MAE label overlaps loses its ✕.
  // A ✕ that just became clear or moved (new label, or the one above or beside it went away) stays inert for SETTLE ms, so a double tap cannot cancel the order beneath.
  const clear = new Map<string, { at: number; left: number; y: number }>();
  let rowClear = new Map<string, number>();
  // Read on a resize, as a layout read in a frame is forced. tableW is the chart's own table, which can be a pixel short of el (the phone trims el past its edge).
  const table = el.querySelector('table');
  let width = el.clientWidth;
  let tableW = table?.clientWidth ?? width;
  // What placing reads besides the labels themselves; a frame where none of it moved and nothing is settling skips follow.
  const inputs = () => {
    const r = series.priceScale().getVisibleRange();
    return `${r?.from},${r?.to},${series.getPane().getHeight()},${width},${tableW},${series.priceScale().width()},${newest()},${inset()},${legendBottom()},${lineLabels.size},${lineLabels.list.map((t) => t.w)},${lineLabels.groups.map((g) => g.w)}`;
  };
  let seen = '';
  let banded = false;
  const follow = () => {
    seen = inputs();
    const now = performance.now();
    const pane = tableW - series.priceScale().width();
    const lw = inset();
    const room = Math.min(pane, lw + Math.max((pane - lw) / 2, newest() ?? 0));
    const h = lineLabels.size;
    // A left label too wide for the pane even at home is clipped (its close PnL first) rather than run over the price axis.
    lineLabels.max = pane - PAD - lw - GAP;
    const paneH = series.getPane().getHeight();
    for (const t of lineLabels.list) t.y = yOf(t.price);
    const dec = meta.byName.get(market.coin)?.szDecimals;
    regroup(clusters(lineLabels.list, h, (t) => series.priceToCoordinate(t.price), held?.key).map((run) => groupOf(run, market.coin, dec, (y) => y >= h / 2 && y <= paneH - h / 2)));
    // Legend text sits only above the price pane's first labels and under its bottom edge (the volume legend), so it is measured only when a label is there.
    const single = lineLabels.list.filter((t) => !t.group);
    banded = [...single, ...lineLabels.groups].some((t) => t.y >= 0 && (t.y - h / 2 < legendBottom() || t.y + h / 2 > paneH));
    const text = banded ? legend() : [];
    const home = PAD + lw;
    const docked = place([...single.filter((t) => t.kind === 'position'), ...lineLabels.groups], [...text], h, home, (x, t) => x + t.w <= room).filter((b) => b.t);
    // Liquidation and trigger labels take their slots before resting limits; a crowded line may step past room (the newest bars), never onto the price axis.
    const rest = single.filter((t) => !quiet(t) && t.kind !== 'position');
    const lefts = place([...rest.filter((t) => !t.tag), ...rest.filter((t) => t.tag)], [...text, ...docked], h, home, (x, t) => x + t.w <= pane - GAP).filter((b) => b.t);
    const headOf = (t: Label) => (el.querySelector<HTMLElement>(`.tag.quiet[data-key="${t.key}"] > span`)?.offsetWidth ?? 0) + 2;
    const near = [...lefts];
    for (const t of single.filter(quiet)) {
      const head = headOf(t);
      const end = pane - GAP;
      const all = [...text, ...near];
      const past = slot(t.y, head, h, home, all);
      const over = past === home || past + head <= Math.min(room, end) ? null : slot(t.y, head, h, home, [...text.filter((b) => b.hit), ...near]);
      const x = over === null ? past : over + head <= end ? over : null;
      // Its clipped rest stops short of the first box right of it on its line (over the legend, of its controls and the other labels only).
      const wall = Math.min(end, ...(over === null ? all : all.filter((b) => b.hit || b.t)).filter((b) => b.left >= (x ?? home) && b.top < t.y + h / 2 && t.y - h / 2 < b.bot).map((b) => b.left - GAP));
      const cap = x === null ? 0 : Math.max(head, Math.min(over !== null ? Math.max(room, x + head) : x === home ? Infinity : room, wall) - x);
      Object.assign(t, { left: x ?? home, under: x === null, over: x !== null && over !== null, cap });
      if (t.y >= 0) near.push({ top: t.y - h / 2, bot: t.y + h / 2, left: t.left, w: t.w || head, t });
    }
    // An open list sits below its label, or above it in the lower half of the window, and covers the labels under it. It is drawn in the top layer, so it runs past the pane to the window's edge: vx, vy, span and room are in window pixels.
    const open = lineLabels.groups.find((g) => g.key === lineLabels.open);
    if (open && !phone.current) {
      const r = el.getBoundingClientRect(), y = r.top + open.y, up = y > innerHeight / 2, vx = r.left + open.left;
      Object.assign(open, { up, vx, vy: up ? y - h / 2 : y + h / 2, span: Math.max(0, innerWidth - vx - PAD), room: Math.max(h, (up ? y : innerHeight - y) - h / 2 - PAD) });
    }
    const cover = [listBox(open, h), open && { top: open.y - h / 2, bot: open.y + h / 2, left: open.left, w: open.w }].filter((b) => !!b);
    // On a phone the open list is a sheet over the whole screen, so every label is covered.
    const sheet = !!open && phone.current;
    for (const t of lineLabels.list) {
      if (sheet || cover.some(meets({ top: t.y - h / 2, bot: t.y + h / 2, left: t.left, w: t.w }, 0))) t.under = true;
      const c = clear.get(t.key);
      if (t.under || t.y < 0 || t.group || quiet(t)) clear.delete(t.key);
      else if (!c || Math.abs(c.left - t.left) > GAP || Math.abs(c.y - t.y) > GAP) clear.set(t.key, { at: now, left: t.left, y: t.y });
      if (now - (clear.get(t.key)?.at ?? -SETTLE) < SETTLE) (t.under = true), wait(now + SETTLE);
    }
    // A row's ✕ is inert for SETTLE ms after the list opens, flips or gains or loses a row (an upward list is pinned at its bottom, a scrolled one may clamp), or the row moves.
    const rows = new Map<string, number>();
    open?.rows.forEach((r, i) => {
      const k = `${open.key}:${open.up}:${open.rows.length}:${r.key}:${i}`;
      rows.set(k, rowClear.get(k) ?? now);
      r.under = now - rows.get(k)! < SETTLE;
      if (r.under) wait(now + SETTLE);
    });
    rowClear = rows;
  };
  // No event covers every price scale move (axis drag, wheel, mode, resize, autoscale), so labels follow every frame while the pointer is on the chart and briefly after each kick.
  let raf = 0;
  let hot = false;
  let until = 0;
  let due = 0;
  const wait = (t: number) => ((until = Math.max(until, t)), (due = Math.max(due, t)));
  const loop = () => {
    raf = 0;
    // A hidden chart (phone tabs) has no width, and its tags never measure, which would keep the loop waiting.
    if (!lineLabels.list.length || !width) return;
    if (banded || lineLabels.open || performance.now() < due || inputs() !== seen) follow();
    if (hot || performance.now() < until) raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    lineLabels.size = Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--fs')) * 1.4);
    until = performance.now() + 300;
    raf ||= requestAnimationFrame(loop);
  };
  const heat = (on: boolean) => () => ((hot = on), kick());
  const enter = heat(true);
  const leave = heat(false);
  el.addEventListener('pointerenter', enter);
  el.addEventListener('pointerleave', leave);
  const resized = new ResizeObserver(() => ((width = el.clientWidth), (tableW = table?.clientWidth ?? width), kick()));
  resized.observe(el);
  if (table) resized.observe(table);
  series.subscribeDataChanged(kick);

  const trade = () => !!session.agent && session.holdsSigner;
  const movable = () => trade() && !narrow.current;
  const relabel = () => {
    const w = new Map(untrack(() => lineLabels.list.map((t) => [t.key, t])));
    const want = settings.chart.indicators.positions.on ? linesFor(market.coin, held) : [];
    const busy = (l: Line) => !!l.o && (cancelling.has(l.o.oid) || (!!held?.sent && held.key === l.key));
    const drag = (l: Line) => movable() && (l.kind === 'position' ? !(hasExit(market.coin, true) && hasExit(market.coin, false)) : l.kind === 'order' && !chased(l.o));
    lineLabels.list = want.map((l) => ({ ...l, x: !!l.o && trade(), drag: drag(l), busy: busy(l), under: false, y: -1, left: PAD, w: w.get(l.key)?.w ?? 0, group: w.get(l.key)?.group ?? '', cap: 0, over: false }));
    untrack(follow);
    untrack(kick);
  };

  // A dragged label and its ghost line follow the pointer, snapped to the coin's tick; Esc or a release at the same price sends nothing. After an accepted move the ghost stays until the feed shows the order moved, or HOLD ms.
  const show = () => ((el.dataset.drag = held ? JSON.stringify({ key: held.key, px: held.px, sent: held.sent, why: held.why }) : ''), relabel());
  const release = () => {
    if (!held) return;
    held.end();
    series.removePriceLine(held.ghost);
    held = null;
    show();
  };
  const tickOf = () => meta.byName.get(market.coin) ?? { szDecimals: 0, spot: false };
  const snap = (y: number) => {
    const px = series.coordinateToPrice(y);
    return px && px > 0 ? Number(px.toFixed(priceDecimals(px, tickOf()))) : null;
  };
  const near = (y: number) => lineLabels.list.filter((t) => t.o && t.drag && !t.group && t.y >= 0 && Math.abs(t.y - y) <= GRAB).sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];
  const labelAt = (e: MouseEvent): Label | undefined => {
    const tag = (e.target as Element).closest<HTMLElement>('.tag');
    if (tag) return lineLabels.list.find((t) => t.key === tag.dataset.key);
    const r = el.getBoundingClientRect();
    const [x, y] = [e.clientX - r.left, e.clientY - r.top];
    if (x >= inset() && x < el.clientWidth - series.priceScale().width() && y < series.getPane().getHeight()) return near(y);
  };
  // The plot shows ns-resize where a press grabs an order's line, and all over it while a drag is held.
  // 'top': on 'normal' a study line crossing the order line (a later series) wins the hover, though the press still grabs the order; the tools' primitive, attached first, still wins ties as its press does.
  const cursor: ISeriesPrimitive<Time> = { hitTest: (_x, y) => ((held ? !held.sent : near(y)) ? { externalId: 'order-line', zOrder: 'top', cursorStyle: 'ns-resize' } : null) };
  series.attachPrimitive(cursor);
  const drop = () => {
    const h = held!;
    const t = lineLabels.list.find((l) => l.key === h.key);
    if (!t || h.why || Math.abs(h.px - h.from) < tickSize(h.from, tickOf()) / 2) return release();
    if (socket.state !== 'open') return toast.error('socket down: order not moved'), release();
    h.sent = true;
    show();
    const o = t.o;
    (o ? moveOrder(o, h.px) : addPositionExit(h.coin, h.px))
      .catch((err) => (toast.error(err?.message || 'failed'), false))
      .then((ok) => (ok && o ? setTimeout(() => held === h && release(), HOLD) : held === h && release()));
  };
  /** A clicked label opens its editor: a resting limit's Edit, or the position TP/SL sheet at a reduce-only TP or SL that closes the position. */
  const edit = (o: OpenOrder) => {
    if (editable(o)) return editOrder(o);
    const closes = (positionOf(o.coin)?.szi ?? 0) * (o.side === 'A' ? 1 : -1) > 0;
    if (o.isTrigger && o.reduceOnly && !isTrailing(o) && closes) ui.overlay = { kind: 'positionTpsl', coin: o.coin, focus: o.orderType.startsWith('Take') ? 'TP' : 'SL' };
  };
  /** Claims a left press on a draggable label (not its ✕) or within GRAB px of a draggable order's line; it drags once the pointer travels DEAD px, mostly vertically. */
  const grab = (e: MouseEvent): boolean => {
    const t = e.button === 0 && !e.shiftKey && !held ? labelAt(e) : undefined;
    if (!t?.drag) return false;
    // The line moves by the pointer's travel, so a grab off-centre neither jumps it nor moves it on a release back at the press.
    const y0 = (series.priceToCoordinate(t.price) ?? t.y) - e.clientY;
    // A click with a jitter, or a sideways pan started on a line, moves nothing.
    const start = (m: MouseEvent) => {
      const [dx, dy] = [Math.abs(m.clientX - e.clientX), Math.abs(m.clientY - e.clientY)];
      if (Math.max(dx, dy) < DEAD) return false;
      if (dx > dy) return cancel(), false;
      const ghost = series.createPriceLine({ price: t.price, title: '', color: ghostColor(t), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true });
      held = { coin: market.coin, key: t.key, from: t.price, px: t.price, ghost, sent: false, why: '', end };
      return true;
    };
    const move = (m: MouseEvent) => {
      const px = held || start(m) ? snap(y0 + m.clientY) : null;
      if (!held || px === null) return;
      held.px = px;
      held.why = t.o ? moveRefusal(t.o, px) : exitRefusal(held.coin, px);
      held.ghost.applyOptions({ price: px, color: ghostColor(t, held.why) });
      show();
    };
    const cancel = () => (end(), release());
    const key = (k: KeyboardEvent) => k.code === 'Escape' && (k.preventDefault(), k.stopPropagation(), cancel());
    // A click on a resting limit's tag, with no drag, opens it for editing, unless the tag is still settling, like its ✕.
    const onTag = !!(e.target as Element).closest('.tag') && performance.now() - (clear.get(t.key)?.at ?? -SETTLE) >= SETTLE;
    const up = () => (end(), held ? drop() : onTag && t.o && edit(t.o));
    const end = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', key, true);
    // A release outside the window is never seen, so a later click there must not send.
    window.addEventListener('blur', cancel);
    return true;
  };

  const off = $effect.root(() => {
    $effect(() => {
      void settings.display.theme;
      let cancelled = false;
      void tick().then(() => {
        if (cancelled) return;
        untrack(() => {
          color.buy = css('--buy');
          color.sell = css('--sell');
          color.neutral = css('--dim');
          restyle();
          el.dataset.entryPriceColor = drawn.get('position')?.line.options().color ?? '';
          if (held) {
            const line = lineLabels.list.find((l) => l.key === held!.key);
            if (line) held.ghost.applyOptions({ color: ghostColor(line, held.why) });
          }
        });
      });
      return () => { cancelled = true; };
    });
    $effect(() => {
      const want = settings.chart.indicators.positions.on ? linesFor(market.coin) : [];
      drawn.forEach((d) => series.removePriceLine(d.line));
      drawn = new Map(want.map((l) => [l.key, { l, line: series.createPriceLine({ price: l.price, title: '', lineWidth: 1, lineStyle: quiet(l) ? LineStyle.Dotted : LineStyle.Dashed, ...style(l) }) }]));
      el.dataset.entryPriceColor = drawn.get('position')?.line.options().color ?? '';
      [sig, grouped, ends] = ['', new Set(), new Set()];
      const data = (ls: Line[]) => JSON.stringify(ls.map((l) => ({ kind: l.kind, price: l.price, title: l.parts.join(quiet(l) ? ' ' : ' | ') })));
      el.dataset.lines = data(want.filter((l) => !quiet(l)));
      el.dataset.extremes = data(want.filter(quiet));
      void settings.display.fs;
      lineLabels.size = Math.round(parseFloat(getComputedStyle(el).getPropertyValue('--fs')) * 1.4);
      relabel();
      const now = held && want.find((l) => l.key === held!.key);
      // A sent move ends once the feed shows it; a drag whose order left the feed, or that may no longer drag, is dropped unsent.
      const done = held && (!movable() || held.coin !== market.coin || !now || (held.sent && now.price === held.px));
      if (done && !held!.sent) toast.error('order changed: drag cancelled, nothing sent');
      if (done) untrack(release);
    });
    // Esc (once no overlay takes it) or a press outside the group's label and list closes the list.
    $effect(() => {
      const at = lineLabels.open;
      if (!at) return;
      untrack(() => (follow(), kick()));
      const close = () => (lineLabels.open = '');
      const key = (k: KeyboardEvent) => k.code === 'Escape' && !ui.overlay && (k.preventDefault(), k.stopPropagation(), close());
      const press = (e: PointerEvent) => (e.target as Element).closest?.(`[data-testid=line-group][data-key="${at}"], [data-testid=group-list][data-key="${at}"], [data-testid=group-scrim]`) || close();
      window.addEventListener('keydown', key, true);
      window.addEventListener('pointerdown', press, true);
      window.addEventListener('resize', kick);
      window.addEventListener('scroll', kick, true);
      return () => (window.removeEventListener('keydown', key, true), window.removeEventListener('pointerdown', press, true), window.removeEventListener('resize', kick), window.removeEventListener('scroll', kick, true));
    });
  });
  return {
    kick,
    grab,
    off: () => {
      release();
      series.detachPrimitive(cursor);
      off();
      cancelAnimationFrame(raf);
      resized.disconnect();
      series.unsubscribeDataChanged(kick);
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      lineLabels.list = [];
      lineLabels.groups = [];
      lineLabels.open = '';
    }
  };
}
