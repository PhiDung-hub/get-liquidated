import { untrack } from 'svelte';
import { LineStyle, type AutoscaleInfo, type IPriceLine, type ISeriesApi } from 'lightweight-charts';
import { market } from '$lib/market/market.svelte';
import { meta } from '$lib/market/meta.svelte';
import { settings } from '$lib/settings/settings.svelte';
import { roundPx, tickSize } from '$lib/signing/wire';

export const SETUPS = [
  { id: 'vwap', name: 'VWAP reclaim', style: 'Day trade', timeframe: '5m bias · 1m trigger', risk: 0.002, reward: 2,
    long: 'Price reclaims VWAP, then a retest holds above it.', short: 'Price loses VWAP, then a retest rejects below it.',
    checks: 'Check VWAP slope, relative volume and room to the next session level.', invalidation: 'A close through the retest extreme invalidates the setup.' },
  { id: 'breakout', name: 'Opening range retest', style: 'Day trade', timeframe: '15m range · 1m retest', risk: 0.003, reward: 2,
    long: 'Price breaks the opening range high, then holds it on a retest.', short: 'Price breaks the opening range low, then rejects it on a retest.',
    checks: 'Define the opening range first. Wait for a close outside and a controlled retest.', invalidation: 'A close back inside the range invalidates the breakout.' },
  { id: 'sweep', name: 'Liquidity sweep reversal', style: 'Scalp', timeframe: '5m level · 1m reclaim', risk: 0.0015, reward: 1.5,
    long: 'Price sweeps a prior low, then closes back above it.', short: 'Price sweeps a prior high, then closes back below it.',
    checks: 'Look for rejection and follow-through; avoid fading an accelerating trend.', invalidation: 'Acceptance beyond the sweep extreme invalidates the reversal.' },
  { id: 'pullback', name: 'EMA pullback scalp', style: 'Scalp', timeframe: '5m trend · 1m pullback', risk: 0.001, reward: 2,
    long: 'In an uptrend, a pullback to the fast EMA forms a higher low and breaks up.', short: 'In a downtrend, a pullback to the fast EMA forms a lower high and breaks down.',
    checks: 'Check EMA alignment, spread and liquidity. Skip a flat or choppy trend.', invalidation: 'A break of the pullback swing invalidates the entry.' },
  { id: 'triple', name: 'Triple MA 7/30/99', style: 'Trend scalp', timeframe: '7 / 30 / 99 SMA · current chart', risk: 0.002, reward: 2,
    long: 'The 7 SMA is above 30, and 30 is above 99. Wait for a pullback that holds the fast or middle average.', short: 'The 7 SMA is below 30, and 30 is below 99. Wait for a bounce that rejects the fast or middle average.',
    checks: 'Prefer a sloping, separated MA stack. Avoid repeated crosses in a flat range.', invalidation: 'A loss of the pullback swing or a broken MA stack invalidates the setup.' }
] as const;

export type SetupId = (typeof SETUPS)[number]['id'];
type Demo = { coin: string; setup: SetupId; side: 'buy' | 'sell'; entry: number; stop: number; target: number; at: number };
export const coach = $state({ open: false, collapsed: false, mode: 'live' as 'live' | 'demo' | 'metrics', demo: null as Demo | null, phase: 'watching' as 'watching' | 'triggered' | 'invalidated', lines: 0, error: '' });

export function showCoach(mode: 'live' | 'demo' | 'metrics' = 'live') {
  coach.open = true;
  coach.collapsed = false;
  coach.mode = mode;
}

export function loadDemo(id: SetupId, side: 'buy' | 'sell' = coach.demo?.side ?? 'buy') {
  const setup = SETUPS.find((s) => s.id === id);
  const asset = meta.byName.get(market.coin);
  const mark = market.ctx?.markPx;
  if (!setup || !asset || !mark || !Number.isFinite(mark) || mark <= 0) {
    coach.error = 'Waiting for this market’s price. Try again once the mark loads.';
    return;
  }
  if (asset.spot && side === 'sell') {
    coach.error = 'Choose a perp market for a short example.';
    return;
  }
  const direction = side === 'buy' ? 1 : -1;
  const entry = roundPx(mark, asset, side === 'buy');
  const risk = Math.min(entry / 4, Math.max(entry * setup.risk, tickSize(entry, asset) * 3));
  const stop = roundPx(entry - direction * risk, asset, side !== 'buy');
  const target = roundPx(entry + direction * risk * setup.reward, asset, side !== 'buy');
  if (!(stop > 0 && target > 0 && direction * (entry - stop) > 0 && direction * (target - entry) > 0)) {
    coach.error = 'This market’s price precision cannot represent the example levels.';
    return;
  }
  coach.demo = { coin: market.coin, setup: id, side, entry, stop, target, at: Date.now() };
  coach.phase = 'watching';
  coach.error = '';
}

export function demoLevels(series: ISeriesApi<'Candlestick'>, getCoin: () => string, changed: () => void): () => void {
  let lines: IPriceLine[] = [];
  const original = series.options().autoscaleInfoProvider ?? ((base: () => AutoscaleInfo | null) => base());
  let frame = 0;
  const clear = () => { lines.forEach((line) => series.removePriceLine(line)); lines = []; coach.lines = 0; };
  const off = $effect.root(() => {
    $effect(() => {
      const coin = getCoin();
      const demo = coach.demo;
      if (demo && demo.coin !== coin) untrack(() => { coach.demo = null; coach.error = ''; });
      void settings.display.theme;
      clear();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(changed);
      if (!coach.open || coach.mode !== 'demo' || demo?.coin !== coin) {
        series.applyOptions({ autoscaleInfoProvider: original });
        return;
      }
      series.applyOptions({ autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const info = original(base);
        if (!info?.priceRange) return info;
        return { ...info, priceRange: {
          minValue: Math.min(info.priceRange.minValue, demo.entry, demo.stop, demo.target),
          maxValue: Math.max(info.priceRange.maxValue, demo.entry, demo.stop, demo.target)
        } };
      } });
      const css = getComputedStyle(document.documentElement);
      lines = [
        { price: demo.entry, title: 'DEMO entry', color: css.getPropertyValue('--accent').trim() },
        { price: demo.stop, title: 'DEMO stop', color: css.getPropertyValue('--sell').trim() },
        { price: demo.target, title: 'DEMO target', color: css.getPropertyValue('--buy').trim() }
      ].map((options) => series.createPriceLine({ ...options, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true }));
      coach.lines = lines.length;
    });
  });
  return () => { off(); cancelAnimationFrame(frame); clear(); series.applyOptions({ autoscaleInfoProvider: original }); };
}
