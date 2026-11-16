/** Port of python float_to_wire: 8dp, reject lossy rounding, strip trailing zeros. */
export function floatToWire(x: number): string {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) throw new Error(`floatToWire rejects ${x}`);
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire would round ${x}`);
  const s = rounded.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

export const MIN_NOTIONAL = 10;

/** A market's price rule; on spot `szDecimals` is the base token's. */
export type Tick = { szDecimals: number; spot: boolean };
export const maxDecimals = (t: Tick) => (t.spot ? 8 : 6) - t.szDecimals;

/** HL tick rule: ≤5 significant figures and ≤ 6 - szDecimals decimals (8 - szDecimals on spot); integers always valid. */
export function priceDecimals(px: number, t: Tick): number {
  if (!(px > 0)) throw new Error(`invalid price ${px}`);
  return Math.max(0, Math.min(maxDecimals(t), 4 - Math.floor(Math.log10(px))));
}

export const tickSize = (px: number, t: Tick) => 10 ** -priceDecimals(px, t);

const snap = (x: number, d: number) => Number(x.toFixed(d));

export function roundPx(px: number, t: Tick, isBuy: boolean): number {
  const d = priceDecimals(px, t);
  const f = 10 ** d;
  const scaled = px * f;
  const r = isBuy ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  const out = snap(r / f, d);
  // Rounding can cross a power of ten (99999.5 → 100000) and change the allowed decimals; re-round once.
  return priceDecimals(out, t) < d ? roundPx(out, t, isBuy) : out;
}

/**
 * Typed text kept to a number Hyperliquid can take, as it is typed: digits and one "." (a "," from a comma keypad reads as
 * "."), at most `decimals` places, and a leading "-" only when `signed`. Nothing else reaches the box.
 * The point stays even with no places allowed: dropped, the next digit would join the whole part (2.5 → 25).
 * Pasted text keeps its magnitude: "64,123.5" is grouped, not 64.1, and "1e5" is 100000, not 15.
 */
export function cutDecimals(text: string, decimals: number, signed = false): string {
  let t = text.normalize('NFKC').replace('−', '-').trim();
  if (/^-?(\d+\.?\d*|\.\d+)e[-+]?\d+$/i.test(t) && Math.abs(Number(t)) < 1e21) t = Number(t).toFixed(12);
  t = /^\D*[1-9]\d{0,2}(,\d{3})+(\.\d*)?\D*$/.test(t) ? t.replaceAll(',', '') : t.replace(',', '.');
  const sign = signed && t.startsWith('-') ? '-' : '';
  const [whole, frac] = t.replace(/[^\d.]/g, '').split('.');
  return sign + (frac === undefined ? whole : `${whole}.${frac.slice(0, Math.max(0, decimals))}`);
}

/** Typed price text cut to the tick rule: 5 significant figures and at most maxDecimals places; integers always pass. */
export function cutPx(text: string, t: Tick | undefined): string {
  const most = t ? maxDecimals(t) : 8;
  const v = cutDecimals(text, most);
  const m = /^(\d*)\.(\d*)$/.exec(v);
  if (!m || !t) return v;
  const whole = m[1].replace(/^0+/, '');
  const sig = whole ? 5 - whole.length : 5 + /^0*/.exec(m[2])![0].length;
  return cutDecimals(v, Math.max(0, Math.min(most, sig)));
}

/** Typed size text cut to the market's szDecimals (8 places until the market list has loaded). */
export const cutSz = (text: string, szDecimals: number | undefined) => cutDecimals(text, szDecimals ?? 8);

export function roundSz(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return snap(Math.floor(Number((sz * f).toPrecision(15))) / f, szDecimals);
}
