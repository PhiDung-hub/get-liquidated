import { untrack } from 'svelte';
import { socket } from '$lib/transport/ws.svelte';
import { settings } from '$lib/settings/settings.svelte';
import { DEFS } from './studies';
import { market } from './market.svelte';
import { applyDexCtxs, dexOf, isSpot, loadCaps, meta, parseCtx, parseSpotCtx, spotName } from './meta.svelte';
import { applyBbo, applyDepth, applyTop, book, bbo, bookAcked, clearBook, currentBins, setBin } from './book.svelte';
import { pickBin } from './bins';
import { applyTrades, parseTrade, trades } from './trades.svelte';
import { addOi, addTrades, newFlow, type Hist } from './flow';
import { NO_HIST, loadHistory } from './history';
import { num } from '$lib/util/parse';

export const safe = (name: string, f: (d: any) => void) => (d: any) => {
  try {
    f(d);
  } catch (e) {
    console.warn(`dropped ${name} message`, e);
  }
};

class Flows {
  now = $state.raw(newFlow(0, '15m'));
  hist = $state.raw<Hist>(NO_HIST);
  start = $derived(this.now.start);
}
export const flow = new Flows();
let replay = false;
const flowTrades = (d: any[]) => {
  flow.now = addTrades(flow.now, d.map(parseTrade), replay);
  replay = false;
};
// activeAssetCtx carries no timestamp, so an OI sample is timed by its arrival.
const flowOi = (d: any) => (flow.now = addOi(flow.now, Date.now(), num(d.ctx.openInterest, 'openInterest')));

export function startMarketFeeds(): () => void {
  return $effect.root(() => {
    $effect(() => {
      if (socket.reconnects) replay = true;
    });
    $effect(() => {
      if (meta.hip3 === 'on') return socket.subscribe({ type: 'allDexsAssetCtxs' }, safe('allDexsAssetCtxs', applyDexCtxs));
    });
    $effect(() => {
      if (socket.state !== 'open' || spotName(market.coin)) return;
      const dex = dexOf(market.coin);
      untrack(() => void loadCaps(dex));
      const timer = setInterval(() => void loadCaps(dex), 60_000);
      return () => clearInterval(timer);
    });
    // Bars are per chart interval and no trades are kept, so a coin or interval switch starts a new count.
    $effect(() => {
      const coin = market.coin;
      flow.now = newFlow(Date.now(), settings.chart.interval);
      const offs = [
        socket.subscribe({ type: 'trades', coin }, safe('flow trades', flowTrades)),
        ...(spotName(coin) ? [] : [socket.subscribe({ type: 'activeAssetCtx', coin }, safe('flow ctx', flowOi))])
      ];
      return () => offs.forEach((off) => off());
    });
    // History is fetched once per session; live takes over from its start.
    $effect(() => {
      const on = settings.chart.studies.some((s) => DEFS[s.type]?.flow && !s.hidden);
      const [coin, interval, start] = [market.coin, settings.chart.interval, flow.start];
      if (!on || !start) return void (flow.hist = NO_HIST);
      if (spotName(coin)) return void (flow.hist = { status: 'none', bars: [], note: 'no spot history' });
      const ctl = new AbortController();
      flow.hist = { status: 'loading', bars: [], note: '' };
      loadHistory(coin, interval, start, ctl).then((h) => !ctl.signal.aborted && (flow.hist = h));
      return () => ctl.abort();
    });
    $effect(() => {
      const coin = market.coin;
      Object.assign(bbo, { bid: 0, ask: 0, bidSz: 0, askSz: 0, time: 0, seen: 0 });
      trades.list = [];
      const offs = [
        socket.subscribe({ type: 'bbo', coin }, safe('bbo', applyBbo)),
        socket.subscribe({ type: 'trades', coin }, safe('trades', applyTrades)),
        socket.subscribe({ type: 'activeAssetCtx', coin }, safe('ctx', (d) => (market.ctx = isSpot(coin) ? parseSpotCtx(d.ctx) : parseCtx(d.ctx))))
      ];
      return () => offs.forEach((off) => off());
    });
    // Runs before the l2Book effect, so a coin switch subscribes once, already on the new coin's own bin.
    $effect(() => {
      const bins = currentBins();
      const want = bins.length ? pickBin(bins, settings.book.bins[market.coin]) : null;
      const next = !want || want.nSigFigs === null ? null : want;
      const cur = untrack(() => book.bin);
      // The step too: another coin's bin can share the wire grouping but not the step or decimals.
      if (next?.step !== cur?.step || next?.nSigFigs !== cur?.nSigFigs || next?.mantissa !== cur?.mantissa) setBin(next);
    });
    $effect(() => {
      const gen = book.gen;
      const b = book.bin;
      const grouping = b ? { nSigFigs: b.nSigFigs, ...(b.mantissa !== 1 ? { mantissa: b.mantissa } : {}) } : {};
      const sub = { type: 'l2Book', coin: market.coin, ...grouping };
      clearBook();
      const offs = [
        socket.subscribe({ ...sub, fast: true }, safe('l2Book fast', applyTop), () => bookAcked(gen, 'top')),
        socket.subscribe(sub, safe('l2Book', applyDepth), () => bookAcked(gen, 'depth'))
      ];
      return () => offs.forEach((off) => off());
    });
  });
}
