import { MS, snapshotFrom, type Interval } from './candles';
import type { Hist, HistBar } from './flow';

export const NO_HIST: Hist = { status: 'off', bars: [], note: '' };
const nul = (v: unknown) => v === null || typeof v === 'number';
const isBar = (b: HistBar) => typeof b?.t === 'number' && nul(b.buy) && nul(b.sell) && nul(b.oi) && typeof b.gap === 'boolean';

/** The collector's bars up to the start minute, plus one bar before the chart's first so its OI delta has a predecessor.
 * Only JSON of the right shape counts: `vite preview` and an expired Access session answer with HTML or a redirect. */
export async function loadHistory(coin: string, interval: Interval, start: number, ctl: AbortController): Promise<Hist> {
  const q = new URLSearchParams({ coin, interval, from: String(snapshotFrom(interval, start) - MS[interval]), to: String(Math.floor(start / 6e4) * 6e4) });
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const res = await fetch(`/api/flow?${q}`, { signal: ctl.signal });
    const body = res.ok && res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : null;
    if (typeof body?.recorded !== 'boolean' || !Array.isArray(body.bars) || !body.bars.every(isBar)) return { ...NO_HIST, note: 'history unavailable' };
    if (body.bars.length) return { status: 'ok', bars: body.bars, note: '' };
    return { status: 'none', bars: [], note: body.recorded ? 'no recorded history in range (1m data is kept 30 days)' : `${coin} is not recorded` };
  } catch {
    return { ...NO_HIST, note: 'history unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
