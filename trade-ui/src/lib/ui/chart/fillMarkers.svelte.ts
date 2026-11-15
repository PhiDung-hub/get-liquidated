import { tick, untrack } from 'svelte';
import { createSeriesMarkers, type IChartApi, type ISeriesApi, type MouseEventParams, type SeriesMarker, type UTCTimestamp } from 'lightweight-charts';
import { fills, type Fill } from '$lib/account/fills.svelte';
import { viewAddress } from '$lib/session/session.svelte';
import { market } from '$lib/market/market.svelte';
import { settings } from '$lib/settings/settings.svelte';
import { MS } from '$lib/market/candles';

type Group = { time: number; buy: boolean; sz: number; notional: number; n: number; ids: string[] };

/** The chart coin's fills on the bar under the pointer, in chart pixels; null off any bar with fills. */
export const fillHover = $state({ at: null as null | { x: number; y: number }, fills: [] as Fill[] });

/** Every fill of the chart coin as Hyperliquid draws them: per bar, a B under it for its buys and an S over it for its sells; the hover card lists them. */
export function fillMarkers(chart: IChartApi, series: ISeriesApi<'Candlestick'>, el: HTMLElement) {
  const markers = createSeriesMarkers(series, [], { autoScale: false });
  const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colors = { buy: css('--buy'), sell: css('--sell') };
  let mine: Fill[] = [];
  let interval = 0;
  let groups: Group[] = [];
  let byBar = new Map<number, Fill[]>();
  let shown = '';
  const barOf = (data: readonly { time: unknown }[], t: number) => {
    let lo = 0, hi = data.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (Number(data[mid].time) * 1000 <= t) lo = mid + 1;
      else hi = mid;
    }
    const bar = data[lo - 1];
    return bar && t < Number(bar.time) * 1000 + interval ? lo - 1 : -1;
  };
  const group = () => {
    const data = series.data();
    const by = new Map<string, Group>();
    byBar = new Map();
    for (const f of mine) {
      const i = barOf(data, f.time);
      if (i < 0) continue;
      const time = Number(data[i].time);
      const at = byBar.get(time);
      if (at) at.push(f);
      else byBar.set(time, [f]);
      const key = `${time}:${f.side}`;
      const g = by.get(key) ?? { time, buy: f.side === 'B', sz: 0, notional: 0, n: 0, ids: [] };
      g.sz += f.sz;
      g.notional += f.sz * f.px;
      g.n += 1;
      g.ids.push(`${f.tid}:${f.oid}`);
      by.set(key, g);
    }
    groups = [...by.values()].sort((a, b) => a.time - b.time);
  };
  const draw = () => {
    const drawn: SeriesMarker<UTCTimestamp>[] = groups.map((g) => ({
      time: g.time as UTCTimestamp, price: g.notional / g.sz, position: g.buy ? 'belowBar' : 'aboveBar', shape: g.buy ? 'arrowUp' : 'arrowDown',
      color: g.buy ? colors.buy : colors.sell, text: g.buy ? 'B' : 'S', id: g.ids.join(',')
    }));
    const key = JSON.stringify(drawn);
    if (key === shown) return;
    shown = key;
    markers.setMarkers(drawn);
    el.dataset.fillMarkers = key;
  };
  const regroup = () => (group(), draw());
  const hover = (p: MouseEventParams) => {
    const list = p.point && p.time !== undefined ? byBar.get(Number(p.time)) : undefined;
    fillHover.at = list ? { x: p.point!.x, y: p.point!.y } : null;
    fillHover.fills = list ? list.toSorted((a, b) => b.time - a.time) : [];
  };
  const off = $effect.root(() => {
    $effect(() => {
      void settings.display.theme;
      let cancelled = false;
      void tick().then(() => {
        if (cancelled) return;
        untrack(() => {
          colors.buy = css('--buy');
          colors.sell = css('--sell');
          shown = '';
          draw();
        });
      });
      return () => { cancelled = true; };
    });
    $effect(() => {
      const coin = market.coin;
      interval = MS[settings.chart.interval];
      mine = viewAddress() && settings.chart.indicators.fills.on ? fills.list.filter((f) => f.coin === coin) : [];
      untrack(regroup);
    });
  });
  series.subscribeDataChanged(regroup);
  chart.subscribeCrosshairMove(hover);
  return () => {
    off();
    chart.unsubscribeCrosshairMove(hover);
    series.unsubscribeDataChanged(regroup);
    markers.detach();
    fillHover.at = null;
    delete el.dataset.fillMarkers;
  };
}
