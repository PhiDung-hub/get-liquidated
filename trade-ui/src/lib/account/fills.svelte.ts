import { info } from '$lib/transport/info';
import { net } from '$lib/transport/network';
import { emitter } from '$lib/util/emitter';
import { arr, num, optNum, str } from '$lib/util/parse';
import { idbGetWithin, idbPut } from '$lib/util/storage';

export interface Fill {
  coin: string; px: number; sz: number; side: 'B' | 'A'; time: number; dir: string; closedPnl: number; fee: number;
  oid: number; tid: number; crossed: boolean; cloid?: string; liquidation: boolean; feeToken: string; startPosition: number | null;
  /** HL's liquidation detail: the mark price that triggered it, a backstop (protocol takeover) rather than a book order, and a fill against another account's liquidation. */
  liqMarkPx: number | null; backstop: boolean; priceImproved: boolean;
}
// The list is only ever replaced whole, so it stays unproxied: a deep proxy over thousands of fills cost a snapshot per save and a trap per read.
class Fills { list = $state.raw<Fill[]>([]); seeded = $state(false); }
export const fills = new Fills();
export const fillEvents = emitter<Fill[]>();
/** Fills the user feed pushed after its snapshot, for the account being viewed. */
export const liveFills = emitter<Fill[]>();
// Spot fills charge fees in the received token; only USDC fees can come off USDC PnL.
export const netPnl = (f: Fill) => f.closedPnl - (f.feeToken === 'USDC' ? f.fee : 0);
const filledByOrder = $derived.by(() => {
  const totals = new Map<string, number>();
  for (const f of fills.list) {
    const key = `${f.coin}:${f.oid}`;
    totals.set(key, (totals.get(key) ?? 0) + f.sz);
  }
  return totals;
});
export const filledSizeOf = (f: Fill) => filledByOrder.get(`${f.coin}:${f.oid}`) ?? 0;
export const entrySizeOf = (f: Fill) => f.liquidation ? 0
  : f.dir === 'Open Long' || f.dir === 'Open Short' ? f.sz
    : (f.dir === 'Long > Short' || f.dir === 'Short > Long') && f.startPosition !== null
      ? Math.max(0, f.sz - Math.abs(f.startPosition)) : 0;
/** The closed part's average entry: closedPnl (gross of fee) over the closed size moves the fill price back to it. NaN for an opening or spot fill. */
export const entryPxOf = (f: Fill, spot: boolean) => {
  const closed = f.sz - entrySizeOf(f);
  return spot || closed <= 0 ? NaN : f.px + (f.side === 'A' ? -f.closedPnl : f.closedPnl) / closed;
};
const seen = new Set<string>();
let owner = '';
let gen = 0;

// A saved fill carries the parsed fields; one from HL carries its liquidation object.
function fill(f: any, me: string): Fill {
  const liq = typeof f.liquidation === 'object' ? f.liquidation : null, by = liq?.liquidatedUser?.toLowerCase();
  return {
    coin: str(f.coin, 'coin'), px: num(f.px, 'px'), sz: num(f.sz, 'sz'), side: f.side === 'B' ? 'B' : 'A', time: num(f.time, 'time'),
    dir: String(f.dir ?? ''), closedPnl: num(f.closedPnl, 'closedPnl'), fee: num(f.fee, 'fee'), oid: num(f.oid, 'oid'),
    tid: num(f.tid, 'tid'), crossed: !!f.crossed, cloid: f.cloid ?? undefined, feeToken: String(f.feeToken ?? 'USDC'),
    startPosition: optNum(f.startPosition),
    liquidation: f.liquidation === true || (!!by && by === me),
    liqMarkPx: optNum(liq ? liq.markPx : f.liqMarkPx), backstop: liq ? liq.method === 'backstop' : f.backstop === true,
    priceImproved: liq ? !!by && by !== me : f.priceImproved === true
  };
}

const keyOf = (f: Fill) => `${f.coin}:${f.tid}:${f.oid}`;

export function mergeFills(rows: any[], me: string, saved = false): Fill[] {
  const fresh: Fill[] = [];
  for (const r of rows) {
    const f = fill(r, me);
    const key = keyOf(f);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(f);
  }
  if (!fresh.length) return fresh;
  fills.list = [...fills.list, ...fresh].sort((a, b) => b.time - a.time);
  fillEvents.emit(fresh);
  if (me === owner && !saved) {
    unsaved = [...unsaved, ...fresh];
    persist();
  }
  return fresh;
}

const PAGE = 2000;
const UNSAVED_MAX = 500;
// Long, as a lost read refetches the whole history; a slow phone at load can spend 2 s just reaching the read's callback.
const CACHE_MS = 10_000;
const WINDOW = 90 * 86_400_000;
// The list holds every fill from the window's start to `synced`; each page of a seed moves it, so a seed a 429 cut off resumes from there, on a retry or a reload.
let synced = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
// Writing the whole list stalls the page on a long history, so new fills go in a small record tied to the list it extends, and the list is rewritten only when that grows.
let unsaved: Fill[] = [];
let base = 0;
let reading: Promise<void> | null = null;
const cacheKey = (user: string) => `${net.current}:${user}`;

function persist() {
  const key = cacheKey(owner);
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (key !== cacheKey(owner) || reading) return;
    const keep = (e: unknown) => console.warn('fill cache: could not save', e);
    if (base && unsaved.length < UNSAVED_MAX) return void idbPut(`${key}:new`, { base, synced, fills: unsaved }).catch(keep);
    const since = Date.now() - WINDOW;
    const [stamp, done] = [Date.now(), new Set(unsaved)];
    idbPut(key, { base: stamp, synced, fills: fills.list.filter((f) => f.time >= since) }).then(() => {
      if (key !== cacheKey(owner)) return;
      base = stamp;
      unsaved = unsaved.filter((f) => !done.has(f));
    }).catch(keep);
  }, 500);
}

async function readCache(user: string, since: number): Promise<{ base: number; synced: number; fills: Fill[]; unsaved: Fill[] } | null> {
  try {
    const [c, d] = (await Promise.all([idbGetWithin(cacheKey(user), CACHE_MS), idbGetWithin(`${cacheKey(user)}:new`, CACHE_MS)])) as any[];
    if (c == null && d == null) return null;
    const b = Number(c?.base ?? 0);
    const extra = d?.base === b ? d : null;
    const rows = (x: any) => (x ? arr(x.fills, 'cached fills').map((f) => fill(f, user)).filter((f) => f.time >= since) : []);
    return { base: b, synced: num(extra?.synced ?? c?.synced ?? 0, 'cached synced'), fills: rows(c), unsaved: rows(extra) };
  } catch (e) {
    console.warn('fill cache unreadable, asking for the full history', e);
    return null;
  }
}

async function restore(user: string, sinceMs: number) {
  const cached = await readCache(user, sinceMs);
  if (user !== owner) return;
  synced = cached?.synced ?? 0;
  base = cached?.base ?? 0;
  const rows = [...(cached?.fills ?? []), ...(cached?.unsaved ?? [])];
  const stored = new Set(rows.map(keyOf));
  unsaved = [...(cached?.unsaved ?? []), ...unsaved.filter((f) => !stored.has(keyOf(f)))];
  mergeFills(rows, user, true);
}

export async function seedFills(user: string, sinceMs = Date.now() - WINDOW) {
  const g = ++gen;
  if (user !== owner) {
    owner = user;
    seen.clear();
    fills.list = [];
    synced = base = 0;
    unsaved = [];
    clearTimeout(timer);
    const read: Promise<void> = (reading = restore(user, sinceMs).finally(() => {
      if (reading === read) reading = null;
    }));
  }
  await reading;
  if (g !== gen) return;
  let startTime = Math.max(sinceMs, synced);
  for (;;) {
    const page = arr<any>(await info({ type: 'userFillsByTime', user, startTime, aggregateByTime: false }, 10_000), 'userFillsByTime');
    if (g !== gen) return;
    mergeFills(page, user);
    // No +1: a page can end inside a run of same-ms fills; the coin:tid:oid dedupe absorbs the overlap.
    const next = Math.max(startTime, ...page.map((f) => Number(f.time)));
    const done = page.length < PAGE || next === startTime;
    startTime = synced = next;
    persist();
    if (done) break;
  }
  fills.seeded = true;
}
