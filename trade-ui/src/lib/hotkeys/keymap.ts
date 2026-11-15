import { settings, type Binding } from '$lib/settings/settings.svelte';
import { INTERVALS, ivLabel } from '$lib/market/candles';
import type { Side } from '$lib/ui/toast.svelte';

export type Gate = 'A' | 'R' | 'X';
export type Group = 'Navigation' | 'Risk-reducing' | 'Execution' | 'Chart';
export type ActionId =
  | 'help' | 'settings' | 'arm' | 'picker' | 'prevFav' | 'nextFav' | 'starFav'
  | 'sizeDown' | 'sizeUp' | 'focusSize' | 'reduceToggle' | 'escape'
  | 'placeTicket'
  | 'cancelMarket' | 'cancelBuys' | 'cancelSells' | 'cancelLast' | 'cancelAll' | 'positionTp' | 'positionSl' | 'close' | 'closeAll' | 'flatten'
  | 'buyMkt' | 'sellMkt' | 'bidAlo' | 'askAlo' | 'chaseBuy' | 'chaseSell' | 'scaleBuy' | 'scaleSell' | 'closeLimit' | 'closeAllAlo'
  | 'chartUp' | 'chartDown' | 'chartReset' | 'chartBack' | 'chartForward' | 'chartZoomIn' | 'chartZoomOut' | 'chartZoomInBoth' | 'chartZoomOutBoth' | 'indicators' | 'chartLog' | 'chartPercent' | 'chartInvert' | 'zen' | 'toggleOrder' | 'togglePositions' | 'toggleBook' | 'cycleAccount'
  | 'drawH' | 'drawV' | 'drawTrend' | 'drawFib' | 'askAi' | 'toggleFills'
  | 'interval1' | 'interval2' | 'interval3' | 'interval4' | 'interval5' | 'interval6' | 'interval7' | 'interval8';
export interface ActionDef { id: ActionId; label: string; group: Group; gate: Gate; double?: boolean; fixed?: boolean; keys: Binding[] }

const k = (code: string, shift = false): Binding => ({ code, shift });
const alt = (code: string): Binding => ({ code, shift: false, alt: true });
const nav = (id: ActionId, label: string, keys: Binding[], fixed = false): ActionDef => ({ id, label, group: 'Navigation', gate: 'A', keys, fixed });
const risk = (id: ActionId, label: string, keys: Binding[], double = false): ActionDef => ({ id, label, group: 'Risk-reducing', gate: 'R', keys, double });
const exec = (id: ActionId, label: string, keys: Binding[]): ActionDef => ({ id, label, group: 'Execution', gate: 'X', keys });
const chart = (id: ActionId, label: string, keys: Binding[]): ActionDef => ({ id, label, group: 'Chart', gate: 'A', keys });

/** The side each order key trades or cancels. */
export const SIDE: Partial<Record<ActionId, Side>> = { buyMkt: 'buy', sellMkt: 'sell', bidAlo: 'buy', askAlo: 'sell', chaseBuy: 'buy', chaseSell: 'sell', scaleBuy: 'buy', scaleSell: 'sell', cancelBuys: 'buy', cancelSells: 'sell' };

export const GROUPS: Group[] = ['Navigation', 'Risk-reducing', 'Execution', 'Chart'];
export const ACTIONS: ActionDef[] = [
  nav('help', 'Help (this list)', [k('Slash', true)], true),
  nav('arm', 'Arm / disarm', [k('Backquote')]),
  nav('picker', 'Market picker', [k('Slash')]),
  nav('prevFav', 'Previous favourite', [k('BracketLeft', true)]),
  nav('nextFav', 'Next favourite', [k('BracketRight', true)]),
  nav('starFav', 'Star / unstar this market', [alt('KeyW')]),
  nav('sizeDown', 'Size − step', [k('Minus')]),
  nav('sizeUp', 'Size + step', [k('Equal')]),
  nav('focusSize', 'Focus size input', [k('KeyF')]),
  nav('reduceToggle', 'Toggle reduce-only', [k('KeyR')]),
  nav('escape', 'Close overlay / exit zen / blur', [k('Escape')], true),
  risk('cancelMarket', 'Cancel orders on this market (keeps TP/SL)', [k('KeyX')]),
  risk('cancelLast', 'Cancel last placement here', [k('KeyZ')]),
  risk('cancelAll', 'Cancel all orders, every market', [k('KeyX', true)], true),
  risk('close', 'Close position at market', [k('KeyC')]),
  risk('closeAll', 'Close all positions at market', [alt('KeyC')]),
  risk('flatten', 'Flatten all (close, then cancel)', [k('KeyF', true)], true),
  exec('buyMkt', 'Market buy (TP/SL if on)', [k('KeyB')]),
  exec('sellMkt', 'Market sell (TP/SL if on)', [k('KeyS')]),
  exec('bidAlo', 'ALO at best bid (TP/SL if on)', [k('KeyB', true)]),
  exec('askAlo', 'ALO at best ask (TP/SL if on)', [k('KeyS', true)]),
  exec('chaseBuy', 'Chase buy', [k('KeyQ')]),
  exec('chaseSell', 'Chase sell', [k('KeyW')]),
  exec('scaleBuy', 'Scale below bid', [k('KeyQ', true)]),
  exec('scaleSell', 'Scale above ask', [k('KeyW', true)]),
  exec('closeLimit', 'Close with limit (or chase)', [k('KeyC', true)]),
  exec('closeAllAlo', 'Close all positions with ALO at best', [{ code: 'KeyC', shift: true, alt: true }]),
  exec('placeTicket', 'Place ticket (as staged)', [k('Enter')]),
  chart('chartReset', 'Reset chart (auto-scale, ⅓ blank space)', [alt('KeyR')]),
  chart('chartBack', 'Scroll back', [k('ArrowLeft'), k('KeyH')]),
  chart('chartForward', 'Scroll forward', [k('ArrowRight'), k('KeyL')]),
  chart('chartUp', 'Pan chart up (Vim k)', [k('KeyK')]),
  chart('chartDown', 'Pan chart down (Vim j)', [k('KeyJ')]),
  chart('chartZoomIn', 'Zoom in', [k('ArrowUp'), k('Equal', true)]),
  chart('chartZoomOut', 'Zoom out', [k('ArrowDown'), k('Minus', true)]),
  ...INTERVALS.map((iv, i) => chart(`interval${i + 1}` as ActionId, `Interval ${ivLabel(iv)}`, [alt(`Digit${i + 1}`)])),
  // Ahead of Invert, so a user who had bound Indicators to Alt+I keeps it (dropShadowed unbinds Invert).
  chart('indicators', 'Indicators menu', [alt('Slash')]),
  chart('chartLog', 'Log scale', [alt('KeyL')]),
  chart('chartPercent', 'Percent scale', [alt('KeyP')]),
  chart('chartInvert', 'Invert scale', [alt('KeyI')]),
  chart('zen', 'Zen mode (chart only)', [k('F8')]),
  chart('drawH', 'Horizontal line', [alt('KeyH')]),
  chart('drawV', 'Vertical line', [alt('KeyV')]),
  chart('drawTrend', 'Trend line', [alt('KeyT')]),
  // Alt+F is the browser menu, so fib has no default key.
  chart('drawFib', 'Fib retracement', []),
  // Last, so a user who had already bound Alt+B or Alt+S keeps it (dropShadowed unbinds these instead).
  risk('cancelBuys', 'Cancel buy orders on this market (keeps TP/SL)', [alt('KeyB')]),
  risk('cancelSells', 'Cancel sell orders on this market (keeps TP/SL)', [alt('KeyS')]),
  nav('settings', 'Settings', [alt('Comma')]),
  // Last, so a user who had bound Alt+O, Alt+A or Alt+K keeps it; Alt+P is Percent scale, so positions take Alt+A.
  chart('toggleOrder', 'Zen: show / hide the order panel', [alt('KeyO')]),
  chart('togglePositions', 'Zen: show / hide positions', [alt('KeyA')]),
  chart('toggleBook', 'Zen: show / hide the order book', [alt('KeyK')]),
  // Alt+A is the zen Positions toggle; last, so a user who had bound Alt+U keeps it.
  nav('cycleAccount', 'Next account', [alt('KeyU')]),
  // Last, so a user who had bound Alt+Q keeps it.
  chart('askAi', 'Ask AI about a chart point or zone', [alt('KeyQ')]),
  // Last, so a user who had bound T or Shift+T keeps it. They only open the TP/SL dialog, which places nothing until confirmed.
  { id: 'positionTp', label: 'TP for this position (full size, price you type)', group: 'Risk-reducing', gate: 'A', keys: [k('KeyT')] },
  { id: 'positionSl', label: 'SL for this position (full size, price you type)', group: 'Risk-reducing', gate: 'A', keys: [k('KeyT', true)] },
  chart('toggleFills', 'Show / hide buy/sell markers', [alt('KeyM')]),
  chart('chartZoomInBoth', 'Zoom time and price in', [{ code: 'Equal', shift: true, alt: true }]),
  chart('chartZoomOutBoth', 'Zoom time and price out', [{ code: 'Minus', shift: true, alt: true }])
];

const byId = new Map(ACTIONS.map((a) => [a.id, a]));
export const sameKey = (a: Binding, b: Binding) => a.code === b.code && a.shift === b.shift && !!a.alt === !!b.alt;
export const bindingsFor = (id: ActionId): Binding[] => (byId.get(id)?.fixed ? byId.get(id)!.keys : (settings.bindings[id] ?? byId.get(id)!.keys));
export const lookup = (code: string, shift: boolean, alt = false) => ACTIONS.find((a) => bindingsFor(a.id).some((b) => sameKey(b, { code, shift, alt })));

const NAMES: Record<string, string> = {
  Backquote: '`', Slash: '/', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Backslash: '\\', Escape: 'Esc', Space: 'Space', Enter: 'Enter', Tab: 'Tab',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓'
};
const SHIFTED: Record<string, string> = { Slash: '?', BracketLeft: '{', BracketRight: '}' };

export function keyLabel(b: Binding): string {
  const alt = b.alt ? 'Alt+' : '';
  if (b.shift && SHIFTED[b.code]) return alt + SHIFTED[b.code];
  const base = NAMES[b.code] ?? (/^F\d+$/.test(b.code) ? b.code : b.code.replace(/^Key|^Digit/, '').toLowerCase());
  const mods = alt + (b.shift ? 'Shift+' : '');
  return mods ? mods + (base.length === 1 ? base.toUpperCase() : base) : base;
}

export type Capture = { binding: Binding; warning?: string } | { error: string };

const RESERVED_WITH_MOD = new Set(['KeyW', 'KeyT', 'KeyN', 'KeyR', 'KeyL', 'Tab']);
const RESERVED_BARE = new Set(['F5', 'F11', 'F12', 'Tab']);
// Alt+←/→ go back/forward, Alt+D/E/F reach the address bar and menu, Alt+F4 closes, Alt+Space opens the window menu.
const RESERVED_ALT = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'KeyD', 'KeyE', 'KeyF', 'F4', 'Space', 'Escape']);
export const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^CapsLock$/;

export function checkCapture(e: KeyboardEvent): Capture {
  const binding: Binding = e.altKey ? { code: e.code, shift: e.shiftKey, alt: true } : { code: e.code, shift: e.shiftKey };
  const name = keyLabel(binding);
  if (e.ctrlKey || e.metaKey) {
    const mod = e.ctrlKey ? 'Ctrl' : 'Cmd';
    if (RESERVED_WITH_MOD.has(e.code)) return { error: `${mod}+${name} is reserved by the browser` };
    return { error: `${mod} combinations are ignored by the hotkey listener` };
  }
  if (RESERVED_BARE.has(e.code) || (e.code === 'Escape' && e.shiftKey) || (e.altKey && RESERVED_ALT.has(e.code))) return { error: `${name} is reserved by the browser` };
  if (e.code === 'Escape') return { error: 'Esc closes overlays and cannot be rebound' };
  if (MODIFIER_CODES.test(e.code)) return { error: 'press a key, not just a modifier' };
  if (/^F\d+$/.test(e.code) || ['Quote', 'Space', 'Enter'].includes(e.code))
    return { binding, warning: `${name} may clash with the browser or page scrolling` };
  return { binding };
}

/** Forgets bindings of removed actions and unbinds keys that a fixed or earlier action already holds, since lookup would never reach them; returns the labels it unbound. */
export function dropShadowed(): string[] {
  for (const id of Object.keys(settings.bindings)) if (!byId.has(id as ActionId)) delete settings.bindings[id];
  const seen = ACTIONS.filter((a) => a.fixed).flatMap((a) => a.keys);
  const dropped: string[] = [];
  for (const a of ACTIONS.filter((x) => !x.fixed)) {
    const keys = bindingsFor(a.id);
    const keep = keys.filter((b) => !seen.some((s) => sameKey(s, b)));
    if (keep.length < keys.length) (settings.bindings[a.id] = keep), dropped.push(a.label);
    seen.push(...keep);
  }
  return dropped;
}
