import { arr, num, optNum, str } from '$lib/util/parse';
import { meta, spotRoute } from '$lib/market/meta.svelte';

export interface Position {
  coin: string; dex: string; szi: number; entryPx: number; positionValue: number; uPnl: number; roe: number;
  liqPx: number | null; marginUsed: number; leverage: { type: 'cross' | 'isolated'; value: number }; fundingSinceOpen: number;
}
export interface Balance { coin: string; total: number; hold: number; spotHold: number | null; supplied: number; ltv: number; entryNtl: number }
export interface DexState {
  dex: string; accountValue: number; marginUsed: number; totalNtl: number; withdrawable: number;
  crossValue: number; crossNtl: number; crossMmu: number; isolatedMargin: number;
}
type Mode = 'portfolioMargin' | 'unifiedAccount' | 'standard';

export const inventory = $state({
  positions: [] as Position[], balances: [] as Balance[], dexStates: [] as DexState[], broken: [] as string[],
  accountValue: 0, marginUsed: 0, totalNtl: 0, withdrawable: 0, pmRatio: 0, borrowRatio: 0,
  abstraction: '', rate: null as { used: number; cap: number } | null, loaded: false, spotLoaded: false,
  /** spotState pushes so far; what a feed showed before push n is in every push from n on. */
  spotPushes: 0,
  /** The unnamed agent, which extraAgents leaves out; HL's API page lists it as app.hyperliquid.xyz. */
  unnamedAgent: null as { address: string; validUntil: number | null } | null
});

const position = (dex: string, p: any): Position => ({
  coin: str(p.coin, 'coin'), dex, szi: num(p.szi, 'szi'), entryPx: num(p.entryPx, 'entryPx'),
  positionValue: num(p.positionValue, 'positionValue'), uPnl: num(p.unrealizedPnl, 'unrealizedPnl'),
  roe: num(p.returnOnEquity, 'returnOnEquity'), liqPx: optNum(p.liquidationPx), marginUsed: num(p.marginUsed, 'marginUsed'),
  leverage: { type: p.leverage?.type === 'isolated' ? 'isolated' : 'cross', value: num(p.leverage?.value, 'leverage') },
  fundingSinceOpen: num(p.cumFunding?.sinceOpen ?? 0, 'cumFunding')
});

function parseDex(dex: string, s: any) {
  const positions = arr<any>(s.assetPositions, 'assetPositions').map((ap) => position(dex, ap.position));
  const state: DexState = {
    dex, accountValue: num(s.marginSummary.accountValue, 'accountValue'), marginUsed: num(s.marginSummary.totalMarginUsed, 'totalMarginUsed'),
    totalNtl: num(s.marginSummary.totalNtlPos, 'totalNtlPos'), withdrawable: num(s.withdrawable, 'withdrawable'),
    crossValue: num(s.crossMarginSummary?.accountValue ?? 0, 'crossAccountValue'), crossNtl: num(s.crossMarginSummary?.totalNtlPos ?? 0, 'crossNtlPos'),
    crossMmu: num(s.crossMaintenanceMarginUsed ?? 0, 'crossMaintenanceMarginUsed'),
    isolatedMargin: positions.reduce((t, p) => (p.leverage.type === 'isolated' ? t + p.marginUsed : t), 0)
  };
  return { state, positions };
}

let waiters: (() => void)[] = [];
/** Resolves on the next position or open-order push. */
export const nextFeed = () => new Promise<void>((done) => waiters.push(done));
export function fed() {
  const w = waiters;
  waiters = [];
  for (const done of w) done();
}

/** A dex whose state does not parse keeps its last good state; with none, it is listed in `broken`. */
export function applyClearinghouse(d: any) {
  const states = arr<[string, any]>(d.clearinghouseStates, 'clearinghouseStates');
  const dexStates: DexState[] = [], positions: Position[] = [], broken: string[] = [];
  for (const [dex, s] of states) {
    try {
      const parsed = parseDex(String(dex), s);
      dexStates.push(parsed.state);
      positions.push(...parsed.positions);
    } catch (e) {
      console.warn(`dropped ${dex || 'main'} clearinghouse state`, e);
      const old = inventory.dexStates.find((x) => x.dex === dex);
      if (!old) {
        broken.push(String(dex));
        continue;
      }
      dexStates.push(old);
      positions.push(...inventory.positions.filter((p) => p.dex === dex));
    }
  }
  const sum = (f: (s: DexState) => number) => dexStates.reduce((t, s) => t + f(s), 0);
  Object.assign(inventory, {
    positions, dexStates, broken, accountValue: sum((s) => s.accountValue), marginUsed: sum((s) => s.marginUsed),
    totalNtl: sum((s) => s.totalNtl), withdrawable: sum((s) => s.withdrawable), loaded: true
  });
  fed();
}

export function applySpot(d: any) {
  const s = d.spotState;
  const balances = arr<any>(s?.balances, 'balances').map((b) => ({
    coin: str(b.coin, 'coin'), total: num(b.total, 'total'), hold: num(b.hold, 'hold'), spotHold: optNum(b.spotHold),
    supplied: optNum(b.supplied) ?? 0, ltv: optNum(b.ltv) ?? 0, entryNtl: num(b.entryNtl ?? 0, 'entryNtl')
  }));
  const borrow = Array.isArray(s.tokenToPortfolioBorrowRatio) ? s.tokenToPortfolioBorrowRatio.find((r: any) => r?.[0] === 0)?.[1] : null;
  Object.assign(inventory, { balances, pmRatio: optNum(s.portfolioMarginRatio) ?? 0, borrowRatio: optNum(borrow) ?? 0, spotLoaded: true, spotPushes: inventory.spotPushes + 1 });
  fed();
}

export const positionOf = (coin: string) => inventory.positions.find((p) => p.coin === coin);
export const balanceOf = (token: string) => inventory.balances.find((b) => b.coin === token)?.total ?? 0;
/** A spot token's balance less what its open orders hold. */
export const freeOf = (token: string) => {
  const b = inventory.balances.find((x) => x.coin === token);
  return b ? b.total - (b.spotHold ?? b.hold) : 0;
};
export const markOf = (p: Position) => p.positionValue / Math.abs(p.szi);
export const fractionOfEquity = (amount: number, equity: number) => Number.isFinite(equity) && equity > 0 ? amount / equity : NaN;
export const liqDist = (p: Position) => {
  const d = p.liqPx ? Math.abs(p.liqPx - markOf(p)) / markOf(p) : NaN;
  return !Number.isFinite(d) ? '—' : d > 10 ? '>1000%' : `${(d * 100).toFixed(1)}%`;
};

export const modeOf = (a: string): Mode | null => (!a ? null : a === 'portfolioMargin' || a === 'unifiedAccount' ? a : 'standard');
const tokenName = (i: number): string | undefined => (i === 0 ? 'USDC' : meta.spotTokens[i]);
const collateralOf = (dex: string) => tokenName(meta.collateral.get(dex) ?? 0);

/** USDC value of one token at its spot mark, as HL's account panel prices it; NaN while a mark it needs is unknown. */
function usdPx(name: string | undefined): number {
  if (name === 'USDC') return 1;
  if (!name || !meta.spotLoaded) return NaN;
  return spotRoute(name)?.reduce((px, coin) => px * (meta.spotPx.get(coin) ?? NaN), 1) ?? 0;
}
export const usdValue = (b: Balance) => (b.total ? b.total * usdPx(b.coin) : 0);

/** Spot pair coins whose marks the account figures need, joined so an unchanged set compares equal. */
export function spotCoins(): string {
  if (!meta.spotLoaded) return '';
  const names = new Set(inventory.balances.filter((b) => b.total !== 0).map((b) => b.coin));
  for (const s of inventory.dexStates) if (s.accountValue || s.crossMmu || s.withdrawable) names.add(collateralOf(s.dex) ?? '');
  return [...new Set([...names].flatMap((n) => (n && n !== 'USDC' && spotRoute(n)) || []))].sort().join(',');
}

const scaled = (f: (s: DexState) => number) => inventory.dexStates.reduce((t, s) => (f(s) ? t + f(s) * usdPx(collateralOf(s.dex)) : t), 0);

/** HL's leverage base: collateral tokens at their mark, plus under portfolio margin each other supplied token at its LTV. */
function marginBase(mode: Mode) {
  if (!inventory.spotLoaded) return NaN;
  const collaterals = new Set(['USDC', ...[...meta.collateral.values()].map(tokenName)]);
  const weight = (b: Balance) => (collaterals.has(b.coin) ? 1 : mode === 'portfolioMargin' && b.ltv > 0 && b.supplied > 0 ? b.ltv : 0);
  return inventory.balances.reduce((t, b) => t + (weight(b) && usdValue(b) * weight(b)), 0);
}

function unifiedRatio() {
  if (!inventory.spotLoaded) return NaN;
  const by = new Map<string, { mm: number; iso: number }>();
  for (const s of inventory.dexStates) {
    const name = collateralOf(s.dex);
    if (!name) continue;
    const g = by.get(name) ?? { mm: 0, iso: 0 };
    by.set(name, { mm: g.mm + s.crossMmu, iso: g.iso + s.isolatedMargin });
  }
  let ratio = 0;
  for (const [name, g] of by) {
    const free = (inventory.balances.find((b) => b.coin === name)?.total ?? 0) - g.iso;
    if (free > 0) ratio = Math.max(ratio, g.mm / free);
  }
  return Math.min(ratio, 1);
}

/** The account block's figures as HL computes them. Under portfolio margin and unified accounts the perp equity already sits in the spot USDC balance. */
export function summary() {
  const mode = modeOf(inventory.abstraction);
  const spot = inventory.spotLoaded ? inventory.balances.reduce((t, b) => t + usdValue(b), 0) : NaN;
  const perps = inventory.loaded && !inventory.broken.length ? scaled((s) => s.accountValue) : NaN;
  const usdc = inventory.balances.find((b) => b.coin === 'USDC');
  const free = !inventory.spotLoaded ? NaN : usdc ? usdc.total - (usdc.spotHold ?? usdc.hold) : 0;
  const base = { mode, spot, perps, uPnl: inventory.positions.reduce((t, p) => t + p.uPnl, 0), mm: scaled((s) => s.crossMmu) };
  if (mode === null || mode === 'standard') {
    const cross = scaled((s) => s.crossValue) + 1e-8;
    const available = free + scaled((s) => s.withdrawable);
    return { ...base, equity: mode ? spot + perps : NaN, ratio: base.mm / cross, leverage: scaled((s) => s.crossNtl) / cross, available, borrow: NaN };
  }
  const ratio = mode === 'unifiedAccount' ? unifiedRatio() : inventory.spotLoaded ? inventory.pmRatio : NaN;
  const leverage = inventory.dexStates.reduce((t, s) => t + s.crossNtl, 0) / (marginBase(mode) + 1e-8);
  return { ...base, equity: spot, ratio, leverage, available: free, borrow: inventory.spotLoaded ? inventory.borrowRatio : NaN };
}
