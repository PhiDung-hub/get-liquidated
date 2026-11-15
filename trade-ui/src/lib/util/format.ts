// toLocaleString builds a formatter on every call, which was most of the book's render cost, so each is built once.
const fixed = new Map<number, Intl.NumberFormat>();
const SZ = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
export function fmtNum(n: number, d: number) {
  if (!Number.isFinite(n)) return '—';
  let f = fixed.get(d);
  if (!f) fixed.set(d, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })));
  return f.format(n);
}
export function fmtUsd(n: number) {
  if (!Number.isFinite(n)) return '—';
  const abs = fmtNum(Math.abs(n), 2);
  return `${n < 0 && abs !== '0.00' ? '-' : ''}$${abs}`;
}
/** Unknown szDecimals (HIP-3 dex coins, meta not loaded) shows up to 6 places rather than truncating. */
export const fmtSz = (n: number, szDecimals?: number) =>
  szDecimals !== undefined ? fmtNum(n, szDecimals) : Number.isFinite(n) ? SZ.format(n) : '—';
/** An amount in a spot pair's quote token: $ for USDC. */
export const fmtIn = (n: number, quote: string) => (quote === 'USDC' ? fmtUsd(n) : `${fmtNum(n, 2)} ${quote}`);
export const fmtCompact = (n: number) => (Number.isFinite(n) ? COMPACT.format(n) : '—');
/** A table amount: cents below $100K, compact above ($248.01M), where the cents are noise. */
export const fmtUsdShort = (n: number) => (Number.isFinite(n) && Math.abs(n) >= 1e5 ? `${n < 0 ? '-' : ''}$${COMPACT.format(Math.abs(n))}` : fmtUsd(n));
export const fmtPct = (n: number, d = 2) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(d)}%` : '—');
export const fmtTime = (ms: number) => new Date(ms).toISOString().slice(5, 19).replace('T', ' ');
/** Today (UTC) as HH:MM:SS, an older time as MM-DD HH:MM. */
export const fmtWhen = (ms: number) => { const s = fmtTime(ms); return s.slice(0, 5) === fmtTime(Date.now()).slice(0, 5) ? s.slice(-8) : s.slice(0, 11); };
export const fmtAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Display decimals for a price: 5 significant figures, capped at 6 - szDecimals (8 - szDecimals on spot). */
export function pxDecimals(px: number, szDecimals: number, spot = false): number {
  if (!(px > 0)) return 2;
  const sig = Math.max(0, 4 - Math.floor(Math.log10(px)));
  return Math.min(sig, (spot ? 8 : 6) - szDecimals);
}
export const fmtPx = (px: number, szDecimals = 0, spot = false) => fmtNum(px, pxDecimals(px, szDecimals, spot));
