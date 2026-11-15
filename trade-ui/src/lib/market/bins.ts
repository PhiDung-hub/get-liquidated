// Relative imports keep this module loadable from the Playwright specs, which have no $lib alias.
import { maxDecimals, priceDecimals, type Tick } from '../signing/wire';
import { fmtNum } from '../util/format';

export interface Bin { step: number; nSigFigs: number | null; mantissa: number | null; decimals: number }

const bin = (nSigFigs: number | null, m: number, t: number): Bin => {
  const decimals = Math.max(-t, 0);
  return { step: Number((m * 10 ** t).toFixed(decimals)), nSigFigs, mantissa: nSigFigs === null ? null : m, decimals };
};

/** HL's book grouping options, finest first (spec §1.1). The finest is always the tick, so it goes out ungrouped. */
export function binOptions(bidPx: number, t: Tick): Bin[] {
  const L = Math.floor(Math.log10(bidPx));
  const i = priceDecimals(bidPx, t);
  const a = Math.max(2, Math.min(5, maxDecimals(t) + L + 1));
  const o = Math.max(0, L - 4);
  const out = o > 0 ? [bin(null, 1, 0)] : [];
  for (let e = a; e >= 2; e--) {
    out.push(...(e === 5 ? [1, 2, 5] : [1]).map((m) => bin(o === 0 && e === a && m === 1 ? null : e, m, a - e - i + o)));
  }
  return out;
}

export const pickBin = (options: Bin[], stored: number | undefined): Bin => options.find((b) => b.step === stored) ?? options[0];

export const fmtStep = (step: number, decimals: number) => fmtNum(step, decimals);
