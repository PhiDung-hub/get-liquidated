import type { Bar } from '$lib/market/candles';
import { atr, ema, hma, macd, rma, rsi, sma, source, stdev, stoch, supertrend, tr, sar, vwap, vwma, wma, type Anchor, type Num, type Source } from '$lib/market/indicators';

// Hyperliquid's chart (TradingView) defaults: getStudyInputs / getStudyStyles on app.hyperliquid.xyz, 2026-10-23. Inputs keep its order and labels, so the legend reads as there.
export type Val = number | string;
export type Inputs = Record<string, Val>;
export type Input = { id: string; label: string; kind: 'int' | 'float' | 'enum'; def: Val; min?: number; max?: number; options?: readonly string[] };
/** kind: line (default), hist (columns), points (cross marks) or arrows (markers on the first plot); alpha is 255·(100 − transparency)/100. */
export type Plot = { title: string; color: string; kind?: 'line' | 'hist' | 'points' | 'arrows'; width?: number; style?: number; alpha?: number; palette?: string[] };
export type Band = { value: number; color: string; style: number };
export type Out = { values: Num[][]; colors?: (number | null)[][]; times?: number[] };
export type Ctx = { bars: Bar[]; since: number; step?: number; rates?: { funding: Num[]; premium: Num[] } };
export type Def = {
  type: string; short: string; key: string; pane: 'price' | 'own'; inputs: Input[]; plots: Plot[];
  bands?: Band[]; fill?: { a: number; b: number; color: string; alpha: number; downColor?: string; bands?: true }; range?: [number, number]; digits?: number;
  /** A flow pane (ours, not Hyperliquid's), drawn from the trade and OI feeds. */
  flow?: 'cvd' | 'oid';
  data?: 'funding' | 'premium'; displaced?: boolean; percent?: boolean;
  name?: (inp: Inputs, i: number) => string;
  calc: (c: Ctx, inp: Inputs) => Out;
};
export type PlotStyle = { on?: boolean; color?: string; width?: number; style?: number; palette?: string[] };
export type Study = { id: string; type: string; inputs: Inputs; plots?: PlotStyle[]; bands?: { on?: boolean; color?: string }[]; fill?: { on?: boolean; color?: string; downColor?: string }; hidden?: boolean };

export const MAX_STUDIES = 12;
export const MAX_PANES = 4;
const SRC = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'] as const;
const METHODS = ['Simple', 'Exponential', 'Weighted'] as const;
const MA = { Simple: sma, Exponential: ema, Weighted: wma };
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
const ORDER = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const GREY = '#787B86';

const int = (id: string, label: string, def: number, min = 1, max = 10000): Input => ({ id, label, kind: 'int', def, min, max });
const pick = (id: string, label: string, def: string, options: readonly string[]): Input => ({ id, label, kind: 'enum', def, options });
const src = (def = 'close') => pick('source', 'Source', def, SRC);
const offset = int('offset', 'Offset', 0, -10000, 10000);
const num = (v: Val) => Number(v);
const closes = (c: Ctx) => source(c.bars, 'close');
/** Pine's offset: a positive one draws each value that many bars later; values pushed past the last bar are not drawn. */
const shift = (v: Num[], k: number): Num[] => (k ? v.map((_, i) => v[i - k] ?? null) : v);
const levels = (hi: number, lo: number, color: string, mid?: number): Pick<Def, 'bands' | 'fill' | 'range' | 'digits'> => ({
  bands: [hi, ...(mid === undefined ? [] : [mid]), lo].map((value) => ({ value, color: GREY, style: 2 })),
  fill: { a: 0, b: mid === undefined ? 1 : 2, color, alpha: 0x1a, bands: true },
  range: [0, 100], digits: 2
});

/** One price-pane line of a single average over a source (and an offset when Hyperliquid has one). */
function average(type: string, short: string, key: string, color: string, inputs: Input[], f: (xs: Num[], n: number, c: Ctx) => Num[]): Def {
  return {
    type, short, key, pane: 'price', inputs, plots: [{ title: 'Plot', color }],
    calc: (c, inp) => ({ values: [shift(f(inp.source === undefined ? closes(c) : source(c.bars, inp.source as Source), num(inp.length), c), num(inp.offset ?? 0))] })
  };
}

/** Moving Average Double/Triple/Multiple: one close average per period, in Hyperliquid's plot colours. */
function multiple(type: string, key: string, defs: number[], colors: string[]): Def {
  return {
    type, short: type, key, pane: 'price',
    inputs: [...defs.map((d, i) => int(ORDER[i], `${ORDINAL[i]} Period`, d)), pick('method', 'Method', 'Simple', METHODS)],
    plots: colors.map((color, i) => ({ title: `Plot ${i + 1}`, color })),
    name: (inp, i) => `${{ Simple: 'MA', Exponential: 'EMA', Weighted: 'WMA' }[inp.method as keyof typeof MA]} ${inp[ORDER[i]]}`,
    calc: (c, inp) => ({ values: defs.map((_, i) => MA[inp.method as keyof typeof MA](closes(c), num(inp[ORDER[i]]))) })
  };
}

/** MA/EMA Cross: the two averages, and a cross mark on the short one where they cross. */
function cross(type: string, key: string, f: typeof sma, short: string, long: string): Def {
  return {
    type, short: type, key, pane: 'price', inputs: [int('short', 'Short', 9, 1, 2000), int('long', 'Long', 26, 1, 2000)],
    plots: [{ title: 'Short', color: short }, { title: 'Long', color: long }, { title: 'Crosses', color: '#2196F3', kind: 'points', width: 4 }],
    calc: (c, inp) => {
      const [s, l] = [f(closes(c), num(inp.short)), f(closes(c), num(inp.long))];
      // Pine's ta.cross: above (or below) now, and not on that side a bar ago.
      const side = (i: number) => (s[i] === null || l[i] === null ? NaN : Math.sign(s[i]! - l[i]!));
      return { values: [s, l, s.map((v, i) => (side(i) && !Number.isNaN(side(i - 1)) && side(i) !== side(i - 1) ? v : null))] };
    }
  };
}

function extrema(c: Ctx, n: number) {
  const high = c.bars.map((_, i) => i < n - 1 ? null : Math.max(...c.bars.slice(i - n + 1, i + 1).map((b) => b.high)));
  const low = c.bars.map((_, i) => i < n - 1 ? null : Math.min(...c.bars.slice(i - n + 1, i + 1).map((b) => b.low)));
  return { high, low, mid: high.map((h, i) => h === null ? null : (h + low[i]!) / 2) };
}

const LIST: Def[] = [
  average('Moving Average', 'MA', 'ma', '#2196F3', [int('length', 'Length', 9), src(), offset], sma),
  average('Moving Average Exponential', 'EMA', 'ema', '#2196F3', [int('length', 'Length', 9), src(), offset], (xs, n) => ema(xs, n)),
  average('Moving Average Weighted', 'WMA', 'wma', '#2196F3', [int('length', 'Length', 9, 1, 2000), src(), offset], wma),
  average('Smoothed Moving Average', 'SMMA', 'smma', '#673AB7', [int('length', 'Length', 7, 1, 1e12), src()], rma),
  average('Hull Moving Average', 'HMA', 'hma', '#2196F3', [int('length', 'length', 9)], hma),
  average('VWMA', 'VWMA', 'vwma', '#2196F3', [int('length', 'len', 20)], (xs, n, c) => vwma(xs, c.bars.map((b) => b.volume), n)),
  average('Double EMA', 'DEMA', 'dema', '#43A047', [int('length', 'length', 9)], (xs, n) => {
    const e = ema(xs, n);
    return ema(e, n).map((e2, i) => (e2 === null ? null : 2 * e[i]! - e2));
  }),
  average('Triple EMA', 'TEMA', 'tema', '#2196F3', [int('length', 'length', 9)], (xs, n) => {
    const e1 = ema(xs, n);
    const e2 = ema(e1, n);
    return ema(e2, n).map((e3, i) => (e3 === null ? null : 3 * (e1[i]! - e2[i]!) + e3));
  }),
  multiple('Moving Average Double', 'ma2', [14, 21], ['#FF6D00', '#2196F3']),
  multiple('Moving Average Triple', 'ma3', [14, 21, 35], ['#FF6D00', '#2196F3', '#26C6DA']),
  multiple('Moving Average Multiple', 'ma6', [14, 21, 35, 50, 100, 200], ['#9C27B0', '#FF6D00', '#43A047', '#26C6DA', '#F50057', '#2196F3']),
  cross('MA Cross', 'macross', sma, '#43A047', '#FF6D00'),
  cross('EMA Cross', 'emacross', ema, '#FF6D00', '#43A047'),
  {
    // Week and longer anchors need history from the period's start, so a period that began before the loaded bars draws nothing; one no longer than a bar draws each bar's source, as on Hyperliquid.
    type: 'VWAP', short: 'VWAP', key: 'vwap', pane: 'price', inputs: [src('hlc3'), pick('anchor', 'Anchor Period', 'Session', ['Session', 'Week', 'Month', 'Quarter', 'Year'])],
    plots: [{ title: 'VWAP', color: '#2196F3' }],
    calc: (c, inp) => ({ values: [vwap(c.bars, c.since, inp.anchor as Anchor, inp.source as Source)] })
  },
  {
    type: 'Bollinger Bands', short: 'BB', key: 'bb', pane: 'price', inputs: [int('length', 'length', 20), { id: 'mult', label: 'mult', kind: 'float', def: 2, min: 0.001, max: 50 }],
    plots: [{ title: 'Median', color: '#FF6D00' }, { title: 'Upper', color: '#2196F3' }, { title: 'Lower', color: '#2196F3' }],
    fill: { a: 1, b: 2, color: '#2196F3', alpha: 0x0d },
    calc: (c, inp) => {
      const xs = closes(c);
      const n = num(inp.length);
      const basis = sma(xs, n);
      const dev = stdev(xs, n);
      const band = (s: number) => basis.map((b, i) => (b === null ? null : b + s * num(inp.mult) * dev[i]!));
      return { values: [basis, band(1), band(-1)] };
    }
  },
  {
    type: 'SuperTrend', short: 'SuperTrend', key: 'st', pane: 'price', inputs: [int('length', 'Length', 10, 1, 100), { id: 'factor', label: 'Factor', kind: 'float', def: 3, min: 1, max: 100 }],
    plots: [
      { title: 'SuperTrend', color: '#000080', width: 3, alpha: 0xa6, palette: ['#008000', '#800000'] },
      { title: 'Up Arrow', color: '#00FF00', kind: 'arrows', alpha: 0xa6 },
      { title: 'Down Arrow', color: '#FF0000', kind: 'arrows', alpha: 0xa6 }
    ],
    calc: (c, inp) => {
      const { value, dir } = supertrend(c.bars, num(inp.factor), num(inp.length));
      const turn = (to: number) => value.map((v, i) => (i && dir[i] === to && dir[i - 1] === -to ? v : null));
      return { values: [value, turn(-1), turn(1)], colors: [dir.map((d) => (d === null ? null : d < 0 ? 0 : 1))] };
    }
  },
  {
    type: 'Relative Strength Index', short: 'RSI', key: 'rsi', pane: 'own', inputs: [int('length', 'Length', 14, 1, 2000)],
    plots: [{ title: 'Plot', color: '#7E57C2' }], ...levels(70, 30, '#7E57C2', 50),
    calc: (c, inp) => ({ values: [rsi(closes(c), num(inp.length))] })
  },
  {
    type: 'MACD', short: 'MACD', key: 'macd', pane: 'own',
    inputs: [int('fast', 'fastLength', 12, 1, 2000), int('slow', 'slowLength', 26, 1, 2000), src(), int('signal', 'signalLength', 9, 1, 50)],
    plots: [{ title: 'Histogram', color: '#FF5252', kind: 'hist', palette: ['#22AB94', '#ACE5DC', '#FCCBCD', '#FF5252'] }, { title: 'MACD', color: '#2196F3' }, { title: 'Signal', color: '#FF6D00' }],
    calc: (c, inp) => {
      const m = macd(source(c.bars, inp.source as Source), num(inp.fast), num(inp.slow), num(inp.signal));
      const h = m.hist;
      // Rising above zero, falling above, rising below, falling below; with no previous bar it counts as falling.
      const colors = h.map((v, i) => (v === null ? null : (v >= 0 ? 0 : 2) + (h[i - 1] != null && h[i - 1]! < v ? 0 : 1)));
      return { values: [h, m.macd, m.signal], colors: [colors] };
    }
  },
  {
    type: 'Stochastic', short: 'Stoch', key: 'stoch', pane: 'own', inputs: [int('k', '%K Length', 14), int('smoothK', '%K Smoothing', 1), int('d', '%D Smoothing', 3)],
    plots: [{ title: '%K', color: '#2196F3' }, { title: '%D', color: '#FF6D00' }], ...levels(80, 20, '#2196F3'),
    calc: (c, inp) => {
      const k = sma(stoch(closes(c), source(c.bars, 'high'), source(c.bars, 'low'), num(inp.k)), num(inp.smoothK));
      return { values: [k, sma(k, num(inp.d))] };
    }
  },
  {
    type: 'Stochastic RSI', short: 'Stoch RSI', key: 'stochrsi', pane: 'own', inputs: [int('rsi', 'lengthRSI', 14), int('stoch', 'lengthStoch', 14), int('k', 'smoothK', 3), int('d', 'smoothD', 3)],
    plots: [{ title: '%K', color: '#2196F3' }, { title: '%D', color: '#FF6D00' }], ...levels(80, 20, '#2196F3'),
    calc: (c, inp) => {
      const r = rsi(closes(c), num(inp.rsi));
      const k = sma(stoch(r, r, r, num(inp.stoch)), num(inp.k));
      return { values: [k, sma(k, num(inp.d))] };
    }
  },
  {
    type: 'Average True Range', short: 'ATR', key: 'atr', pane: 'own', inputs: [int('length', 'length', 14, 1, 2000)],
    plots: [{ title: 'Plot', color: '#801922' }],
    calc: (c, inp) => ({ values: [atr(c.bars, num(inp.length))] })
  },
  {
    type: 'Ichimoku Cloud', short: 'Ichimoku', key: 'ichi', pane: 'price', displaced: true,
    inputs: [int('conversion', 'Conversion Line Length', 9), int('base', 'Base Line Length', 26), int('span', 'Leading Span B Length', 52), int('displacement', 'Lagging Span', 26, 1, 500)],
    plots: [{ title: 'Conversion Line', color: '#2962FF' }, { title: 'Base Line', color: '#B71C1C' }, { title: 'Lagging Span', color: '#43A047' }, { title: 'Leading Span A', color: '#A5D6A7' }, { title: 'Leading Span B', color: '#EF9A9A' }],
    fill: { a: 3, b: 4, color: '#43A047', downColor: '#F44336', alpha: 0x1a },
    calc: (c, inp) => {
      const conversion = extrema(c, num(inp.conversion)).mid;
      const base = extrema(c, num(inp.base)).mid;
      const span = extrema(c, num(inp.span)).mid;
      const d = num(inp.displacement) - 1;
      const pad = (v: Num[]) => [...v, ...Array<Num>(d).fill(null)];
      const times = [...c.bars.map((b) => b.time), ...Array.from({ length: d }, (_, i) => (c.bars.at(-1)?.time ?? 0) + (i + 1) * (c.step ?? 1))];
      const a = conversion.map((v, i) => v === null || base[i] === null ? null : (v + base[i]!) / 2);
      return { times, values: [pad(conversion), pad(base), shift(pad(closes(c)), -d), shift(pad(a), d), shift(pad(span), d)] };
    }
  },
  {
    type: 'ADX / DMI', short: 'DMI', key: 'dmi', pane: 'own', inputs: [int('adx', 'ADX Smoothing', 14), int('length', 'DI Length', 14)],
    plots: [{ title: 'ADX', color: '#F50057' }, { title: '+DI', color: '#2962FF' }, { title: '−DI', color: '#FF6D00' }], digits: 2,
    calc: (c, inp) => {
      const up = c.bars.map((b, i) => i ? b.high - c.bars[i - 1].high : null);
      const down = c.bars.map((b, i) => i ? c.bars[i - 1].low - b.low : null);
      const n = num(inp.length);
      const range = rma(tr(c.bars).map((v, i) => i ? v : null), n);
      const dm = (a: Num[], b: Num[]) => rma(a.map((v, i) => v === null ? null : v > b[i]! && v > 0 ? v : 0), n).map((v, i) => v === null || range[i] === null ? null : range[i] === 0 ? 0 : 100 * v / range[i]!);
      const plus = dm(up, down), minus = dm(down, up);
      const dx = plus.map((v, i) => v === null ? null : 100 * Math.abs(v - minus[i]!) / ((v + minus[i]!) || 1));
      return { values: [rma(dx, num(inp.adx)), plus, minus] };
    }
  },
  {
    type: 'On Balance Volume', short: 'OBV', key: 'obv', pane: 'own', inputs: [src()], plots: [{ title: 'OBV', color: '#2962FF' }],
    calc: (c, inp) => {
      let value = 0;
      const xs = source(c.bars, inp.source as Source);
      return { values: [xs.map((v, i) => value += i ? Math.sign(v - xs[i - 1]) * c.bars[i].volume : 0)] };
    }
  },
  {
    type: 'Keltner Channels', short: 'KC', key: 'kc', pane: 'price',
    inputs: [int('length', 'Length', 20), { id: 'mult', label: 'Multiplier', kind: 'float', def: 2, min: 0, max: 50 }, src(), pick('exponential', 'Exponential MA', 'Yes', ['Yes', 'No']), pick('bands', 'Bands Style', 'Average True Range', ['Average True Range', 'True Range', 'Range']), int('atr', 'ATR Length', 10)],
    plots: [{ title: 'Basis', color: '#2962FF' }, { title: 'Upper', color: '#2962FF' }, { title: 'Lower', color: '#2962FF' }], fill: { a: 1, b: 2, color: '#2196F3', alpha: 0x0d },
    calc: (c, inp) => {
      const n = num(inp.length);
      const basis = (inp.exponential === 'Yes' ? ema : sma)(source(c.bars, inp.source as Source), n);
      const range = inp.bands === 'True Range' ? tr(c.bars) : inp.bands === 'Average True Range' ? atr(c.bars, num(inp.atr)) : rma(c.bars.map((b) => b.high - b.low), n);
      const band = (sign: number) => basis.map((v, i) => v === null || range[i] === null ? null : v + sign * num(inp.mult) * range[i]!);
      return { values: [basis, band(1), band(-1)] };
    }
  },
  {
    type: 'Donchian Channels', short: 'DC', key: 'dc', pane: 'price', inputs: [int('length', 'Length', 20), offset],
    plots: [{ title: 'Basis', color: '#FF6D00' }, { title: 'Upper', color: '#2962FF' }, { title: 'Lower', color: '#2962FF' }], fill: { a: 1, b: 2, color: '#2196F3', alpha: 0x0d },
    calc: (c, inp) => {
      const e = extrema(c, num(inp.length));
      return { values: [e.mid, e.high, e.low].map((v) => shift(v, num(inp.offset))) };
    }
  },
  {
    type: 'Money Flow Index', short: 'MFI', key: 'mfi', pane: 'own', inputs: [int('length', 'Length', 14)], plots: [{ title: 'MFI', color: '#7E57C2' }], ...levels(80, 20, '#7E57C2', 50),
    calc: (c, inp) => {
      const xs = source(c.bars, 'hlc3');
      const flow = (sign: number) => sma(xs.map((v, i) => i ? (sign * (v - xs[i - 1]) > 0 ? v * c.bars[i].volume : 0) : null), num(inp.length));
      const pos = flow(1), neg = flow(-1);
      return { values: [pos.map((v, i) => v === null ? null : neg[i] === 0 ? (v === 0 ? null : 100) : 100 - 100 / (1 + v / neg[i]!))] };
    }
  },
  {
    type: 'Commodity Channel Index', short: 'CCI', key: 'cci', pane: 'own', inputs: [int('length', 'Length', 20), src('hlc3')],
    plots: [{ title: 'CCI', color: '#2962FF' }], bands: [100, 0, -100].map((value) => ({ value, color: GREY, style: 2 })), fill: { a: 0, b: 2, color: '#2196F3', alpha: 0x1a, bands: true }, digits: 2,
    calc: (c, inp) => {
      const xs = source(c.bars, inp.source as Source), n = num(inp.length);
      return { values: [sma(xs, n).map((v, i) => {
        if (v === null) return null;
        const dev = xs.slice(i - n + 1, i + 1).reduce((sum, x) => sum + Math.abs(x - v), 0) / n;
        return dev === 0 ? null : (xs[i] - v) / (0.015 * dev);
      })] };
    }
  },
  {
    type: 'Williams %R', short: '%R', key: 'willr', pane: 'own', inputs: [int('length', 'Length', 14), src()],
    plots: [{ title: '%R', color: '#7E57C2' }], ...levels(-20, -80, '#7E57C2', -50), range: [-100, 0],
    calc: (c, inp) => ({ values: [stoch(source(c.bars, inp.source as Source), source(c.bars, 'high'), source(c.bars, 'low'), num(inp.length)).map((v) => v === null ? null : v - 100)] })
  },
  {
    type: 'Parabolic SAR', short: 'SAR', key: 'sar', pane: 'price',
    inputs: [{ id: 'start', label: 'Start', kind: 'float', def: 0.02, min: 0, max: 1 }, { id: 'increment', label: 'Increment', kind: 'float', def: 0.02, min: 0, max: 1 }, { id: 'max', label: 'Max Value', kind: 'float', def: 0.2, min: 0, max: 1 }],
    plots: [{ title: 'ParabolicSAR', color: '#2962FF', kind: 'points', width: 1 }],
    calc: (c, inp) => ({ values: [sar(c.bars, num(inp.start), num(inp.increment), num(inp.max))] })
  },
  { type: 'Funding', short: 'Funding', key: 'funding', pane: 'own', data: 'funding', percent: true, digits: 4, inputs: [pick('live', 'Live value', 'Show', ['Show', 'Hide'])], plots: [{ title: 'Funding', color: '', kind: 'hist', palette: ['#50D2C1', '#ED7088'] }], calc: (c) => ({ values: [c.rates?.funding ?? c.bars.map(() => null)], colors: [c.rates?.funding.map((v) => v === null ? null : v >= 0 ? 0 : 1) ?? []] }) },
  { type: 'Premium', short: 'Premium', key: 'premium', pane: 'own', data: 'premium', percent: true, digits: 4, inputs: [pick('live', 'Live value', 'Show', ['Show', 'Hide'])], plots: [{ title: 'Premium', color: '#2962FF' }], calc: (c) => ({ values: [c.rates?.premium ?? c.bars.map(() => null)] }) },
  { type: 'CVD', short: 'CVD', key: 'cvd', pane: 'own', flow: 'cvd', inputs: [], plots: [{ title: 'CVD', color: '' }], calc: () => ({ values: [] }) },
  { type: 'OI Δ', short: 'OI Δ', key: 'oid', pane: 'own', flow: 'oid', inputs: [], plots: [{ title: 'OI Δ', color: '', kind: 'hist' }], calc: () => ({ values: [] }) }
];
/** No prototype, so a stored type such as "toString" or "__proto__" finds nothing. */
export const DEFS: Record<string, Def> = Object.assign(Object.create(null), Object.fromEntries(LIST.map((d) => [d.type, d])));
export const TYPES = LIST.map((d) => d.type).sort((a, b) => a.localeCompare(b));

export const defaults = (def: Def): Inputs => Object.fromEntries(def.inputs.map((i) => [i.id, i.def]));
export const inputsText = (s: Study) => DEFS[s.type].inputs.map((i) => String(s.inputs[i.id])).join(' ');
/** The name the AI context gets: at most 40 characters, as agent/src/wire.ts accepts. */
export const studyLabel = (s: Study) => `${DEFS[s.type].short.replace('Moving Average ', 'MA ')}${DEFS[s.type].inputs.length ? `(${DEFS[s.type].inputs.map((i) => s.inputs[i.id]).join(',')})` : ''}`.slice(0, 40);
/** A plot's name for an Ask AI selection, at most 20 characters. */
export const plotName = (s: Study, i: number) => {
  const def = DEFS[s.type];
  return (def.name?.(s.inputs, i) ?? (def.plots.length > 1 ? `${def.short} ${def.plots[i].title}` : studyLabel(s))).slice(0, 20);
};

const hexA = (c: string, a = 0xff) => (c.length === 7 && a < 0xff ? c + a.toString(16).padStart(2, '0') : c);
/** A plot's effective style: the study's own settings over Hyperliquid's defaults, colours with their alpha. */
export function plotStyle(s: Study, i: number, theme?: { buy: string; sell: string }) {
  const p = DEFS[s.type].plots[i];
  const o = s.plots?.[i] ?? {};
  return {
    on: o.on ?? true, width: o.width ?? p.width ?? 1, style: o.style ?? p.style ?? 0,
    color: hexA(o.color ?? p.color, p.alpha), palette: (o.palette ?? (DEFS[s.type].data === 'funding' && theme ? [theme.buy, theme.sell] : p.palette))?.map((c) => hexA(c, p.alpha))
  };
}
export const bandStyle = (s: Study, i: number) => ({ on: s.bands?.[i]?.on ?? true, color: s.bands?.[i]?.color ?? DEFS[s.type].bands![i].color });
export const fillStyle = (s: Study) => {
  const f = DEFS[s.type].fill!;
  return { on: s.fill?.on ?? true, color: hexA(s.fill?.color ?? f.color, f.alpha), downColor: f.downColor ? hexA(s.fill?.downColor ?? f.downColor, f.alpha) : undefined };
};

/** A new instance id: the type's key and the next free number, so ids stay stable and readable. */
export function newId(type: string, list: { id: string }[]) {
  const key = DEFS[type].key;
  const used = list.map((s) => s.id.match(new RegExp(`^${key}-(\\d+)$`))?.[1]).filter(Boolean).map(Number);
  return `${key}-${Math.max(0, ...used) + 1}`;
}

export const ownPanes = (list: Study[]) => list.filter((s) => DEFS[s.type]?.pane === 'own').length;

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const ID = /^[a-z0-9]{1,12}-\d{1,4}$/;
export const validInput = (i: Input, v: unknown) =>
  i.kind === 'enum' ? typeof v === 'string' && i.options!.includes(v) : typeof v === 'number' && Number.isFinite(v) && v >= i.min! && v <= i.max! && (i.kind === 'float' || Number.isInteger(v));
const isColor = (c: unknown): c is string => typeof c === 'string' && HEX.test(c);
const has = <T>(ok: boolean, v: T) => (ok ? v : undefined);

function validStyle(def: Def, s: any): Pick<Study, 'plots' | 'bands' | 'fill' | 'hidden'> {
  const out: Pick<Study, 'plots' | 'bands' | 'fill' | 'hidden'> = {};
  if (Array.isArray(s.plots))
    out.plots = def.plots.map((p, i) => {
      const o = s.plots[i] ?? {};
      const pal = has(Array.isArray(o.palette) && o.palette.length === p.palette?.length && o.palette.every(isColor), o.palette as string[]);
      return JSON.parse(JSON.stringify({ on: has(typeof o.on === 'boolean', o.on), color: has(isColor(o.color), o.color), width: has([1, 2, 3, 4].includes(o.width), o.width), style: has([0, 1, 2].includes(o.style), o.style), palette: pal }));
    });
  if (Array.isArray(s.bands) && def.bands) out.bands = def.bands.map((_, i) => JSON.parse(JSON.stringify({ on: has(typeof s.bands[i]?.on === 'boolean', s.bands[i]?.on), color: has(isColor(s.bands[i]?.color), s.bands[i]?.color) })));
  if (s.fill && typeof s.fill === 'object' && def.fill) out.fill = JSON.parse(JSON.stringify({ on: has(typeof s.fill.on === 'boolean', s.fill.on), color: has(isColor(s.fill.color), s.fill.color), downColor: has(isColor(s.fill.downColor), s.fill.downColor) }));
  if (s.hidden === true) out.hidden = true;
  return out;
}

/** Known types with unique ids, one of each flow type, at most MAX_STUDIES and MAX_PANES own panes; an input out of its range takes Hyperliquid's default, a malformed style is dropped. */
export function validStudies(raw: unknown, warn: string[]): Study[] | null {
  if (!Array.isArray(raw)) return warn.push('chart.studies: expected a list, kept current'), null;
  const out: Study[] = [];
  for (const s of raw) {
    const def = DEFS[s?.type];
    const why = !def ? 'unknown type' : typeof s.id !== 'string' || !ID.test(s.id) || out.some((o) => o.id === s.id) ? 'bad or repeated id' : def.flow && out.some((o) => o.type === s.type) ? 'already on the chart' : out.length >= MAX_STUDIES ? `more than ${MAX_STUDIES}` : def.pane === 'own' && ownPanes(out) >= MAX_PANES ? `more than ${MAX_PANES} panes` : '';
    if (why) {
      warn.push(`chart.studies: ${JSON.stringify(s?.type ?? s)} dropped (${why})`);
      continue;
    }
    const inputs = Object.fromEntries(def.inputs.map((i) => [i.id, validInput(i, s.inputs?.[i.id]) ? s.inputs[i.id] : i.def]));
    if (def.inputs.some((i) => s.inputs?.[i.id] !== undefined && inputs[i.id] !== s.inputs[i.id])) warn.push(`chart.studies.${s.id}: an input out of range took its default`);
    out.push({ id: s.id, type: s.type, inputs, ...validStyle(def, s) });
  }
  return out;
}

type Old = { on: boolean; n?: number };
export const OLD: Record<string, Old> = { ema1: { on: false, n: 9 }, ema2: { on: false, n: 21 }, sma1: { on: true, n: 7 }, sma2: { on: true, n: 30 }, sma3: { on: true, n: 99 }, rsi: { on: false, n: 14 }, vwap: { on: false }, cvd: { on: false }, oid: { on: false } };

/** The studies a former chart.indicators blob showed: MA 7/30/99 as one Triple MA, EMA 9/21 as one Double (Exponential), RSI, VWAP, CVD and OI Δ, each only if it was on. */
export function fromIndicators(raw: Record<string, any>): Study[] {
  const old = Object.fromEntries(Object.entries(OLD).map(([k, d]) => {
    const r = raw[k] && typeof raw[k] === 'object' ? raw[k] : {};
    return [k, { on: typeof r.on === 'boolean' ? r.on : d.on, n: Number.isInteger(r.n) && r.n >= 2 && r.n <= 500 ? r.n : d.n }];
  })) as Record<string, Old>;
  const out: Study[] = [];
  const add = (type: string, inputs: Inputs, plots?: PlotStyle[]) => out.push({ id: newId(type, out), type, inputs: { ...defaults(DEFS[type]), ...inputs }, ...(plots && { plots }) });
  const group = (keys: string[], type: string, method: string) =>
    keys.some((k) => old[k].on) && add(type, { ...Object.fromEntries(keys.map((k, i) => [ORDER[i], old[k].n!])), method }, keys.map((k) => ({ on: old[k].on })));
  group(['sma1', 'sma2', 'sma3'], 'Moving Average Triple', 'Simple');
  group(['ema1', 'ema2'], 'Moving Average Double', 'Exponential');
  if (old.rsi.on) add('Relative Strength Index', { length: old.rsi.n! });
  if (old.vwap.on) add('VWAP', {});
  if (old.cvd.on) add('CVD', {});
  if (old.oid.on) add('OI Δ', {});
  return out;
}

/** The default chart: Triple MA 7/30/99, the former MA periods, in Hyperliquid's colours. */
export const DEFAULT_STUDIES: Study[] = [{ id: 'ma3-1', type: 'Moving Average Triple', inputs: { first: 7, second: 30, third: 99, method: 'Simple' } }];
