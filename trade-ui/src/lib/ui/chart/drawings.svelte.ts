import { load, save } from '$lib/util/storage';
import { meta } from '$lib/market/meta.svelte';
import { settings } from '$lib/settings/settings.svelte';
import { fmtPx } from '$lib/util/format';
import { fibLevels, segDist } from './geometry';
import type { Colors, View } from './tools.svelte';

export type Tool = 'h' | 'v' | 'trend' | 'fib';
export interface Pt { t: number; p: number }
export interface Drawing { id: string; kind: Tool; pts: Pt[] }
/** A grab on a drawing: a point index to drag, or 'line' to move it whole. */
export type Grab = { id: string; handle: number | 'line' };

const POINTS: Record<Tool, number> = { h: 1, v: 1, trend: 2, fib: 2 };
const key = (coin: string) => `trade-ui:drawings:${coin}`;
const valid = (d: any): d is Drawing =>
  typeof d?.id === 'string' && d.kind in POINTS && Array.isArray(d.pts) && d.pts.length === POINTS[d.kind as Tool] && d.pts.every((p: any) => Number.isFinite(p?.t) && Number.isFinite(p?.p));

/** The chart coin's drawings in price/time, the armed tool and its first click, and the selection. */
export const drawings = $state({ coin: '', list: [] as Drawing[], tool: null as Tool | 'ruler' | 'eraser' | 'ask' | null, pending: null as Pt | null, hover: null as Pt | null, sel: null as string | null });
let undo: Drawing[][] = [];
let redo: Drawing[][] = [];
const copy = () => $state.snapshot(drawings.list) as Drawing[];

export function loadDrawings(coin: string) {
  const raw = load<unknown>(key(coin), []);
  Object.assign(drawings, { coin, list: Array.isArray(raw) ? raw.filter(valid) : [], tool: null, pending: null, sel: null });
  undo = [];
  redo = [];
}

function set(list: Drawing[]) {
  drawings.list = list;
  if (!list.some((d) => d.id === drawings.sel)) drawings.sel = null;
  save(key(drawings.coin), list);
}

/** Records `before` for undo and saves the current list (after an in-place drag) or `next`. */
export function commit(next: Drawing[] = copy(), before = copy()) {
  undo.push(before);
  redo = [];
  set(next);
}

const step = (from: Drawing[][], to: Drawing[][]) => {
  const list = from.pop();
  if (!list) return false;
  to.push(copy());
  set(list);
  return true;
};
export const undoDrawing = () => step(undo, redo);
export const redoDrawing = () => step(redo, undo);
export const deleteSelected = () => !!drawings.sel && (commit(copy().filter((d) => d.id !== drawings.sel)), true);
export const clearDrawings = () => drawings.list.length > 0 && commit([]);

export function armTool(tool: Tool | 'ruler' | 'eraser' | 'ask') {
  Object.assign(drawings, { tool, pending: null, sel: null });
}

/** A click with a tool armed: one click places a line, two place a trend or fib. */
export function placePoint(pt: Pt) {
  const tool = drawings.tool as Tool;
  if (!Number.isFinite(pt.t) || !Number.isFinite(pt.p)) return;
  if (POINTS[tool] === 2 && !drawings.pending) return void (drawings.pending = pt);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pts = drawings.pending ? [drawings.pending, pt] : [pt];
  Object.assign(drawings, { tool: null, pending: null, sel: id });
  commit([...copy(), { id, kind: tool, pts }]);
}

const px = (v: View, p: Pt) => ({ x: v.x(p.t) ?? NaN, y: v.y(p.p) ?? NaN });

/** pad widens every tolerance, for a finger. */
export function hitDrawing(v: View, x: number, y: number, pad = 0): Grab | null {
  if (!settings.chart.indicators.drawings.on) return null;
  for (const d of [...drawings.list].reverse()) {
    const [a, b] = d.pts.map((p) => px(v, p));
    if (d.kind === 'h' && Math.abs(a.y - y) <= 6 + pad) return { id: d.id, handle: 0 };
    if (d.kind === 'v' && Math.abs(a.x - x) <= 6 + pad) return { id: d.id, handle: 0 };
    if (d.kind === 'h' || d.kind === 'v') continue;
    const end = [a, b].findIndex((q) => Math.hypot(q.x - x, q.y - y) <= 7 + pad);
    if (end >= 0) return { id: d.id, handle: end };
    const inside = x >= Math.min(a.x, b.x) - pad && x <= Math.max(a.x, b.x) + pad;
    const onFib = d.kind === 'fib' && inside && fibLevels(d.pts[0].p, d.pts[1].p).some((l) => Math.abs((v.y(l.price) ?? NaN) - y) <= 5 + pad);
    if (onFib || segDist(x, y, a, b) <= 5 + pad) return { id: d.id, handle: 'line' };
  }
  return null;
}

/** Moves a grabbed point in place, or the whole drawing by the pointer's travel from `start` over its points at the press; the caller commits once the drag ends. */
export function dragPoint(g: Grab, pt: Pt, start: Pt, pts0: Pt[]) {
  const d = drawings.list.find((x) => x.id === g.id);
  if (!d) return;
  if (g.handle === 'line') return void (Number.isFinite(pt.t + pt.p + start.t + start.p) && (d.pts = pts0.map((q) => ({ t: q.t + pt.t - start.t, p: q.p + pt.p - start.p }))));
  const cur = d.pts[g.handle];
  d.pts[g.handle] = d.kind === 'h' ? { t: cur.t, p: pt.p } : d.kind === 'v' ? { t: pt.t, p: cur.p } : pt;
}

export function paintDrawings(ctx: CanvasRenderingContext2D, v: View, c: Colors) {
  if (!settings.chart.indicators.drawings.on) return;
  const dec = meta.byName.get(drawings.coin)?.szDecimals;
  const preview = drawings.pending && drawings.hover ? [{ id: '', kind: drawings.tool as Tool, pts: [drawings.pending, drawings.hover] }] : [];
  ctx.font = c.font;
  ctx.textBaseline = 'bottom';
  for (const d of [...drawings.list, ...preview]) {
    const sel = d.id === drawings.sel;
    const [a, b] = d.pts.map((p) => px(v, p));
    ctx.strokeStyle = ctx.fillStyle = c.accent;
    ctx.lineWidth = sel ? 2 : 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    if (d.kind === 'h') ctx.moveTo(0, a.y), ctx.lineTo(v.w, a.y);
    else if (d.kind === 'v') ctx.moveTo(a.x, 0), ctx.lineTo(a.x, v.h);
    else ctx.moveTo(a.x, a.y), ctx.lineTo(b.x, b.y);
    if (d.kind === 'fib') ctx.setLineDash([4, 4]);
    ctx.stroke();
    if (d.kind === 'fib') fib(ctx, v, d, a.x, b.x, dec);
    if (sel && d.pts.length === 2) for (const q of [a, b]) ctx.fillRect(q.x - 4, q.y - 4, 8, 8);
  }
}

function fib(ctx: CanvasRenderingContext2D, v: View, d: Drawing, xa: number, xb: number, dec?: number) {
  const [x0, x1] = [Math.min(xa, xb), Math.max(xa, xb)];
  ctx.setLineDash([]);
  for (const l of fibLevels(d.pts[0].p, d.pts[1].p)) {
    const y = v.y(l.price);
    if (y === null) continue;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.fillText(`${l.r} (${fmtPx(l.price, dec)})`, x0 + 4, y - 2);
  }
}

/** Horizontal lines keep a label on the price axis. */
export const drawingLabels = (): number[] => (settings.chart.indicators.drawings.on ? drawings.list.filter((d) => d.kind === 'h').map((d) => d.pts[0].p) : []);
