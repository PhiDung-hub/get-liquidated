import { info } from '$lib/transport/info';
import { net } from '$lib/transport/network';
import { rateLimited, socket } from '$lib/transport/ws.svelte';
import { arr, num, optNum, str } from '$lib/util/parse';
import { fresh, keep, load, save } from '$lib/util/storage';

export type MarginMode = 'normal' | 'noCross' | 'strictIsolated';
/** `index` is the asset id orders carry; `feeScale` is the deployer's fee scale (0 on the main dex). A spot pair's `collateral` is its quote token and `base` its base token. */
export interface Asset {
  name: string; index: number; szDecimals: number; maxLeverage: number; onlyIsolated: boolean; isDelisted: boolean;
  dex: string; collateral: string; marginMode: MarginMode; feeScale: number; growth: boolean; tiers: Tier[]; spot: boolean;
  base: string; fullName?: string;
}
export interface Tier { lowerBound: number; maxLeverage: number }
type Tables = Map<number, Tier[]>;
export interface Dex { name: string; fullName: string }
/** Spot contexts have no oracle, open interest or funding. */
export interface Ctx { markPx: number; oraclePx: number | null; midPx: number | null; prevDayPx: number; dayNtlVlm: number; openInterest: number | null; funding: number | null }
export interface Note { category: string; displayName: string; keywords: string[] }

export const meta = $state({
  assets: [] as Asset[], byName: new Map<string, Asset>(), ctxs: new Map<string, Ctx>(), loaded: false,
  dexes: [] as Dex[], hip3: 'loading' as 'loading' | 'on' | 'off', notes: new Map<string, Note>(), capped: new Set<string>(),
  collateral: new Map<string, number>([['', 0]]), spotTokens: [] as string[], spotPairs: new Map<string, Map<string, string>>(),
  spotPx: new Map<string, number>(), spotLoaded: false, spot: [] as Asset[], spotState: 'loading' as 'loading' | 'on' | 'off'
});

export const dexOf = (coin: string) => (coin.includes(':') ? coin.slice(0, coin.indexOf(':')) : '');
/** HL's spot coin names ('@107', 'PURR/USDC'), told apart before the spot list lands. */
export const spotName = (coin: string) => coin.startsWith('@') || coin.includes('/');
export type CoinKind = 'perp' | 'hip3' | 'spot';
export const kindOf = (coin: string): CoinKind => (spotName(coin) ? 'spot' : coin.includes(':') ? 'hip3' : 'perp');
// HL drops the whole socket on a subscription to an unknown dex, so a HIP-3 coin is only subscribed once its dex's meta has it; a spot pair waits for the spot list alike.
export const unlisted = (coin: string) => kindOf(coin) !== 'perp' && !meta.byName.has(coin);
export const listState = (k: CoinKind) => (k === 'perp' ? (meta.loaded ? 'on' : 'loading') : k === 'hip3' ? meta.hip3 : meta.spotState);
export const isSpot = (coin: string) => meta.byName.get(coin)?.spot ?? spotName(coin);
/** The pair as BASE/QUOTE on spot; the coin itself otherwise. */
export const nameOf = (coin: string) => {
  const a = meta.byName.get(coin);
  return a?.spot ? `${a.base}/${a.collateral}` : coin;
};
export const symOf = (coin: string) => {
  const a = meta.byName.get(coin);
  return a?.spot ? a.base : coin.slice(coin.indexOf(':') + 1);
};
export const quoteOf = (coin: string) => meta.byName.get(coin)?.collateral ?? 'USDC';
/** Cross is refused for onlyIsolated and for any HIP-3 margin mode other than normal (stricter than HL). */
export const isolatedOnly = (a: Asset | undefined) => !!a && (a.onlyIsolated || a.marginMode !== 'normal');

export const parseCtx = (c: any): Ctx => ({
  markPx: num(c.markPx, 'markPx'), oraclePx: num(c.oraclePx, 'oraclePx'), midPx: optNum(c.midPx),
  prevDayPx: num(c.prevDayPx, 'prevDayPx'), dayNtlVlm: num(c.dayNtlVlm, 'dayNtlVlm'),
  openInterest: num(c.openInterest, 'openInterest'), funding: num(c.funding, 'funding')
});
export const parseSpotCtx = (c: any): Ctx => ({
  markPx: num(c.markPx, 'markPx'), oraclePx: null, midPx: optNum(c.midPx), prevDayPx: num(c.prevDayPx, 'prevDayPx'),
  dayNtlVlm: num(c.dayNtlVlm, 'dayNtlVlm'), openInterest: null, funding: null
});

const parseTables = (list: unknown): Tables =>
  new Map((Array.isArray(list) ? list : []).map(([id, t]: [number, any]) => [
    Number(id),
    arr<any>(t?.marginTiers, 'marginTiers').map((x) => ({ lowerBound: num(x.lowerBound, 'lowerBound'), maxLeverage: num(x.maxLeverage, 'maxLeverage') })).sort((a, b) => a.lowerBound - b.lowerBound)
  ]));
// HL: a margin table id below 50 is one tier at that max leverage; an unknown id falls back to the asset's own.
const tiersOf = (id: unknown, tables: Tables, maxLeverage: number): Tier[] =>
  typeof id === 'number' && id > 0 && id < 50 ? [{ lowerBound: 0, maxLeverage: id }] : (tables.get(Number(id)) ?? [{ lowerBound: 0, maxLeverage }]);

/** HL margin tiers: maintenance = value × 1/(2 × the tier's max leverage) − a deduction that keeps it continuous across tiers. */
export function maintenance(a: Asset, ntl: number) {
  let rate = 0, deduction = 0;
  for (const t of a.tiers) {
    if (ntl < t.lowerBound) break;
    const r = 1 / (2 * t.maxLeverage);
    deduction += t.lowerBound * (r - rate);
    rate = r;
  }
  return { margin: ntl * rate - deduction, rate, deduction };
}

const parseAsset = (u: any, index: number, dex: string, tables: Tables): Asset => ({
  name: str(u.name, 'name'), index, szDecimals: num(u.szDecimals, 'szDecimals'), maxLeverage: num(u.maxLeverage, 'maxLeverage'),
  onlyIsolated: !!u.onlyIsolated, isDelisted: !!u.isDelisted, dex, collateral: 'USDC', marginMode: u.marginMode ?? 'normal',
  feeScale: dex ? num(u.deployerFeeScale ?? 1, 'deployerFeeScale') : 0, growth: u.growthMode === 'enabled',
  tiers: tiersOf(u.marginTableId, tables, num(u.maxLeverage, 'maxLeverage')), spot: false, base: str(u.name, 'name').slice(u.name.indexOf(':') + 1)
});

// Universe names per dex in universe order, delisted slots included: allDexsAssetCtxs lists contexts in this order.
const universes = new Map<string, string[]>();
let main: Asset[] = [];
let hip3: Asset[] = [];
let spot: Asset[] = [];

// meta.assets stays perps only, so the picker's perp tabs, leverage and maintenance keep their meaning.
function publish() {
  meta.assets = [...main, ...hip3];
  meta.spot = spot;
  meta.byName = new Map([...meta.assets, ...spot].map((a) => [a.name, a]));
}

function setCtxs(into: Map<string, Ctx>, dex: string, list: any[]) {
  const names = universes.get(dex);
  if (!names) return;
  list.forEach((c, i) => {
    if (!names[i] || c?.markPx == null) return;
    try {
      into.set(names[i], parseCtx(c));
    } catch (e) {
      console.warn(`dropped ${names[i]} context`, e);
    }
  });
}

function setMain(m: any) {
  // Index is the raw universe position; delisted entries keep their slot.
  const tables = parseTables(m?.marginTables);
  main = arr<any>(m?.universe, 'universe').map((u, i) => parseAsset(u, i, '', tables));
  universes.set('', main.map((a) => a.name));
}

// The last good lists, shown at once on the next load while fresh ones are read; asset() refuses them until then.
// Both lists read within FRESH_MS are not read again until relist(), when the tab can trade: allDexsAssetCtxs brings every dex's contexts meanwhile, the main one too.
type Cached = { main?: unknown; dexes?: unknown; metas?: unknown; mainAt?: number; hip3At?: number };
const CACHE = `trade-ui:meta:${net.current}`;
const FRESH_MS = 5 * 60_000;
let stored: Cached = {};
let warm = false;
const stale = $state({ main: false, hip3: false, spot: false });
const stash = (part: Cached) => save(CACHE, (stored = { ...stored, ...part }));
const recent = (at: unknown, age = Date.now() - Number(at)) => age >= 0 && age < FRESH_MS;

export function restoreMeta() {
  const c = load<Cached | null>(CACHE, null);
  if (!c || typeof c !== 'object') return;
  stored = c;
  const live = !!(c.main && c.dexes && c.metas) && recent(c.mainAt) && recent(c.hip3At);
  try {
    if (c.main) {
      setMain(c.main);
      stale.main = true;
    }
    if (c.dexes && c.metas) {
      const { listed, assets, collateral } = hip3Assets(arr(c.dexes, 'perpDexs'), arr(c.metas, 'allPerpMetas'));
      [hip3, meta.dexes, stale.hip3] = [assets, listed, true];
      if (live) Object.assign(meta, { collateral, hip3: 'on', loaded: true });
    }
    warm = live;
  } catch (e) {
    console.warn('cached market list dropped', e);
    [stored, main, hip3, meta.dexes] = [{}, [], [], []];
    [stale.main, stale.hip3, warm, meta.hip3, meta.loaded] = [false, false, false, 'loading', false];
  }
  publish();
}

/** Ends a warm load's skip, true when it had one: the lists are then read like a cold load's. */
export function relist(): boolean {
  const was = warm;
  warm = false;
  return was;
}

export async function loadMeta() {
  if (warm) return;
  const [m, ctxs] = await info({ type: 'metaAndAssetCtxs' }, 10_000);
  setMain(m);
  stale.main = false;
  stash({ main: m, mainAt: Date.now() });
  const next = new Map(meta.ctxs);
  setCtxs(next, '', arr<any>(ctxs, 'assetCtxs'));
  meta.ctxs = next;
  publish();
  meta.loaded = true;
}

/** Asset id = 100000 + dex index × 10000 + universe position (Fact 1); a name without its dex prefix means the two lists disagree, so none of it is used. */
function hip3Assets(dexes: unknown[], metas: any[]) {
  if (dexes[0] !== null || dexes.length !== metas.length) throw new Error(`perpDexs (${dexes.length}) and allPerpMetas (${metas.length}) disagree`);
  const listed: Dex[] = [];
  const assets: Asset[] = [];
  const collateral = new Map([['', 0]]);
  for (let d = 1; d < dexes.length; d++) {
    const dex = dexes[d] as any;
    const name = str(dex?.name, 'dex name');
    const universe = arr<any>(metas[d]?.universe, 'universe');
    const stray = universe.find((u) => typeof u?.name !== 'string' || !u.name.startsWith(`${name}:`));
    if (stray) throw new Error(`${stray?.name} in dex ${d} is not prefixed ${name}:`);
    if (universe.length >= 10_000) throw new Error(`dex ${name} has ${universe.length} assets`);
    collateral.set(name, Number(metas[d].collateralToken));
    // Available balance assumes USDC, so another collateral stays out until it is handled.
    if (metas[d].collateralToken !== 0 || universe.every((u) => u.isDelisted)) continue;
    listed.push({ name, fullName: String(dex.fullName ?? name) });
    universes.set(name, universe.map((u) => u.name));
    const tables = parseTables(metas[d].marginTables);
    assets.push(...universe.map((u, i) => parseAsset(u, 100_000 + d * 10_000 + i, name, tables)));
  }
  return { listed, assets, collateral };
}

// A read cut off by a socket drop is asked once more (over REST while the socket is down); a 429 up to 4 more times, each after the socket's hold.
const read = (type: string, limits = 4, drops = 1): Promise<any> =>
  info({ type }, 10_000).catch((e) =>
    rateLimited(e) && limits ? read(type, limits - 1, drops) : e?.kind === 'closed' && drops ? read(type, limits, 0) : Promise.reject(e)
  );

/** HIP-3 dexes load beside the main list; any failure leaves the main markets as they are and HIP-3 off. */
export async function loadHip3() {
  if (warm) return;
  try {
    const [dexes, metas] = await Promise.all([read('perpDexs'), read('allPerpMetas')]);
    const { listed, assets, collateral } = hip3Assets(arr(dexes, 'perpDexs'), arr(metas, 'allPerpMetas'));
    hip3 = assets;
    meta.dexes = listed;
    meta.collateral = collateral;
    stale.hip3 = false;
    publish();
    meta.hip3 = 'on';
    stash({ dexes, metas, hip3At: Date.now() });
  } catch (e) {
    [hip3, meta.dexes, stale.hip3] = [[], [], false];
    publish();
    meta.hip3 = 'off';
    throw e;
  }
}

/** allDexsAssetCtxs is keyed by dex name in alphabetical order, so it is matched by name and never used for asset ids. */
export function applyDexCtxs(d: any) {
  const next = new Map(meta.ctxs);
  for (const [dex, list] of arr<[string, any[]]>(d.ctxs, 'ctxs')) if (Array.isArray(list)) setCtxs(next, String(dex), list);
  meta.ctxs = next;
}

export function watchPickerPrices() {
  let closed = false;
  let queued = Promise.resolve();
  const offs = [
    socket.subscribe({ type: 'fastAssetCtxs' }, (data) => {
      queued = queued.then(async () => {
        if (closed) return;
        const bytes = Uint8Array.from(atob(str(data, 'fastAssetCtxs')), (c) => c.charCodeAt(0));
        const decoded: unknown = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).json();
        if (closed) return;
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('fastAssetCtxs: expected a price record');
        const next = new Map(meta.ctxs);
        const spotPx = new Map(meta.spotPx);
        for (const [coin, value] of Object.entries(decoded)) {
          const ctx = next.get(coin);
          if (!ctx) continue;
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${coin}: expected price fields`);
          const fields = value as Record<string, unknown>;
          const markPx = fields.markPx === undefined ? ctx.markPx : num(fields.markPx, `${coin} markPx`);
          const midPx = fields.midPx === undefined ? ctx.midPx : fields.midPx === null ? null : num(fields.midPx, `${coin} midPx`);
          if (!(markPx > 0) || (midPx !== null && !(midPx > 0))) throw new Error(`${coin}: expected positive prices`);
          next.set(coin, { ...ctx, markPx, midPx });
          if (meta.byName.get(coin)?.spot) spotPx.set(coin, markPx);
        }
        [meta.ctxs, meta.spotPx] = [next, spotPx];
      }).catch((e) => console.warn('dropped fastAssetCtxs message', e));
    }),
    socket.subscribe({ type: 'allMids' }, (data) => {
      try {
        if (!data?.mids || typeof data.mids !== 'object' || Array.isArray(data.mids)) throw new Error('allMids: expected a price record');
        const next = new Map(meta.ctxs);
        const spotPx = new Map(meta.spotPx);
        for (const [coin, value] of Object.entries(data.mids)) {
          if (!meta.byName.get(coin)?.spot) continue;
          const ctx = next.get(coin);
          const px = num(value, `${coin} midPx`);
          if (!(px > 0)) throw new Error(`${coin}: expected a positive price`);
          if (ctx) next.set(coin, { ...ctx, markPx: px, midPx: px });
          spotPx.set(coin, px);
        }
        [meta.ctxs, meta.spotPx] = [next, spotPx];
      } catch (e) {
        console.warn('dropped spot allMids message', e);
      }
    })
  ];
  return () => { closed = true; offs.forEach((off) => off()); };
}

/** A list another load of this browser read within FRESH_MS, or a read that is then kept; a list that fails to parse is dropped, so the next call reads again. */
async function cachedRead<T>(name: string, read: () => Promise<unknown>, parse: (raw: any, cached: boolean) => T, ttl = FRESH_MS): Promise<T> {
  const key = `trade-ui:${name}:${net.current}`;
  const hit = fresh<unknown>(key, ttl);
  const raw = hit ?? (await read());
  try {
    const out = parse(raw, !!hit);
    if (!hit) keep(key, raw);
    return out;
  } catch (e) {
    save(key, null);
    throw e;
  }
}

/** Coins at their open-interest cap on `dex`, replacing that dex's earlier answer; a failed read keeps it. An answer under a minute old, from this tab or another, is reused. */
export async function loadCaps(dex: string) {
  try {
    const ask = () => info({ type: 'perpsAtOpenInterestCap', ...(dex ? { dex } : {}) });
    const list = await cachedRead(`caps:${dex}`, ask, (r) => arr<string>(r, 'perpsAtOpenInterestCap').map(String), 55_000);
    meta.capped = new Set([...[...meta.capped].filter((c) => dexOf(c) !== dex), ...list]);
  } catch (e) {
    console.warn(`perpsAtOpenInterestCap ${dex || 'main'} failed`, e);
  }
}

let notes: Promise<void> | null = null;
/** Categories and search keywords, fetched once; a failure is retried on the next call. */
export function loadNotes() {
  notes ??= cachedRead('notes', () => Promise.all([info({ type: 'perpCategories' }), info({ type: 'perpConciseAnnotations' })]), ([cats, anns]) => {
    const out = new Map<string, Note>();
    for (const [coin, cat] of arr<[string, string]>(cats, 'perpCategories')) out.set(coin, { category: String(cat).toLowerCase(), displayName: '', keywords: [] });
    for (const [coin, a] of arr<[string, any]>(anns, 'perpConciseAnnotations')) {
      const keywords = Array.isArray(a?.keywords) ? a.keywords.map(String) : [];
      out.set(coin, { category: out.get(coin)?.category ?? String(a?.category ?? '').toLowerCase(), displayName: String(a?.displayName ?? ''), keywords });
    }
    meta.notes = out;
  })
    .catch((e) => {
      notes = null;
      console.warn('market notes failed', e);
    });
  return notes;
}

/**
 * Spot asset id = 10000 + the pair's `index`, never its universe position (they part from about pair 71 on).
 * Every '@N' name must equal its index, or the whole list is refused: a wrong id would trade another pair.
 */
function spotAssets(m: any): Asset[] {
  const tokens = new Map(arr<any>(m.tokens, 'tokens').map((t) => [num(t.index, 'token index'), t]));
  const seen = new Set<string>();
  return arr<any>(m.universe, 'universe').map((u) => {
    const name = str(u.name, 'pair name');
    const idx = num(u.index, 'pair index');
    const [b, q] = arr<number>(u.tokens, 'pair tokens').map((i) => tokens.get(i));
    if (!b || !q) throw new Error(`${name} names an unknown token`);
    if (!Number.isInteger(idx) || idx < 0 || idx >= 10_000) throw new Error(`${name} has index ${u.index}`);
    if (name !== `@${idx}` && name !== `${b.name}/${q.name}`) throw new Error(`${name} has index ${idx}`);
    if (seen.has(name)) throw new Error(`${name} is listed twice`);
    seen.add(name);
    return {
      name, index: 10_000 + idx, szDecimals: num(b.szDecimals, 'szDecimals'), maxLeverage: 0, onlyIsolated: false, isDelisted: false, dex: '',
      collateral: str(q.name, 'token name'), marginMode: 'normal', feeScale: 0, growth: false, tiers: [], spot: true,
      base: str(b.name, 'token name'), fullName: typeof b.fullName === 'string' ? b.fullName : undefined
    };
  });
}

/** Token names by index and spot pair coins by base then quote name, for the account's valuation. */
function spotPairs(m: any) {
  const tokens: string[] = [];
  for (const t of arr<any>(m.tokens, 'tokens')) tokens[num(t.index, 'token index')] = str(t.name, 'token name');
  const pairs = new Map<string, Map<string, string>>();
  for (const u of arr<any>(m.universe, 'universe')) {
    const [base, quote] = arr<number>(u.tokens, 'pair tokens').map((i) => tokens[i]);
    if (!pairs.has(base)) pairs.set(base, new Map());
    if (!pairs.get(base)!.has(quote)) pairs.get(base)!.set(quote, str(u.name, 'pair name'));
  }
  return { spotTokens: tokens, spotPairs: pairs };
}

let spotRead: Promise<void> | null = null;
export const spotStale = () => stale.spot;
/**
 * The spot pairs and their contexts, from this browser's copy under FRESH_MS old (signed from only once read again, as perps) or one read.
 * Contexts are matched by coin: the answer also carries delisted '@N' and other '#N' coins, in no universe order.
 */
export function loadSpot(force = false): Promise<void> {
  // The cached copy's own load can still be settling when a trading tab asks for a fresh read.
  if (force && spotRead) return spotRead.then(() => (stale.spot ? loadSpot(true) : undefined));
  spotRead ??= cachedRead('spotList', () => read('spotMetaAndAssetCtxs'), ([m, ctxs], cached) => {
    Object.assign(meta, spotPairs(m), { spotLoaded: true });
    spot = spotAssets(m);
    const names = new Set(spot.map((a) => a.name));
    const next = new Map(meta.ctxs);
    const px = new Map(meta.spotPx);
    for (const c of arr<any>(ctxs, 'spot ctxs')) {
      if (!names.has(c?.coin)) continue;
      try {
        next.set(c.coin, parseSpotCtx(c));
        px.set(c.coin, next.get(c.coin)!.markPx);
      } catch (e) {
        console.warn(`dropped ${c.coin} context`, e);
      }
    }
    [meta.ctxs, meta.spotPx, stale.spot] = [next, px, cached];
    publish();
    meta.spotState = 'on';
  }, force ? 0 : FRESH_MS)
    .catch((e) => {
      [spot, stale.spot] = [[], false];
      publish();
      meta.spotState = 'off';
      throw e;
    })
    .finally(() => (spotRead = null));
  return spotRead;
}

/** HL prices a token on its USDC pair, else on its first quote's pair times that quote's USDC pair; no route prices it at 0. */
export function spotRoute(name: string): string[] | null {
  const quotes = meta.spotPairs.get(name);
  if (!quotes) return null;
  if (quotes.has('USDC')) return [quotes.get('USDC')!];
  const [quote, coin] = quotes.entries().next().value!;
  const leg = meta.spotPairs.get(quote)?.get('USDC');
  return leg ? [coin, leg] : null;
}

export const applySpotCtx = (d: any) => (meta.spotPx = new Map(meta.spotPx).set(str(d.coin, 'coin'), num(d.ctx.markPx, 'markPx')));

/** Listed by a list read this session, never only by the cached one. */
export function listed(coin: string): boolean {
  const a = meta.byName.get(coin);
  return !!a && !(a.spot ? stale.spot : a.dex ? stale.hip3 : stale.main);
}

export function asset(coin: string): Asset {
  const a = meta.byName.get(coin);
  if (!a) throw new Error(`unknown market ${coin}`);
  if (!listed(coin)) throw new Error(`${nameOf(coin)}: market list is still loading`);
  return a;
}
