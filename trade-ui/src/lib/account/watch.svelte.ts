import { untrack } from 'svelte';
import { socket, type Sub } from '$lib/transport/ws.svelte';
import { info } from '$lib/transport/info';
import { net } from '$lib/transport/network';
import { fresh, keep } from '$lib/util/storage';
import { viewAddress } from '$lib/session/session.svelte';
import { market } from '$lib/market/market.svelte';
import { applySpotCtx, meta, spotName } from '$lib/market/meta.svelte';
import { ledger, reconcileAll, seen } from '$lib/exchange/ledger.svelte';
import { chases } from '$lib/orders/chase.svelte';
import { applyClearinghouse, applySpot, inventory, spotCoins } from './inventory.svelte';
import { applyOpenOrders, applyOrderUpdates, resetOrders } from './orders.svelte';
import { fills, liveFills, mergeFills, seedFills } from './fills.svelte';
import { applyFundings, funding } from './funding.svelte';
import { applyAssetData, assetData } from './assetData.svelte';
import { loadFees } from './fees.svelte';
import { onRespot, prove, proved } from './spotPending';

const safe = (name: string, f: (d: any) => void) => (d: any) => {
  try {
    f(d);
  } catch (e) {
    console.warn(`dropped ${name} message`, e);
  }
};

/** Every 30 s, shared by this browser's tabs and reloads: an answer another one read in the last 25 s is shown instead. */
async function pollRate(user: string) {
  const key = `trade-ui:rate:${net.current}:${user}`;
  try {
    const hit = fresh<any>(key, 25_000);
    const r = hit ?? (await info<any>({ type: 'userRateLimit', user }));
    if (!hit) keep(key, r);
    if (viewAddress() !== user) return;
    inventory.rate = { used: Number(r.nRequestsUsed), cap: Number(r.nRequestsCap) + Number(r.nRequestsSurplus) };
  } catch (e) {
    console.warn('userRateLimit failed', e);
  }
}

function resetAccount() {
  Object.assign(inventory, {
    positions: [], balances: [], dexStates: [], broken: [], accountValue: 0, marginUsed: 0, totalNtl: 0, withdrawable: 0,
    pmRatio: 0, borrowRatio: 0, abstraction: '', rate: null, loaded: false, spotLoaded: false, unnamedAgent: null
  });
  resetOrders();
  funding.list = [];
  ledger.entries = ledger.entries.filter((e) => e.state === 'pending' || e.state === 'unknown');
  ledger.moves = [];
  chases.list = chases.list.filter((c) => c.state !== 'stopped');
  Object.assign(assetData, { coin: '', leverage: null, maxTradeSzs: [0, 0], availableToTrade: [0, 0] });
}

const REFRESH_MS = 2000;

// HL holds some fills and order changes for its ~5 s account tick. The trailing ask catches a snapshot taken just before the change landed.
function refresher(subs: () => Sub[]) {
  let at = -REFRESH_MS, timer: ReturnType<typeof setTimeout> | undefined;
  const go = () => {
    at = performance.now();
    timer = undefined;
    for (const s of subs()) socket.refresh(s);
  };
  return {
    ask: () => {
      if (timer) return;
      const wait = at + REFRESH_MS - performance.now();
      if (wait > 0) timer = setTimeout(go, wait);
      else go();
    },
    stop: () => clearTimeout(timer)
  };
}

function userFeeds(user: string, pm: boolean) {
  const spot = { type: 'spotState', user, isPortfolioMargin: pm }, onSpot = safe('spot', applySpot);
  let offSpot = socket.subscribe(spot, onSpot);
  const offRespot = onRespot(() => (offSpot(), (offSpot = socket.subscribe(spot, onSpot))));
  const fresh = refresher(() => [
    { type: 'allDexsClearinghouseState', user }, spot, { type: 'activeAssetData', user, coin: market.coin },
    ...(orderFeed.perDex ? ['', ...meta.dexes.map((d) => d.name)] : ['ALL_DEXS']).map((dex) => ({ type: 'openOrders', user, dex }))
  ]);
  const offs = [
    socket.subscribe({ type: 'allDexsClearinghouseState', user }, safe('clearinghouse', applyClearinghouse)),
    () => offSpot(),
    // HL's own UI reads the mode from webData3; an account that never chose one has no field and is standard.
    socket.subscribe({ type: 'webData3', user }, safe('webData3', (d) => {
      if (String(d.userState?.user ?? user).toLowerCase() !== user.toLowerCase()) return;
      inventory.abstraction = String(d.userState?.abstraction ?? 'default');
      const a = d.userState?.agentAddress;
      inventory.unnamedAgent = typeof a === 'string' ? { address: a.toLowerCase(), validUntil: Number(d.userState.agentValidUntil) || null } : null;
    })),
    socket.subscribe({ type: 'orderUpdates', user }, safe('orderUpdates', (d) => (applyOrderUpdates(d), proved(prove(d)), fresh.ask()))),
    socket.subscribe({ type: 'userFills', user, aggregateByTime: false }, safe('userFills', (d) => {
      const added = mergeFills(d.fills, user);
      const live = !d.isSnapshot && added.length > 0;
      if (live && user === viewAddress()) liveFills.emit(added);
      seen(d.isSnapshot ? d.fills ?? [] : added, d.isSnapshot ? 'snapshot' : 'update');
      if (live) fresh.ask();
      proved(prove());
    })),
    socket.subscribe({ type: 'userFundings', user }, safe('userFundings', applyFundings))
  ];
  const timer = setInterval(() => pollRate(user), 30_000);
  void pollRate(user);
  return () => {
    clearInterval(timer);
    fresh.stop();
    offRespot();
    offs.forEach((off) => off());
  };
}

let feedUser: string | null = null;
const orderFeed = $state({ perDex: false });

/** HL's own UI reads every dex's orders through the undocumented ALL_DEXS; if HL refuses it, one feed per listed dex takes over for the session. */
function orderFeeds(user: string, perDex: boolean, dexes: string[]): () => void {
  if (!perDex) {
    resetOrders(1);
    return socket.subscribe({ type: 'openOrders', user, dex: 'ALL_DEXS' }, safe('openOrders', (d) => (applyOpenOrders(d), proved(prove()))), undefined, () => {
      console.warn('openOrders ALL_DEXS refused, subscribing per dex');
      orderFeed.perDex = true;
    });
  }
  resetOrders(dexes.length);
  const offs = dexes.map((dex) => socket.subscribe({ type: 'openOrders', user, dex }, safe('openOrders', (d) => (applyOpenOrders(d), proved(prove())))));
  return () => offs.forEach((off) => off());
}

export function startAccountFeeds(): () => void {
  return $effect.root(() => {
    // Derived, so the abstraction's first answer only resubscribes when it is portfolio margin.
    const portfolio = $derived(inventory.abstraction === 'portfolioMargin');
    $effect(() => {
      const user = viewAddress();
      const pm = portfolio;
      return untrack(() => {
        if (user !== feedUser) resetAccount();
        feedUser = user;
        if (!user) return;
        return userFeeds(user, pm);
      });
    });
    $effect(() => {
      const user = viewAddress();
      const perDex = orderFeed.perDex;
      const dexes = perDex ? ['', ...meta.dexes.map((d) => d.name)] : [];
      if (user) return untrack(() => orderFeeds(user, perDex, dexes));
    });
    $effect(() => {
      const user = viewAddress();
      void socket.reconnects;
      if (!user) return;
      let [stop, timer] = [false, 0];
      const seed = (): Promise<void> =>
        seedFills(user).catch((e) => {
          console.warn('fill seed failed, asking again soon', e);
          if (!stop) timer = window.setTimeout(seed, 15_000 + Math.random() * 15_000);
        });
      untrack(() => {
        fills.seeded = false;
        void seed();
        void reconcileAll();
      });
      return () => ((stop = true), clearTimeout(timer));
    });
    $effect(() => {
      const user = viewAddress();
      if (!user || spotName(market.coin)) return;
      return socket.subscribe({ type: 'activeAssetData', user, coin: market.coin }, safe('activeAssetData', applyAssetData));
    });
    const marks = $derived(spotCoins());
    $effect(() => {
      const coins = marks ? marks.split(',') : [];
      return untrack(() => {
        const offs = coins.map((coin) => socket.subscribe({ type: 'activeAssetCtx', coin }, safe('spot ctx', applySpotCtx)));
        return () => offs.forEach((off) => off());
      });
    });
    $effect(() => {
      const user = viewAddress();
      untrack(() => void loadFees(user));
    });
  });
}
