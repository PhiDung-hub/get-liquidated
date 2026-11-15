import { LineStyle, type IPriceLine, type IPrimitivePaneRenderer, type ISeriesApi, type ISeriesPrimitive, type Time } from 'lightweight-charts';
import { tick, untrack } from 'svelte';
import { agent, noAi, type Mark } from '$lib/agent/agent.svelte';
import { meta } from '$lib/market/meta.svelte';
import { settings } from '$lib/settings/settings.svelte';
import { fmtPx } from '$lib/util/format';
import { legendBoxes, lineLabels, meets, type Box } from './positionLines.svelte';

/** `placed` is false until the label was placed with its measured width; the chart hides it until then. */
export interface AiLabel { key: string; text: string; tone: string; mine: boolean; y: number; left: number; w: number; max: number | null; placed: boolean }
/** The chart coin's drawn AI marks; level and zone labels in chart pixels (y -1 off the price pane); bias chips for the legend. */
export const aiView = $state({ marks: [] as Mark[], labels: [] as AiLabel[], bias: [] as string[], height: 28 });

const PAD = 8;
const GAP = 4;
type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

const textOf = (m: Mark, dec: number | undefined) => `${m.author === 'user' ? 'You' : 'AI'} · ${m.label} ${m.type === 'level' ? fmtPx(m.a!, dec) : `${fmtPx(m.a!, dec)}–${fmtPx(m.b!, dec)}`}`;

/** Labels without horizontal room move below overlapping legend text, retaining the written price. */
function stepPast(a: Box, placed: Box[], home: number, pane: number, paneH: number) {
  for (let hit = placed.find(meets(a, GAP)); hit; hit = placed.find(meets(a, GAP))) a.left = hit.left + hit.w + GAP;
  if (a.left + a.w > pane) {
    a.left = home;
    const height = a.bot - a.top;
    for (let hit = placed.find(meets(a, GAP)); hit; hit = placed.find(meets(a, GAP))) {
      a.top = hit.bot + GAP;
      a.bot = a.top + height;
      if (a.bot > paneH) return false;
    }
  }
  placed.push(a);
  return true;
}

/** The width left before the nearest line label right of the label on its row, or null when none is. */
function roomBefore(a: Box, lines: Box[]) {
  const ahead = lines.filter((t) => t.top < a.bot && a.top < t.bot && t.left > a.left).map((t) => t.left - GAP - a.left);
  return ahead.length ? Math.max(0, Math.min(...ahead)) : null;
}

/** Draws the chart coin's unexpired AI marks on `series`: a level as a dashed line, a zone as a band; their labels sit at the left of the pane, right of the legend text and the line labels. */
export function aiMarks(series: ISeriesApi<'Candlestick'>, el: HTMLElement, getCoin: () => string, inset = () => 0, at: (t: number) => number | null = () => null, half = () => 0, legendBottom = () => Infinity): () => void {
  const color = (mark: Mark) => getComputedStyle(document.documentElement).getPropertyValue(({ support: '--buy', resistance: '--warn', invalidation: '--sell', neutral: '--bright' } as const)[mark.tone ?? 'neutral']).trim();
  let lines: IPriceLine[] = [];
  let request = () => {};
  const span = (m: Mark, h: number): [number, number] | null => {
    const [ya, yb] = [m.a!, m.b ?? m.a!].map((p) => series.priceToCoordinate(p) ?? NaN);
    const [top, bot] = [Math.max(Math.min(ya, yb), 0), Math.min(Math.max(ya, yb), h)];
    return top <= bot ? [top, bot] : null;
  };
  // The renderer runs in lightweight-charts' frame, where a layout read is forced, so el is measured only on a resize (fullscreen, phone width) or a font size change.
  let [base, width] = [0, 0];
  const measure = () => {
    width = el.clientWidth;
    base = Math.max(28, matchMedia('(max-width: 900px)').matches ? 36 : 0, Math.ceil(parseFloat(getComputedStyle(el).fontSize) * 1.6));
  };
  measure();
  const place = (paneH: number) => {
    if (!aiView.labels.length && !aiView.marks.some((m) => m.type !== 'bias')) return;
    const h = Math.max(lineLabels.size, base);
    aiView.height = h;
    const home = PAD + inset();
    const pane = width - series.priceScale().width();
    const row = (t: { y: number; left: number; w: number }) => ({ top: t.y - h / 2, bot: t.y + h / 2, left: t.left, w: t.w });
    const banded = aiView.marks.some((m) => {
      const s = m.type !== 'bias' && span(m, paneH);
      return !!s && ((s[0] + s[1]) / 2 - h / 2 < legendBottom() || (s[0] + s[1]) / 2 + h / 2 > paneH);
    });
    // Legend text only moves a label; a line label to its right also clips it, so an unmeasured label never settles into a gap in the legend.
    const lines = [...lineLabels.groups, ...lineLabels.list.filter((t) => !t.group)].filter((t) => t.y >= 0).map(row);
    const placed = [...(banded ? legendBoxes(el) : []), ...lines];
    const w = new Map(aiView.labels.map((l) => [l.key, l.w]));
    const dec = meta.byName.get(getCoin())?.szDecimals;
    const labels = aiView.marks.filter((m) => m.type !== 'bias').map((m): AiLabel => {
      const s = span(m, paneH);
      const a: Box = { top: 0, bot: 0, left: home, w: w.get(m.id) ?? 0 };
      let y = s ? Math.round((s[0] + s[1]) / 2) : -1;
      if (y >= 0) {
        const fits = stepPast(Object.assign(a, { top: y - h / 2, bot: y + h / 2 }), placed, home, pane, paneH);
        y = fits ? Math.round((a.top + a.bot) / 2) : -1;
      }
      return { key: m.id, text: textOf(m, dec), tone: m.tone ?? 'neutral', mine: m.author === 'user', y, left: a.left, w: a.w, max: y >= 0 ? roomBefore(a, lines) : null, placed: a.w > 0 };
    });
    if (JSON.stringify(labels) !== JSON.stringify(aiView.labels)) aiView.labels = labels;
  };
  // The renderer runs on every repaint, so labels follow each price scale move from here.
  const draw = (target: Target) =>
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const m of aiView.marks.filter((m) => m.type === 'zone')) {
        context.fillStyle = color(m) + '22';
        const s = span(m, mediaSize.height);
        if (!s) continue;
        // A zone the user picked covers only its own candles; an AI zone spans the pane.
        const [x0, x1, pad] = m.author === 'user' && m.t0 && m.t1 ? [at(m.t0), at(m.t1), half()] : [0, mediaSize.width, 0];
        if (x0 !== null && x1 !== null) context.fillRect(x0 - pad, s[0], x1 - x0 + 2 * pad, s[1] - s[0]);
      }
      place(mediaSize.height);
    });
  const views = [{ zOrder: () => 'bottom' as const, renderer: () => ({ draw }) }];
  const primitive: ISeriesPrimitive<Time> = {
    attached: (p) => void (request = p.requestUpdate),
    detached: () => void (request = () => {}),
    paneViews: () => views
  };
  series.attachPrimitive(primitive);
  const resized = new ResizeObserver(() => (measure(), request()));
  resized.observe(el);

  const sync = (shown: Mark[]) => {
    lines.forEach((l) => series.removePriceLine(l));
    lines = shown.filter((m) => m.type === 'level').map((m) => series.createPriceLine({ price: m.a!, title: '', color: color(m), lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: false }));
    Object.assign(aiView, { marks: shown, bias: shown.filter((m) => m.type === 'bias').map((m) => `AI ${m.label}`) });
    request();
  };

  const off = $effect.root(() => {
    $effect(() => {
      void settings.display.theme;
      void settings.display.fs;
      let cancelled = false;
      void tick().then(() => {
        if (cancelled) return;
        untrack(() => {
          measure();
          const levels = aiView.marks.filter((m) => m.type === 'level');
          lines.forEach((line, i) => line.applyOptions({ color: color(levels[i]) }));
          request();
        });
      });
      return () => { cancelled = true; };
    });
    $effect(() => {
      const coin = getCoin();
      const shown = settings.chart.indicators.ai.on && !noAi() ? agent.marks.filter((m) => m.coin === coin) : [];
      untrack(() => sync(shown));
    });
    // A label's measured width, a bias chip's legend row, or a position label or order tag moving re-places them.
    $effect(() => {
      if (!aiView.labels.length) return;
      void [aiView.labels.map((l) => l.w), aiView.bias.length, lineLabels.list.map((t) => [t.y, t.left, t.w]), lineLabels.groups.map((g) => [g.y, g.left, g.w])];
      request();
    });
  });
  return () => {
    off();
    resized.disconnect();
    lines.forEach((l) => series.removePriceLine(l));
    series.detachPrimitive(primitive);
    Object.assign(aiView, { marks: [], labels: [], bias: [] });
  };
}
