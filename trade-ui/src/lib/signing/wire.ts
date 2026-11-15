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

export function roundSz(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return snap(Math.floor(sz * f + 1e-9) / f, szDecimals);
}
