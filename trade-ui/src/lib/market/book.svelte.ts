import { socket } from '$lib/transport/ws.svelte';
import { arr, num } from '$lib/util/parse';
import { market } from './market.svelte';
import { meta } from './meta.svelte';
import { binOptions, type Bin } from './bins';

export interface Level { px: number; sz: number; n: number }
type Sides = { bids: Level[]; asks: Level[] };

export const MAX_ROWS = 20;
const EMPTY: Sides = { bids: [], asks: [] };
class Book {
  bids = $state.raw<Level[]>([]);
  asks = $state.raw<Level[]>([]);
  time = $state(0);
  bin = $state<Bin | null>(null);
  gen = $state(0);
}
export const book = new Book();
export const bbo = $state({ bid: 0, ask: 0, bidSz: 0, askSz: 0, time: 0, seen: 0 });
let top = EMPTY;
let depth = EMPTY;
let bboN = [0, 0];
let waiting = { top: false, depth: false };

const level = (l: any): Level => ({ px: num(l.px, 'px'), sz: num(l.sz, 'sz'), n: num(l.n, 'n') });
const sides = (d: any): Sides => {
  const [bids, asks] = arr<any[]>(d.levels, 'levels');
  return { bids: bids.map(level), asks: asks.map(level) };
};
const worse = (isBid: boolean, px: number) => (l: Level) => (isBid ? l.px < px : l.px > px);

function merged(isBid: boolean): Level[] {
  const fast = isBid ? top.bids : top.asks;
  const slow = isBid ? depth.bids : depth.asks;
  const last = fast.at(-1);
  const rows = [...fast, ...(last ? slow.filter(worse(isBid, last.px)) : slow)];
  const best = isBid ? bbo.bid : bbo.ask;
  if (!(best > 0)) return rows.slice(0, MAX_ROWS);
  // Grouped sizes belong to the depth snapshot; a newer BBO cannot remove its buckets.
  if (book.bin !== null) return rows.slice(0, MAX_ROWS);
  const live = { px: best, sz: isBid ? bbo.bidSz : bbo.askSz, n: bboN[isBid ? 0 : 1] };
  return [live, ...rows.filter(worse(isBid, best))].slice(0, MAX_ROWS);
}

function merge() {
  book.bids = merged(true);
  book.asks = merged(false);
}

// HL pushes bbo only on change, so a book frame whose best levels still agree with it vouches for a quiet bbo; one that moved past it does not, and a dead bbo feed goes stale.
function stamp(d: any, s: Sides) {
  book.time = num(d.time, 'time');
  const [b, a] = [s.bids[0]?.px, s.asks[0]?.px];
  // Grouped buckets floor bids and ceil asks, so the bbo can sit inside the best bucket.
  const agrees = book.bin === null ? b === bbo.bid && a === bbo.ask : b <= bbo.bid && a >= bbo.ask;
  if (agrees) bbo.seen = Date.now();
  merge();
}

export function applyTop(d: any) {
  if (waiting.top) return;
  top = sides(d);
  // An untagged frame lands here only when it is a thin market's whole book, so older depth rows are gone.
  if (!d.fast) depth = EMPTY;
  stamp(d, top);
}

export function applyDepth(d: any) {
  if (waiting.depth) return;
  depth = sides(d);
  stamp(d, depth);
}

export function clearBook() {
  top = depth = EMPTY;
  book.bids = [];
  book.asks = [];
}

// Frames carry no echo of nSigFigs/mantissa, and HL keeps sending the old grouping until it handles the unsubscribe, so after a bin change each feed drops frames until its new subscription is acked; HL sends that sub's first snapshot right after the ack.
export function setBin(b: Bin | null) {
  book.bin = b;
  book.gen++;
  waiting = { top: true, depth: true };
  clearBook();
}

export function bookAcked(gen: number, feed: 'top' | 'depth') {
  if (gen === book.gen) waiting[feed] = false;
}

/** Bin options for the selected coin from its best bid, or its mark before the first bbo; empty until meta lists the coin. */
export function currentBins(): Bin[] {
  const a = meta.byName.get(market.coin);
  const px = bbo.bid > 0 ? bbo.bid : (market.ctx?.markPx ?? meta.ctxs.get(market.coin)?.markPx ?? 0);
  return !a || !(px > 0) ? [] : binOptions(px, a);
}

const bboLevel = (l: any, side: string): Level =>
  l ? { px: num(l.px, side), sz: num(l.sz, `${side} sz`), n: num(l.n, `${side} n`) } : { px: 0, sz: 0, n: 0 };
const parseBbo = (d: any) => {
  const [b, a] = [bboLevel(d.bbo[0], 'bid'), bboLevel(d.bbo[1], 'ask')];
  return { bid: b.px, ask: a.px, bidSz: b.sz, askSz: a.sz, time: num(d.time, 'time'), n: [b.n, a.n] };
};

// `seen` is local time so clock skew can't make a live book look stale.
export function applyBbo(d: any) {
  const { n, ...b } = parseBbo(d);
  bboN = n;
  Object.assign(bbo, b, { seen: Date.now() });
  merge();
}

export const watchBbo = (coin: string, f: (b: { bid: number; ask: number; bidSz: number; askSz: number; time: number }) => void) =>
  socket.subscribe({ type: 'bbo', coin }, (d) => f(parseBbo(d)));
