import { load, save } from '$lib/util/storage';
import { ALL_INTERVALS, INTERVALS, type Interval } from '$lib/market/candles';
import { FS_RANGE, SETTINGS_KEY, THEMES, type ThemeId } from './themes';
import { DEFAULT_STUDIES, DEFS, OLD, fromIndicators, validStudies, type Study } from '$lib/market/studies';

export const MAX_QUICK = 10;

export type SizeUnit = 'coin' | 'usd' | 'pct';
/** A coin size names its coin, so a hotkey never sends it on another market. */
export interface Sizing { value: number; unit: SizeUnit; basis: 'balance' | 'position'; coin?: string }
export type HotkeyType = 'market' | 'alo' | 'chase' | 'scale';
export const HOTKEY_TYPES: HotkeyType[] = ['market', 'alo', 'chase', 'scale'];
export interface Binding { code: string; shift: boolean; alt?: boolean }
/** Sizes in px; phone is the mobile chart height. Zero keeps automatic heights; the tall* sizes are a tall portrait screen's own. */
export interface Layout { book: number; panel: number; bottom: number; sidebarTrade: number; phone: number; tallBook: number; tallPanel: number; tallMid: number; tallBottom: number }
export type PhoneTab = 'market' | 'trade' | 'account';
export const TICKET_KINDS = ['market', 'limit', 'scale', 'chase', 'stopLimit', 'stopMarket', 'takeLimit', 'takeMarket'] as const;
type TicketKind = (typeof TICKET_KINDS)[number];
export interface ZenOpen { order: boolean; positions: boolean; book: boolean }
export interface Settings {
  sizeStep: number;
  hotkeySizes: Record<HotkeyType, Sizing>;
  market: { slippage: number };
  chase: { capPct: number; timeoutSec: number; onStop: 'rest' | 'market'; throttleMs: number };
  scale: { count: number; rangePct: number; offsetPct: number; skew: number; shape: 'linear' | 'exp' };
  tpsl: { slippage: number };
  closeMode: 'limit' | 'chase';
  idleMin: number;
  bindings: Record<string, Binding[]>;
  book: { bins: Record<string, number>; sizeUnit: 'coin' | 'usd' };
  favourites: string[];
  superstars: string[];
  /** Set once the quick-switch bar holds ★★ markets only; before it, ★ markets filled its free slots. */
  barSplit: boolean;
  /** HIP-3 dexes whose "deployed independently" banner was dismissed. */
  dismissedDexes: string[];
  /** indicators: the display layers; studies: the chart's indicators in legend and pane order; favStudies: the Indicators dialog's starred types. */
  chart: { interval: Interval; pinnedIntervals: Interval[]; desktopPinnedIntervals: Interval[]; volume: boolean; timezone: string; indicators: { positions: { on: boolean }; fills: { on: boolean }; drawings: { on: boolean }; ai: { on: boolean } }; studies: Study[]; favStudies: string[]; compare: Record<string, string[]>; panes: { coin: string; interval: Interval }[] };
  panel: { kind: TicketKind; sizeUnit: 'coin' | 'usd' };
  display: { minimized: { trade: boolean; account: boolean; book: boolean; positions: boolean }; theme: ThemeId; fs: number; phoneTab: PhoneTab; zen: boolean; zenOpen: ZenOpen; superstar: boolean; lol: boolean; layout: Layout };
}

export const BOOK_MIN = 180, PANEL_MIN = 320;
// The former default active preset, which every hotkey sized from before each had its own size.
const OLD_DEFAULT: Sizing = { value: 100, unit: 'usd', basis: 'balance' };

export const DEFAULTS: Settings = {
  sizeStep: 0.1,
  hotkeySizes: { market: { ...OLD_DEFAULT }, alo: { ...OLD_DEFAULT }, chase: { ...OLD_DEFAULT }, scale: { ...OLD_DEFAULT } },
  market: { slippage: 0.01 },
  chase: { capPct: 0.5, timeoutSec: 0, onStop: 'rest', throttleMs: 2000 },
  scale: { count: 5, rangePct: 1, offsetPct: 0.1, skew: 1, shape: 'linear' },
  tpsl: { slippage: 0.1 },
  closeMode: 'limit',
  idleMin: 10,
  bindings: {},
  book: { bins: {}, sizeUnit: 'coin' },
  favourites: ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE'],
  superstars: ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE'],
  barSplit: true,
  dismissedDexes: [],
  chart: { interval: '15m', pinnedIntervals: [], desktopPinnedIntervals: [...INTERVALS], volume: true, timezone: 'UTC', indicators: { positions: { on: true }, fills: { on: true }, drawings: { on: true }, ai: { on: true } }, studies: DEFAULT_STUDIES, favStudies: [], compare: {}, panes: [] },
  panel: { kind: 'market', sizeUnit: 'coin' },
  display: { minimized: { trade: false, account: false, book: false, positions: false }, theme: THEMES[0].id, fs: 14, phoneTab: 'trade', zen: false, zenOpen: { order: false, positions: false, book: false }, superstar: false, lol: false, layout: { book: 240, panel: PANEL_MIN, bottom: 0, sidebarTrade: 0, phone: 0, tallBook: 0, tallPanel: 0, tallMid: 0, tallBottom: 0 } }
};

const KEY = SETTINGS_KEY;
const clone = <T>(v: T): T => structuredClone(v);
// Enum leaves, keyed by the last path segment.
const ENUMS: Record<string, string[]> = {
  interval: ALL_INTERVALS, unit: ['coin', 'usd', 'pct'], basis: ['balance', 'position'], closeMode: ['limit', 'chase'], shape: ['linear', 'exp'], onStop: ['rest', 'market'],
  theme: THEMES.map((t) => t.id), kind: [...TICKET_KINDS], sizeUnit: ['coin', 'usd'], phoneTab: ['market', 'trade', 'account']
};
// [min, max] per numeric leaf in stored units (fractions, not %); the Settings panel reads its input bounds from it.
export const RANGES: Record<string, [number, number]> = {
  ...Object.fromEntries(HOTKEY_TYPES.map((t): [string, [number, number]] => [`hotkeySizes.${t}.value`, [0, Infinity]])), sizeStep: [0.01, 1], 'market.slippage': [0.0001, 0.1],
  'chase.capPct': [0.01, 10], 'chase.timeoutSec': [0, Infinity], 'chase.throttleMs': [500, Infinity],
  'scale.count': [2, 50], 'scale.rangePct': [0.01, Infinity], 'scale.offsetPct': [0, Infinity], 'scale.skew': [0.1, Infinity],
  'tpsl.slippage': [0.001, 0.5],
  idleMin: [1, 120], 'display.fs': [...FS_RANGE],
  'display.layout.book': [BOOK_MIN, Infinity], 'display.layout.panel': [PANEL_MIN, Infinity], 'display.layout.bottom': [0, Infinity], 'display.layout.sidebarTrade': [0, Infinity], 'display.layout.phone': [0, Infinity], 'display.layout.tallBook': [0, Infinity], 'display.layout.tallPanel': [0, Infinity], 'display.layout.tallMid': [0, Infinity], 'display.layout.tallBottom': [0, Infinity]
};
const INTEGERS = ['scale.count', 'display.fs', 'display.layout.book', 'display.layout.panel', 'display.layout.bottom', 'display.layout.sidebarTrade', 'display.layout.phone', 'display.layout.tallBook', 'display.layout.tallPanel', 'display.layout.tallMid', 'display.layout.tallBottom'];
export const validNum = (path: string, v: unknown) => {
  const [min, max] = RANGES[path] ?? [-Infinity, Infinity];
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!INTEGERS.includes(path) || Number.isInteger(v));
};

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (value === 'local') return true;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function validPins(raw: unknown[], limit: number) {
  return [...new Set(raw.filter((coin): coin is string => typeof coin === 'string' && coin.length > 0 && coin.length <= 100))].slice(0, limit);
}

/** Keep a stored leaf only when it has the default's type (and an allowed value for enums); records (bindings) pass through when shaped right. */
function merge(def: any, raw: any, path: string, warn: string[]): any {
  if (raw === undefined) return clone(def);
  if (path === 'superstars') {
    if (!Array.isArray(raw)) return warn.push('superstars: expected a list'), clone(def);
    return validPins(raw, MAX_QUICK);
  }
  if (path === 'chart.studies') return validStudies(raw, warn) ?? clone(def);
  if (path === 'chart.pinnedIntervals' || path === 'chart.desktopPinnedIntervals') {
    if (!Array.isArray(raw)) return warn.push(`${path}: expected a list, kept current`), clone(def);
    const selected = new Set(raw);
    const supported = ALL_INTERVALS.filter((i) => selected.has(i));
    const valid = path === 'chart.pinnedIntervals' ? supported.slice(0, 9) : supported;
    if (valid.length !== raw.length) warn.push(`${path}: kept ${path === 'chart.pinnedIntervals' ? 'up to nine ' : ''}distinct supported timeframes`);
    return valid;
  }
  if (path === 'chart.favStudies') return Array.isArray(raw) ? [...new Set(raw.filter((t) => typeof t === 'string' && DEFS[t]))] : (warn.push(`${path}: expected a list, kept current`), clone(def));
  if (path === 'chart.panes') return Array.isArray(raw) ? raw.filter((p) => isCoin(p?.coin) && ALL_INTERVALS.includes(p?.interval)).slice(0, MAX_PANES).map((p) => ({ coin: p.coin, interval: p.interval })) : (warn.push(`${path}: expected a list, kept current`), clone(def));
  if (Array.isArray(def)) {
    if (Array.isArray(raw) && raw.every((x) => typeof x === typeof (def[0] ?? ''))) return raw.map((x: any) => (typeof x === 'object' && def[0] ? merge(def[0], x, path, warn) : x));
    warn.push(`${path}: expected a list, kept current`);
    return clone(def);
  }
  if (def && typeof def === 'object') {
    if (!raw || typeof raw !== 'object') return warn.push(`${path}: expected an object, kept current`), clone(def);
    if (path === 'bindings') return validBindings(raw, warn);
    if (path === 'book.bins') return validBins(raw, warn);
    if (path === 'chart.compare') return validCompare(raw, warn);
    if (path === 'hotkeySizes') return validHotkeySizes(def, raw, warn);
    return Object.fromEntries(Object.keys(def).map((k) => [k, merge(def[k], raw[k], `${path ? path + '.' : ''}${k}`, warn)]));
  }
  if (path === 'chart.timezone' && !validTimezone(raw)) return warn.push('chart.timezone: invalid timezone, kept current'), def;
  const allowed = ENUMS[path.split('.').pop()!];
  if (typeof raw === typeof def && (typeof raw !== 'number' || validNum(path, raw)) && (!allowed || allowed.includes(raw))) return raw;
  warn.push(`${path}: invalid value ${JSON.stringify(raw)}, kept current`);
  return def;
}

// Keys checkCapture (hotkeys/keymap.ts) refuses; repeated here because keymap imports this module.
const UNBINDABLE = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|F5|F11|F12|Tab|Escape)$/;

function validBindings(raw: Record<string, unknown>, warn: string[]): Record<string, Binding[]> {
  const out: Record<string, Binding[]> = {};
  for (const [id, list] of Object.entries(raw)) {
    const ok = Array.isArray(list) && list.every((b: any) => typeof b?.code === 'string' && typeof b?.shift === 'boolean' && (b.alt === undefined || typeof b.alt === 'boolean'));
    if (!ok) {
      warn.push(`bindings.${id}: malformed, dropped`);
      continue;
    }
    out[id] = (list as Binding[]).filter((b) => !UNBINDABLE.test(b.code));
    if (out[id].length < list.length) warn.push(`bindings.${id}: reserved or modifier-only key dropped`);
  }
  return out;
}

/** Coin → bin step; a step the coin no longer offers is caught later by pickBin. */
function validBins(raw: Record<string, unknown>, warn: string[]): Record<string, number> {
  const ok = Object.entries(raw).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (ok.length < Object.keys(raw).length) warn.push('book.bins: a step that is not a positive number was dropped');
  return Object.fromEntries(ok) as Record<string, number>;
}

const sizingOf = (v: any): Sizing | null =>
  validNum('hotkeySizes.market.value', v?.value) && ENUMS.unit.includes(v.unit) && ENUMS.basis.includes(v.basis) && (v.unit !== 'coin' || isCoin(v.coin))
    ? { value: v.value, unit: v.unit, basis: v.basis, ...(v.unit === 'coin' && { coin: v.coin }) }
    : null;

/** Each hotkey type keeps a valid size of its own; anything else keeps the current one. */
function validHotkeySizes(def: Settings['hotkeySizes'], raw: Record<string, any>, warn: string[]): Settings['hotkeySizes'] {
  const one = (t: HotkeyType): Sizing => {
    if (raw[t] === undefined) return clone(def[t]);
    const ok = sizingOf(raw[t]);
    if (!ok) warn.push(`hotkeySizes.${t}: invalid, kept current`);
    return ok ?? clone(def[t]);
  };
  return Object.fromEntries(HOTKEY_TYPES.map((t) => [t, one(t)])) as Settings['hotkeySizes'];
}

/** Settings saved with size presets: a hotkey type with no size of its own, or one on 'preset', takes the active preset's size (a coin size binds to the last market). */
function fromPresets(raw: any): any {
  if (!Array.isArray(raw?.presets)) return raw;
  const coin = load<unknown>('trade-ui:coin', 'BTC');
  const size = [raw.presets[raw.activePreset], raw.presets[0]].map((p) => sizingOf(p?.unit === 'coin' ? { ...p, coin } : p)).find(Boolean);
  const own = raw.hotkeySizes && typeof raw.hotkeySizes === 'object' ? raw.hotkeySizes : {};
  const take = (t: HotkeyType) => (own[t] === undefined || own[t] === 'preset' ? (size ?? OLD_DEFAULT) : own[t]);
  return { ...raw, hotkeySizes: Object.fromEntries(HOTKEY_TYPES.map((t) => [t, take(t)])) };
}

/** Settings saved before chart.studies: the old indicator toggles and periods become studies. chart.indicators alone may hold only today's layers, which keeps the studies. */
function fromIndicatorKeys(raw: any): any {
  const old = raw?.chart?.indicators;
  if (!old || typeof old !== 'object' || raw.chart.studies !== undefined || !Object.keys(old).some((k) => Object.hasOwn(OLD, k))) return raw;
  return { ...raw, chart: { ...raw.chart, studies: fromIndicators(old) } };
}
/** Settings saved while ★ markets filled the bar keep the bar they showed: those fillers become ★★ once. */
function splitBar(raw: any) {
  if (!raw || typeof raw !== 'object' || raw.barSplit !== undefined) return raw;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return { ...raw, barSplit: true, superstars: validPins([...list(raw.superstars), ...list(raw.favourites ?? DEFAULTS.favourites)], 5) };
}
const upgrade = (raw: any) => splitBar(fromIndicatorKeys(fromPresets(raw)));

export const MAX_COMPARE = 5;
/** Extra charts beside the main one. */
export const MAX_PANES = 3;
const isCoin = (c: unknown): c is string => typeof c === 'string' && /^[\w:.@/-]{1,40}$/.test(c);

/** Main coin → compared coins: distinct coin names other than the main one, at most MAX_COMPARE. */
function validCompare(raw: Record<string, unknown>, warn: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [main, list] of Object.entries(raw)) {
    const ok = isCoin(main) && Array.isArray(list) ? [...new Set(list.filter((c) => isCoin(c) && c !== main))].slice(0, MAX_COMPARE) : [];
    if (ok.length) out[main] = ok;
    if (!Array.isArray(list) || ok.length < list.length) warn.push(`chart.compare.${main}: invalid or extra coins dropped`);
  }
  return out;
}

const stored = load<any>(KEY, undefined);
const initial = merge(DEFAULTS, upgrade(stored), '', []) as Settings;
// An unknown stored order type opens on Limit, not the Market default, so one click can't send a market order.
if (stored?.panel?.kind !== undefined && initial.panel.kind !== stored.panel.kind) initial.panel.kind = 'limit';
// The former defaults (320/340) were never a choice, so they open at the new minimum widths.
if (initial.display.layout.book === 320 && initial.display.layout.panel === 340) Object.assign(initial.display.layout, { book: DEFAULTS.display.layout.book, panel: PANEL_MIN });
// The phone tabs replaced the collapsible phone chart; a chart left open becomes the Market tab.
if (stored?.display?.phoneTab === undefined && stored?.display?.mobileChart === true) initial.display.phoneTab = 'market';
export const settings = $state<Settings>(initial);

/** Puts every invalid numeric leaf back to its last saved value, so money code never reads null, NaN or an out-of-range number. */
function sanitise(cur: any, prev: any, path: string, bad: string[]) {
  for (const k of Object.keys(cur)) {
    const p = Array.isArray(cur) ? path : path ? `${path}.${k}` : k;
    if (cur[k] && typeof cur[k] === 'object') {
      if (p !== 'bindings') sanitise(cur[k], prev?.[k], p, bad);
    } else if (typeof prev?.[k] === 'number' && !validNum(p, cur[k])) {
      bad.push(p);
      cur[k] = prev[k];
    }
  }
}

let saved = $state.snapshot(settings) as Settings;

type Sizes = Pick<Settings, 'hotkeySizes' | 'sizeStep'>;
// Each connected master's own sizes. KEY's top-level sizes are the global ones: used with no wallet, and copied to an account with none of its own.
const SIZES_KEY = 'trade-ui:accountSizes';
const sizesOf = (s: Sizes): Sizes => $state.snapshot({ hotkeySizes: s.hotkeySizes, sizeStep: s.sizeStep }) as Sizes;
let globalSizes = sizesOf(settings);
let owner: string | null = null;

/** Master → its sizes; an entry that is not an address's sizes is dropped, and an invalid leaf takes the size `base` gives that account. */
function validAccounts(raw: unknown, base: (a: string) => Sizes, warn: string[] = []): Record<string, Sizes> {
  if (!raw || typeof raw !== 'object') return {};
  const ok = Object.entries(raw).filter(([a, v]) => /^0x[0-9a-f]{40}$/i.test(a) && v && typeof v === 'object');
  if (ok.length < Object.keys(raw).length) warn.push("accountSizes: an entry that is not an address's sizes was dropped");
  return Object.fromEntries(ok.map(([a, v]) => {
    const w: string[] = [];
    const sizes = merge(base(a.toLowerCase()), v, '', w);
    warn.push(...w.map((m) => `accountSizes.${a}.${m}`));
    return [a.toLowerCase(), sizes];
  }));
}
const accounts = () => validAccounts(load(SIZES_KEY, null), () => globalSizes);
/** Re-reads the saved accounts and changes only this one's, so tabs on other accounts keep theirs. */
function saveEntry(master: string, sizes: Sizes | null) {
  const all = accounts();
  if (sizes) all[master] = sizes;
  else delete all[master];
  save(SIZES_KEY, all);
}

/** The connected master's own sizes, or a copy of the global ones for an account with none; with no wallet (or watch-only) the global ones. */
export function useSizes(master: string | null) {
  const next = master?.toLowerCase() ?? null;
  if (next === owner) return;
  // A size typed (not yet saved) while Settings is open stays with the account it was typed for.
  if (JSON.stringify(sizesOf(settings)) !== JSON.stringify(sizesOf(saved))) persist();
  owner = next;
  const own = owner && accounts()[owner];
  Object.assign(settings, clone(own || globalSizes));
  if (owner && !own) saveEntry(owner, sizesOf(settings));
  Object.assign(saved, sizesOf(settings));
}
export const forgetSizes = (master: string) => saveEntry(master.toLowerCase(), null);

/** Another tab saved: take its settings and this account's sizes when that tab changed them, so this tab neither trades on stale sizes nor writes them back. An entry another tab removed keeps this tab's sizes, and its next save writes them back. */
globalThis.addEventListener?.('storage', (e) => {
  if (!e.newValue || (e.key !== KEY && e.key !== SIZES_KEY)) return;
  const live = sizesOf(settings), kept = sizesOf(saved);
  if (e.key === KEY) {
    Object.assign(settings, merge(DEFAULTS, upgrade(load(KEY, undefined)), '', []));
    globalSizes = sizesOf(settings);
  }
  const entry = owner && e.key === SIZES_KEY && accounts()[owner];
  const own = entry && JSON.stringify(sizesOf(entry)) !== JSON.stringify(kept) && entry;
  Object.assign(settings, clone(own || (owner ? live : globalSizes)));
  saved = $state.snapshot(settings) as Settings;
  // Live sizes kept for this account stay unsaved, so a switch still writes what was typed for it.
  if (owner && !own) Object.assign(saved, kept);
});

/** Saves the settings and returns the paths it refused (each reverted to its last saved value). */
export function persist(): string[] {
  const bad: string[] = [];
  sanitise(settings, saved, '', bad);
  saved = $state.snapshot(settings) as Settings;
  if (owner) saveEntry(owner, sizesOf(saved));
  else globalSizes = sizesOf(saved);
  save(KEY, { ...saved, ...globalSizes });
  return bad;
}
export const exportJson = () =>
  JSON.stringify({ ...$state.snapshot(settings), ...globalSizes, accountSizes: { ...accounts(), ...(owner ? { [owner]: sizesOf(settings) } : {}) } }, null, 2);

/** The file's top-level sizes become the global ones. Its accountSizes, if any, replace every saved account's (an invalid leaf keeps that account's size); without them each account keeps its own. */
export function importJson(text: string): string[] {
  const warn: string[] = [];
  const raw = upgrade(JSON.parse(text));
  const live = sizesOf(settings);
  const next = merge({ ...saved, ...globalSizes }, raw, '', warn) as Settings;
  const file = raw?.accountSizes;
  const has = !!file && typeof file === 'object' && !Array.isArray(file);
  if (file !== undefined && !has) warn.push('accountSizes: expected an object, kept current');
  if (has) {
    const cur = { ...accounts(), ...(owner ? { [owner]: live } : {}) };
    save(SIZES_KEY, validAccounts(file, (a) => cur[a] ?? sizesOf(next), warn));
  }
  globalSizes = sizesOf(next);
  const own = owner && (has ? accounts()[owner] : live);
  Object.assign(settings, next, clone(own || globalSizes));
  persist();
  return warn;
}

/** Resets the global sizes and forgets every account's; the connected one starts from the defaults. */
export function resetSettings() {
  Object.assign(settings, clone(DEFAULTS));
  globalSizes = sizesOf(DEFAULTS);
  save(SIZES_KEY, {});
  persist();
}
