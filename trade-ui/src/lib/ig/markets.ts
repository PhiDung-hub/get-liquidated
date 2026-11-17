export interface Market {
  epic: string; name: string; type: string; expiry: string; bid: number | null; offer: number | null;
  status: string; delay: number | null; updated: number | null; streaming: boolean;
}
export interface Account {
  id: string; name: string; currency: string; type: string; status: string;
  available: number | null; balance: number | null; pnl: number | null; margin: number | null;
}
export interface Detail {
  market: Market; currencies: string[]; unit: string; minSize: number | null;
  marketOrders: boolean; stopDistance: number | null; stopUnit: string;
}
export interface Session { accountId: string; accounts: Account[]; environment: 'live' }
export const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export const record = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
export const text = (v: unknown) => typeof v === 'string' ? v : '';
export const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export function quoteTime(value: unknown, now = Date.now()): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1000;
  if (typeof value !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(now);
  const [h, m, s] = value.split(':').map(Number);
  if (h > 23 || m > 59 || s > 59) return null;
  date.setUTCHours(h, m, s, 0);
  return date.getTime() > now + 1000 ? date.getTime() - 86_400_000 : date.getTime();
}
export function marketOf(value: unknown, now = Date.now()): Market | null {
  const r = record(value), i = record(r.instrument), q = Object.keys(record(r.snapshot)).length ? record(r.snapshot) : r;
  const epic = text(i.epic || r.epic), name = text(i.name || r.instrumentName);
  if (!/^[A-Za-z0-9._]{6,30}$/.test(epic) || !name) return null;
  return { epic, name, type: text(i.type || r.instrumentType), expiry: text(i.expiry || r.expiry), bid: numeric(q.bid), offer: numeric(q.offer), status: text(q.marketStatus), delay: numeric(q.delayTime), updated: quoteTime(q.updateTimestampUTC ?? q.updateTimeUTC, now), streaming: (i.streamingPricesAvailable ?? r.streamingPricesAvailable) === true };
}
export function detailOf(value: unknown): Detail {
  const r = record(value), i = record(r.instrument), rules = record(r.dealingRules), market = marketOf(r);
  if (!market) throw new Error('IG returned an invalid market. Refresh before trading.');
  return { market, currencies: array(i.currencies).map(c => text(record(c).code)).filter(c => /^[A-Z]{3}$/.test(c)), unit: text(i.unit), minSize: record(rules.minDealSize).unit === 'POINTS' ? numeric(record(rules.minDealSize).value) : null, marketOrders: ['AVAILABLE_DEFAULT_ON', 'AVAILABLE_DEFAULT_OFF'].includes(rules.marketOrderPreference), stopDistance: numeric(record(rules.minNormalStopOrLimitDistance).value), stopUnit: text(record(rules.minNormalStopOrLimitDistance).unit) };
}
export const spread = (m: Market) => m.bid !== null && m.offer !== null && m.offer >= m.bid ? m.offer - m.bid : null;
export function spreadBps(m: Market) {
  const points = spread(m), mid = m.bid !== null && m.offer !== null ? (m.bid + m.offer) / 2 : 0;
  return points !== null && mid > 0 ? points / mid * 10000 : null;
}
export const fresh = (m: Market, now = Date.now()) => m.status === 'TRADEABLE' && m.delay === 0 && m.updated !== null && now - m.updated >= -1000 && now - m.updated <= 60_000 && spreadBps(m) !== null;
export const eligibleAccount = (a: Account | undefined) => a?.currency === 'SGD' && a.type === 'CFD' && a.status === 'ENABLED';
export interface Bar { time: number; open: number; high: number; low: number; close: number }
export function barsOf(prices: unknown[]): Bar[] {
  const mid = (v: unknown) => { const q = record(v), bid = numeric(q.bid), ask = numeric(q.ask); return bid !== null && ask !== null ? (bid + ask) / 2 : null; };
  return prices.flatMap(value => {
    const p = record(value), at = Date.parse(String(p.time).replaceAll('/', '-').replace(' ', 'T') + 'Z');
    const open = mid(p.open), high = mid(p.high), low = mid(p.low), close = mid(p.close);
    return Number.isFinite(at) && open !== null && high !== null && low !== null && close !== null ? [{ time: at / 1000, open, high, low, close }] : [];
  }).sort((a, b) => a.time - b.time).filter((v, i, all) => !i || v.time !== all[i - 1].time);
}
export const RESOLUTIONS = { '1m': ['MINUTE', 60], '5m': ['MINUTE_5', 300], '15m': ['MINUTE_15', 900], '1H': ['HOUR', 3600], '4H': ['HOUR_4', 14400], '1D': ['DAY', 86400] } as const;
export type Resolution = keyof typeof RESOLUTIONS;
export const isResolution = (v: unknown): v is Resolution => typeof v === 'string' && Object.hasOwn(RESOLUTIONS, v);
export const HISTORY = 200;
export const mergeBars = (old: Bar[], next: Bar[]) => [...old.filter(b => !next.length || b.time < next[0].time), ...next].slice(-HISTORY);
/** The bar still forming at `now`, built from one mid quote; null while the last loaded bar already covers it. */
export function liveBar(bars: Bar[], previous: Bar | null, price: number, step: number, now = Date.now()): Bar | null {
  const time = Math.floor(now / 1000 / step) * step, last = bars.at(-1);
  if (!last || last.time > time) return null;
  const base = last.time === time ? last : previous?.time === time ? previous : { time, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price };
  return { ...base, high: Math.max(base.high, price), low: Math.min(base.low, price), close: price };
}
export const sma = (bars: Bar[], length: number) => bars.flatMap((b, i) => i + 1 < length ? [] : [{ time: b.time, value: bars.slice(i + 1 - length, i + 1).reduce((sum, x) => sum + x.close, 0) / length }]);
/** A position's running profit in its dealing currency from the quote IG sent with it; IG's own figure stays authoritative. */
export function positionPnl(row: unknown) {
  const p = record(record(row).position), m = record(record(row).market);
  const level = numeric(p.level), size = numeric(p.size), exit = numeric(p.direction === 'BUY' ? m.bid : m.offer);
  if (level === null || size === null || exit === null || !['BUY', 'SELL'].includes(p.direction)) return null;
  const points = p.direction === 'BUY' ? exit - level : level - exit, contract = numeric(p.contractSize), scale = numeric(m.scalingFactor) || 1;
  return { points, value: contract === null ? null : points * size * contract / scale, exit };
}
/** IG fills a limit at the level or better and a stop at the level or worse, so the side of the quote the level sits on decides the type. */
export const orderKind = (buy: boolean, level: number, m: Market) => (buy ? level < (m.offer ?? 0) : level > (m.bid ?? Infinity)) ? 'LIMIT' : 'STOP';
/** Why a position's stop or limit level cannot be set against the current quote, or '' when it can. */
export function levelError(buy: boolean, stop: number | null, limit: number | null, bid: number, offer: number) {
  if (stop !== null && (buy ? stop >= bid : stop <= offer)) return `A ${buy ? 'long' : 'short'} position's stop must be ${buy ? 'below the sell' : 'above the buy'} price.`;
  if (limit !== null && (buy ? limit <= offer : limit >= bid)) return `A ${buy ? 'long' : 'short'} position's limit must be ${buy ? 'above the buy' : 'below the sell'} price.`;
  return '';
}
