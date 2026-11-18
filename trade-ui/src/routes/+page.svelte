<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount, untrack, type Component } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { rateLimited, socket } from '$lib/transport/ws.svelte';
  import { dexOf, isSpot, kindOf, listed, loadHip3, loadMeta, loadSpot, meta, nameOf, relist, restoreMeta, spotStale } from '$lib/market/meta.svelte';
  import { startMarketFeeds } from '$lib/market/watch.svelte';
  import { startAccountFeeds } from '$lib/account/watch.svelte';
  import { inventory } from '$lib/account/inventory.svelte';
  import { openOrders } from '$lib/account/orders.svelte';
  import { initSession, session, startRecheck, viewAddress } from '$lib/session/session.svelte';
  import { takeLinkFragment } from '$lib/session/link';
  import { market, restoreCoin, selectCoin } from '$lib/market/market.svelte';
  import { topChips } from '$lib/market/views.svelte';
  import { fmtPx } from '$lib/util/format';
  import { chases } from '$lib/orders/chase.svelte';
  import { BOOK_MIN, DEFAULTS, PANEL_MIN, persist, settings, type Layout, type PhoneTab } from '$lib/settings/settings.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { modal, ui } from '$lib/ui/state.svelte';
  import { cards } from '$lib/ui/tables.svelte';
  import { applyDisplay } from '$lib/ui/display.svelte';
  import TopBar from '$lib/ui/TopBar.svelte';
  import QuickMarkets from '$lib/ui/QuickMarkets.svelte';
  import Chart from '$lib/ui/Chart.svelte';
  import MiniChart from '$lib/ui/chart/MiniChart.svelte';
  import BookTabs from '$lib/ui/BookTabs.svelte';
  import Trades from '$lib/ui/Trades.svelte';
  import Connection from '$lib/ui/Connection.svelte';
  import Devices from '$lib/ui/Devices.svelte';
  import StatusBar from '$lib/ui/StatusBar.svelte';
  import Toasts from '$lib/ui/Toasts.svelte';
  import Fx from '$lib/ui/Fx.svelte';
  import HelpTip from '$lib/ui/HelpTip.svelte';
  import MarketPicker from '$lib/ui/MarketPicker.svelte';
  import QuickPicker from '$lib/ui/QuickPicker.svelte';
  import IntervalPicker from '$lib/ui/chart/IntervalPicker.svelte';
  import OrderPanel from '$lib/ui/order/OrderPanel.svelte';
  import LeverageModal from '$lib/ui/order/LeverageModal.svelte';
  import MarginModal from '$lib/ui/order/MarginModal.svelte';
  import AdjustMarginModal from '$lib/ui/order/AdjustMarginModal.svelte';
  import PositionTpslModal from '$lib/ui/order/PositionTpslModal.svelte';
  import CloseModal from '$lib/ui/order/CloseModal.svelte';
  import ReverseModal from '$lib/ui/order/ReverseModal.svelte';
  import TrailingModal from '$lib/ui/order/TrailingModal.svelte';
  import EditOrderModal from '$lib/ui/order/EditOrderModal.svelte';
  import AccountTabs from '$lib/ui/AccountTabs.svelte';
  import Account from '$lib/ui/Account.svelte';
  import OrderBook from '$lib/ui/OrderBook.svelte';
  import { MAX_ROWS } from '$lib/market/book.svelte';
  import { activateAction, startHotkeys } from '$lib/hotkeys/dispatch';
  import { startArmWatch } from '$lib/hotkeys/armed.svelte';
  import Divider from '$lib/ui/Divider.svelte';
  import ZenStrip from '$lib/ui/ZenStrip.svelte';
  import { inZen, setZen } from '$lib/ui/zen';
  import { notePress, tabStops } from '$lib/ui/touch';
  import { startExtremes } from '$lib/ui/chart/extremes.svelte';
  import { startAgent } from '$lib/agent/agent.svelte';

  // Rarely opened, so they load on first use; warmed once the page settles, since a deploy removes the old chunks a long-open tab would ask for.
  function later(load: () => Promise<{ default: Component<any> }>) {
    let p: Promise<Component<any>> | undefined;
    return (quiet = false) =>
      (p ??= load().then((m) => m.default)).catch((e: Error) => {
        p = undefined;
        if (!quiet) (ui.overlay = null), toast.error(`${e.message} — reload the page`);
        throw e;
      });
  }
  const lazy = {
    help: later(() => import('$lib/hotkeys/Help.svelte')),
    migration: later(() => import('$lib/settings/Migration.svelte')),
    settings: later(() => import('$lib/hotkeys/Settings.svelte')),
    link: later(() => import('$lib/ui/LinkModal.svelte')),
    linkScan: later(() => import('$lib/ui/LinkScan.svelte')),
    linkImport: later(() => import('$lib/ui/LinkImport.svelte')),
    sweep: later(() => import('$lib/ui/Sweep.svelte')),
    aiConnect: later(() => import('$lib/ui/ai/AiConnectModal.svelte'))
  };

  // A link opened in a tab already on the app is a same-document hash change, not a load.
  let linkBlob = $state('');
  function showLink(blob: string) {
    linkBlob = blob;
    ui.overlay = 'linkImport';
  }
  function takeLink() {
    const blob = takeLinkFragment();
    if (blob) showLink(blob);
  }
  if (browser) takeLink();
  restoreMeta();
  restoreCoin(false);

  let retry: ReturnType<typeof setTimeout> | undefined;
  // A HIP-3 or spot coin is left to restoreCoin once its list is read.
  const fallBack = (coin: string) => {
    const a = meta.byName.get(coin);
    if (kindOf(coin) !== 'perp' || (a && !a.isDelisted)) return;
    selectCoin('BTC');
    toast.error(`${coin} is no longer listed — showing BTC`);
  };
  const listMarkets = (tries = 0): Promise<unknown> =>
    loadMeta()
      .then(() => fallBack(market.coin))
      .catch((e) => {
        if (!tries && !rateLimited(e)) toast.error(`market list failed: ${e.message} (retrying)`);
        else console.warn(`market list retry ${tries} failed`, e);
        retry = setTimeout(() => listMarkets(tries + 1), Math.min(60_000, 5_000 * 2 ** tries));
      });
  let spotRetry: ReturnType<typeof setTimeout> | undefined;
  const listSpot = (force = false, tries = 0): Promise<unknown> =>
    loadSpot(force)
      .catch((e) => {
        if (!tries && !rateLimited(e)) toast.error(`Spot markets off: ${e.message}`);
        else console.warn(`spot list retry ${tries} failed`, e);
        spotRetry = setTimeout(() => listSpot(force, tries + 1), Math.min(60_000, 5_000 * 2 ** tries));
      })
      .finally(() => {
        const gone = restoreCoin(true, 'spot');
        if (gone) toast.error(`${gone} ${meta.spotState === 'off' ? 'needs spot markets' : 'is no longer listed'} — showing ${market.coin}`);
      });
  const listHip3 = () =>
    loadHip3()
      .catch((e) => toast.error(`HIP-3 markets off: ${e.message}`))
      .finally(() => {
        const gone = restoreCoin(true, 'hip3');
        if (gone) toast.error(`${gone} ${meta.hip3 === 'off' ? 'needs HIP-3' : 'is no longer listed'} — showing ${market.coin}`);
      });

  /** The on-screen keyboard's height: --kb lifts the phone's dialogs and Place clear of it, less --below, what sits under the order form's scroller. */
  function trackKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const set = () => {
      if (vv.scale !== 1) return;
      const kb = innerHeight - vv.height - vv.offsetTop;
      document.documentElement.toggleAttribute('data-keyboard', kb >= 100);
      const scroller = document.querySelector('[data-testid="panel"]')?.closest('.trade-body, .zen .mobile-trade, .phone');
      const below = scroller ? innerHeight - scroller.getBoundingClientRect().bottom : 0;
      document.documentElement.style.setProperty('--kb', `${kb < 100 ? 0 : kb}px`);
      document.documentElement.style.setProperty('--below', `${below}px`);
      const input = document.activeElement;
      if (kb < 100 || !(scroller instanceof HTMLElement) || !(input instanceof HTMLElement) || !input.matches('input, select, textarea') || !scroller.contains(input)) return;
      const place = scroller.querySelector('[data-testid="panel-submit"]')?.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      const top = Math.max(scroller.getBoundingClientRect().top, vv.offsetTop) + 8;
      const bottom = Math.min(place ? place.top - 8 : Infinity, vv.offsetTop + vv.height);
      if (field.bottom > bottom) scroller.scrollTop += field.bottom - bottom;
      else if (field.top < top) scroller.scrollTop -= top - field.top;
    };
    set();
    vv.addEventListener('resize', set);
    vv.addEventListener('scroll', set);
    document.addEventListener('focusin', set);
    return () => {
      vv.removeEventListener('resize', set);
      vv.removeEventListener('scroll', set);
      document.removeEventListener('focusin', set);
      document.documentElement.removeAttribute('data-keyboard');
    };
  }

  let interactive = $state(false);
  onMount(() => {
    interactive = true;
    socket.connect();
    const stops = [startMarketFeeds(), startAccountFeeds(), startHotkeys(), startArmWatch(), startExtremes(), startAgent(), startRecheck(), trackKeyboard()];
    initSession().catch((e) => toast.error(e.message)).finally(() => { if (!viewAddress()) listsDue = true; });
    const due = setTimeout(() => (listsDue = true), LISTS_MS);
    const wake = () => { if (!document.hidden) socket.wake(); };
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
    const warm = setTimeout(() => {
      for (const [name, load] of Object.entries(lazy)) {
        if (name === 'linkScan' && !phone.current && !session.linked) continue;
        load(true).catch(() => {});
      }
    }, 3000);
    const noPinch = (e: Event) => { if (cards.current) e.preventDefault(); };
    document.addEventListener('gesturestart', noPinch);
    const guard = (e: BeforeUnloadEvent) => chases.list.some((c) => c.state !== 'stopped') && e.preventDefault();
    addEventListener('beforeunload', guard);
    return () => {
      clearTimeout(due);
      document.removeEventListener('visibilitychange', wake);
      removeEventListener('online', wake);
      clearTimeout(warm);
      clearTimeout(retry);
      clearTimeout(spotRetry);
      removeEventListener('beforeunload', guard);
      document.removeEventListener('gesturestart', noPinch);
      stops.forEach((stop) => stop());
      socket.close();
    };
  });

  $effect(() => applyDisplay());

  function fitSummary(el: HTMLElement) {
    void [settings.display.fs, settings.display.theme, tall];
    const over = (e: Element) => e.scrollWidth > e.clientWidth;
    // A nowrap .wide row can spill into the block's padding without widening the scroller.
    const fits = (px = 0) => (px ? el.style.setProperty('--fs', `${px}px`) : el.style.removeProperty('--fs'), !over(el) && ![...el.querySelectorAll('.wide')].some(over));
    const run = () => {
      if (fits()) return;
      let lo = 8, hi = parseFloat(getComputedStyle(el).getPropertyValue('--fs'));
      while (hi - lo > 0.25) {
        const mid = Math.round((lo + hi) * 2) / 4;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      fits(lo);
    };
    let frame = 0;
    const fit = () => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(run)));
    const ro = new ResizeObserver(fit), mo = new MutationObserver(fit);
    ro.observe(el);
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    document.fonts.addEventListener('loadingdone', fit);
    return () => (cancelAnimationFrame(frame), ro.disconnect(), mo.disconnect(), document.fonts.removeEventListener('loadingdone', fit));
  }

  // One socket answers in turn, so a big list sent first holds up the account behind it: the lists wait for the first account frame, or LISTS_MS at most.
  const LISTS_MS = 1500;
  let listsDue = $state(false);
  const accountFirst = $derived(listsDue || inventory.loaded);

  let marketsAsked = false;
  $effect(() => {
    if (!accountFirst || marketsAsked) return;
    marketsAsked = true;
    untrack(listMarkets);
  });

  // Over the socket, not REST at load: REST info weight is capped per IP and the page already spends it on the main list.
  let hip3Asked = false;
  $effect(() => {
    if (socket.state !== 'open' || hip3Asked || !accountFirst) return;
    hip3Asked = true;
    untrack(() => (listHip3(), listSpot()));
  });

  // A warm load shows its cached lists without reading them; a tab that can trade reads them, as an order is signed only from a list read this session.
  $effect(() => {
    if (accountFirst && session.agent && session.holdsSigner && socket.state === 'open' && relist()) untrack(() => (listMarkets(), listHip3()));
  });
  $effect(() => {
    if (accountFirst && session.agent && session.holdsSigner && socket.state === 'open' && spotStale()) untrack(() => listSpot(true));
  });

  const phone = new MediaQuery('max-width: 900px');
  /** Extra charts shown beside the main one: none on a phone. */
  const panes = $derived(phone.current ? 0 : settings.chart.panes.length);
  const zen = $derived(inZen());
  const dex = $derived(dexOf(market.coin));
  const banner = $derived(!zen && !!dex && !settings.dismissedDexes.includes(dex));
  function dismissDex(e: MouseEvent) {
    (e.currentTarget as HTMLElement).blur();
    settings.dismissedDexes = [...settings.dismissedDexes, dex];
    persist();
  }
  let connected = false;
  $effect(() => {
    const now = !!session.master;
    if (connected && !now) untrack(() => settings.display.zen && setZen(false));
    connected = now;
  });
  function pickTab(e: MouseEvent, tab: 'trade' | 'ai') {
    if (e.detail) (e.currentTarget as HTMLElement).blur();
    ui.panelTab = tab;
    settings.display.minimized.trade = false;
    persist();
  }
  const tab = $derived(settings.display.phoneTab);
  // iOS keeps a field's caret and selection handles on screen when the field is hidden or removed while focused,
  // so a tab switch or a sheet opening or closing lets go of the field first. A sheet closed and reopened at once
  // (the palette arming a command) keeps its field.
  let seen: [unknown, unknown] = [settings.display.phoneTab, ui.overlay];
  $effect.pre(() => {
    if (tab === seen[0] && ui.overlay === seen[1]) return;
    seen = [tab, ui.overlay];
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !el.matches('input, textarea, [contenteditable="true"]')) return;
    el.blur();
    getSelection()?.removeAllRanges();
  });
  // The phone chart mounts on its first visit, not with the page, and then stays. Its mount is the page's heaviest task, so at load it waits for the account.
  let phoneChart = $state(false);
  $effect(() => {
    if (tab === 'market' && ui.marketTab === 'chart' && accountFirst) phoneChart = true;
  });
  const PHONE_TABS: [PhoneTab, string][] = [['market', 'Market'], ['trade', 'Trade'], ['account', 'Account']];
  const SEGMENTS: [typeof ui.marketTab, string][] = [['chart', 'Chart'], ['book', 'Book'], ['trades', 'Trades']];
  function pickPhoneTab(e: MouseEvent, t: PhoneTab) {
    if (e.detail) (e.currentTarget as HTMLElement).blur();
    settings.display.phoneTab = t;
    document.querySelector('[data-testid="phone"]')?.scrollTo({ top: 0 });
    persist();
  }

  const CHART_MIN = 320, TOP_MIN = 320, BOTTOM_MIN = 140, SUMMARY_MIN = 140;
  let gridW = $state(0), gridH = $state(0), vh = $state(0), bannerH = $state(0);
  let sidebarH = $state(0), sidebarTradeH = $state(0), phoneH = $state(0);
  const quickCoins = $derived(topChips());
  const quickRow = $derived(!zen && quickCoins.length > 0);
  const ticketH = $derived(180 + 33 * settings.display.fs);
  const portrait = new MediaQuery('max-aspect-ratio: 3/4');
  const tall = $derived(!phone.current && !zen && portrait.current && vh >= 1440 && (gridH + (banner ? bannerH : 0)) * 0.7 >= ticketH + Math.round(vh * 0.2));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  // Measured on every window resize, so a size saved on a wider screen shrinks to fit without being overwritten.
  function fit(l: Layout): Layout {
    const cols = gridW ? gridW - 2 - CHART_MIN : Infinity;
    const widths = (book: number, panel: number) => {
      const p = clamp(panel, PANEL_MIN, cols - BOOK_MIN);
      return [clamp(book, BOOK_MIN, cols - p), p];
    };
    const [book, panel] = widths(l.book, l.panel);
    // Tall portrait stacks the book above the ticket in one column, so only that column's width is kept.
    const tallPanel = clamp(l.tallPanel || Math.round(gridW * 0.25), PANEL_MIN, cols);
    const rows = gridH ? gridH - 2 - Math.max(TOP_MIN, ticketH) : Infinity;
    const tallMid = tall ? clamp(l.tallMid || Math.round(vh * 0.18), SUMMARY_MIN, rows - BOTTOM_MIN) : l.tallMid;
    const tallBottom = tall ? clamp(l.tallBottom || Math.round(vh * 0.2), BOTTOM_MIN, rows - tallMid) : l.tallBottom;
    const bottom = clamp(l.bottom || Math.round(vh * 0.36), BOTTOM_MIN, gridH ? gridH - 1 - TOP_MIN : Infinity);
    const sidebarMin = Math.min(SUMMARY_MIN, sidebarH / 2);
    const sidebarTrade = sidebarH ? Math.floor(clamp(l.sidebarTrade || sidebarTradeH, sidebarMin, sidebarH - sidebarMin)) : l.sidebarTrade;
    const phoneReserve = phoneH < 400 ? 38 : Math.min(160, phoneH * 0.22);
    // The phone chart is fixed at its largest, leaving the account tabs and a first row below; nothing resizes it.
    const phone = phoneH ? Math.floor(Math.max(Math.min(300, Math.max(140, phoneH * 0.55)), phoneH - phoneReserve)) : 0;
    return { panel, book, bottom, sidebarTrade, phone, tallBook: l.tallBook, tallPanel, tallMid, tallBottom };
  }
  const lay = $derived(fit(settings.display.layout));
  const K = $derived(tall ? ({ book: 'tallBook', panel: 'tallPanel', bottom: 'tallBottom' } as const) : ({ book: 'book', panel: 'panel', bottom: 'bottom' } as const));
  const bottomH = $derived(settings.display.minimized.positions ? 34 : lay[K.bottom]);
  const min = $derived(settings.display.minimized);
  const summaryH = $derived(min.account ? 34 : lay.tallMid);
  const zenOpen = $derived(settings.display.zenOpen);
  const shown = $derived({ book: !zen || zenOpen.book, panel: !zen || zenOpen.order, account: !zen || zenOpen.positions });
  const top = $derived(['chart', ...(shown.book ? ['book'] : []), ...(shown.panel ? ['panel'] : [])]);
  const areas = $derived(tall ? "'summary summary' 'chart book' 'chart panel' 'account account'" : [top, ...(shown.account ? [top.map((a) => (a === 'panel' && !zen ? a : 'account'))] : [])].map((r) => `'${r.join(' ')}'`).join(' '));
  const panelW = $derived(tall ? (min.book && min.trade ? 28 : lay.tallPanel) : min.trade ? 28 : lay[K.panel]);
  const columns = $derived(tall ? `minmax(0, 1fr) ${panelW}px` : top.map((a, i) => (i === 0 ? 'minmax(0, 1fr)' : `${a === 'chart' ? 28 : a === 'book' ? (min.book ? 28 : lay[K.book]) : panelW}px`)).join(' '));
  let from = DEFAULTS.display.layout;
  const begin = () => (from = lay);
  function resize(patch: Partial<Layout>) {
    const next = fit({ ...lay, ...patch });
    for (const k of Object.keys(patch) as (keyof Layout)[]) settings.display.layout[k] = next[k];
  }
  function split(d: number) {
    const { book: b, panel: p } = K;
    const panel = clamp(from[p] - d, PANEL_MIN, from[p] + from[b] - BOOK_MIN);
    resize({ [p]: panel, [b]: from[b] + from[p] - panel });
  }
  function reset(k: keyof Layout) {
    settings.display.layout[k] = DEFAULTS.display.layout[k];
    persist();
  }

  $effect(() => {
    if ((ui.overlay !== 'leverage' && ui.overlay !== 'margin') || !meta.loaded || (meta.byName.has(market.coin) && !isSpot(market.coin))) return;
    ui.overlay = null;
    toast.error(`${market.coin} is not in the perp market list`);
  });
  const m = $derived(modal());
  const editing = $derived(m?.kind === 'editOrder' ? openOrders.list.find((o) => o.oid === m.oid && listed(o.coin)) : undefined);
  // The modal unmounts with its order before its own close runs, and a spot order never mounts it; either would leave hotkeys blocked.
  $effect(() => {
    if (m?.kind === 'editOrder' && !editing) ui.overlay = null;
  });
  const tabContext = $derived(market.ctx ?? meta.ctxs.get(market.coin));
  const tabPrice = $derived(tabContext && Number.isFinite(tabContext.markPx) && tabContext.markPx > 0 ? fmtPx(tabContext.markPx, meta.byName.get(market.coin)?.szDecimals, isSpot(market.coin)) : '');
  const tabTicker = $derived(market.coin.includes(':') ? `${market.coin.split(':')[1]} (${market.coin.split(':')[0]})` : nameOf(market.coin));
</script>

<svelte:head><title>{tabPrice ? `${tabPrice} | ` : ''}{tabTicker} | Get Liquidated</title></svelte:head>

<svelte:window onhashchange={takeLink} onkeydown={tabStops} onpointerdowncapture={notePress} bind:innerHeight={vh} />

<div class="app" inert={!interactive} class:zen class:banner data-zen={zen} data-testid="app" style:--toast-bottom={tall ? `${Math.max(0, gridH - summaryH) + 32 + 3 * settings.display.fs}px` : null} style:--toast-top={tall ? '8px' : null}>
  <div class="topbar"><TopBar /></div>
  {#if banner}
    <p class="hip3" data-testid="hip3-banner" bind:offsetHeight={bannerH}>
      <span>Deployed by {dex}, independently of Hyperliquid; liquidity may be thin.</span>
      <button aria-label="Dismiss for {dex}" data-testid="hip3-banner-dismiss" onclick={dismissDex}>✕</button>
    </p>
  {/if}
  {#if zen}
    <ZenStrip />
  {/if}
  {#if phone.current}
    <main class="phone" data-testid="phone" data-tab={zen ? 'zen' : tab} bind:clientHeight={phoneH}>
      {#if zen}
        <section class="chart"><Chart /></section>
        {#if zenOpen.book}<section class="zen-book"><OrderBook /></section>{/if}
        {#if zenOpen.positions}<section class="account" class:minimized={settings.display.minimized.positions}><AccountTabs /></section>{/if}
      {:else}
        <!-- The chart stays mounted, hidden, on other tabs and segments, so coming back keeps its pan/zoom without a rebuild or a candle refetch. -->
        <section class="market" class:full={settings.display.minimized.positions} data-testid="phone-market" style:flex-basis={!min.positions && phoneH ? `${lay.phone}px` : null} hidden={tab !== 'market'}>
          <nav class="side-tabs ui-tabs segments">
            {#each SEGMENTS as [id, label] (id)}
              <button class="ui-tab" class:on={ui.marketTab === id} aria-pressed={ui.marketTab === id} data-testid="market-seg-{id}" onclick={(e) => ((ui.marketTab = id), e.detail && e.currentTarget.blur())}>{label}</button>
            {/each}
          </nav>
          <div class="pane" hidden={ui.marketTab !== 'chart'}>{#if phoneChart}<Chart />{/if}</div>
          {#if tab === 'market' && ui.marketTab !== 'chart'}<div class="pane" class:trades={ui.marketTab === 'trades'}>{#if ui.marketTab === 'book'}<OrderBook totals onpick={() => { settings.display.phoneTab = 'trade'; persist(); }} />{:else}<Trades />{/if}</div>{/if}
        </section>
        {#if tab === 'market'}<section class="positions" data-testid="phone-positions" class:minimized={settings.display.minimized.positions}><AccountTabs /></section>{/if}
        {#if tab === 'account'}
          <section class="me" data-testid="phone-account"><Connection />{#if viewAddress()}<Account /><div class="positions" class:minimized={settings.display.minimized.positions}><AccountTabs /></div><div class="devices"><Devices /></div>{/if}<StatusBar /></section>
        {/if}
      {/if}
      <!-- One panel stays mounted on every tab: its coin-switch clear and typed scale/chase/TP-SL text live in the component. -->
      <div class="mobile-trade" class:shown={zen ? zenOpen.order : tab === 'trade'}>
        <section class="trade-form">{#if quickRow && tab === 'trade'}<QuickMarkets coins={quickCoins} />{/if}<OrderPanel /></section>
        {#if !zen && tab === 'trade'}<section class="trade-book"><OrderBook rowRange={[7, MAX_ROWS]} /></section>{/if}
      </div>
      {#if !zen && tab === 'trade'}<section class="positions" data-testid="phone-positions" class:minimized={settings.display.minimized.positions}><AccountTabs /></section>{/if}
    </main>
    {#if !zen}
      <nav class="tabbar ui-tabs" data-testid="phone-tabs">
        {#each PHONE_TABS as [id, label] (id)}
          <button class="ui-tab" class:on={tab === id} aria-pressed={tab === id} data-testid="phone-tab-{id}" onclick={(e) => pickPhoneTab(e, id)}>
            {label}
          </button>
        {/each}
      </nav>
    {/if}
  {:else}
    <main
      class="grid" class:tall bind:clientWidth={gridW} bind:clientHeight={gridH}
      style:grid-template-columns={columns} style:grid-template-rows={tall ? `${summaryH}px ${min.book ? 'auto minmax(0, 1fr)' : 'minmax(120px, 1fr) minmax(0, auto)'} ${bottomH}px` : shown.account ? `minmax(0, 1fr) ${bottomH}px` : 'minmax(0, 1fr)'} style:grid-template-areas={areas}
    >
      <section class="chart charts" class:multi={panes > 0} data-testid="charts">
        <div class="main" style:grid-row="1 / span {Math.max(1, panes)}"><Chart /></div>
        {#if panes}{#each settings.chart.panes as _, i (i)}<MiniChart index={i} />{/each}{/if}
      </section>
      <section class="book" class:shut={!shown.book}>{#if shown.book}<BookTabs flat={tall && !min.trade} />{/if}</section>
      <section class="panel" class:shut={!shown.panel} class:folded={settings.display.minimized.trade} class:flat={tall && !min.book} bind:clientHeight={sidebarH}>
        <div class="trade-section" class:minimized={settings.display.minimized.trade} bind:clientHeight={sidebarTradeH} style:flex={!tall && !min.trade && settings.display.layout.sidebarTrade ? `0 0 ${lay.sidebarTrade}px` : null}>
        <nav class="side-tabs ui-tabs">
          {#if !settings.display.minimized.trade}
          <button class="ui-tab" class:on={true} aria-pressed="true" data-testid="side-tab-trade" onclick={(e) => pickTab(e, 'trade')}>Trade</button>
          {/if}
          <button class="minimize" data-testid="minimize-trade" aria-label={`${settings.display.minimized.trade ? 'Expand' : 'Minimize'} ${tall ? 'trade' : 'trade and account'}`} aria-expanded={!settings.display.minimized.trade} onclick={() => { settings.display.minimized.trade = !settings.display.minimized.trade; persist(); }}>{settings.display.minimized.trade ? '+' : '−'}{#if settings.display.minimized.trade}<span class="fold-label">Trade</span>{/if}</button>
        </nav>
        <div class="trade-body" hidden={settings.display.minimized.trade}>
        <OrderPanel />
        </div></div>
        <div class="account-summary" class:minimized={tall && settings.display.minimized.account} hidden={settings.display.minimized.trade && !tall}>
          {#if tall}<button class="account-heading" data-testid="minimize-account" aria-expanded={!settings.display.minimized.account} onclick={() => { settings.display.minimized.account = !settings.display.minimized.account; persist(); }}><span>Account</span><span>{settings.display.minimized.account ? '+' : '−'}</span></button>{:else}<div class="account-heading">Account</div>{/if}
          <div class="summary-body" hidden={tall && settings.display.minimized.account} {@attach fitSummary}><Account /></div>
        </div>
        {#if !tall && !min.trade}<Divider axis="y" label="Resize trade and account" value={lay.sidebarTrade} style="top: {sidebarTradeH - 3}px; right: 0" start={begin} move={(d) => resize({ sidebarTrade: from.sidebarTrade + d })} end={persist} reset={() => reset('sidebarTrade')} />{/if}
      </section>
      <section class="account" class:shut={!shown.account}><AccountTabs /></section>
      {#if !zen}
        {@const band = tall ? `top: ${summaryH + 1}px; bottom: ${bottomH + 1}px; ` : 'top: 0; '}
        {#if !tall && !settings.display.minimized.book}<Divider axis="x" label="Resize order book" value={lay[K.book]} style="right: {lay[K.book] + panelW - 2}px; bottom: {bottomH + 1}px; {band}" start={begin} move={(d) => resize({ [K.book]: from[K.book] - d })} end={persist} reset={() => reset(K.book)} />{/if}
        {#if panelW > 28}<Divider axis="x" label="Resize order book and order panel" value={lay[K.panel]} style="{band}right: {panelW - 3}px" start={begin} move={tall ? (d) => resize({ tallPanel: from.tallPanel - d }) : split} end={persist} reset={() => reset(K.panel)} />{/if}
        {#if !settings.display.minimized.positions}<Divider axis="y" label="Resize account tabs" value={lay[K.bottom]} style="bottom: {lay[K.bottom] - 3}px; right: {tall ? 0 : panelW + 1}px" start={begin} move={(d) => resize({ [K.bottom]: from[K.bottom] - d })} end={persist} reset={() => reset(K.bottom)} />{/if}
        {#if tall && !min.account}<Divider axis="y" label="Resize account summary" value={lay.tallMid} style="top: {summaryH - 3}px; right: 0" start={begin} move={(d) => resize({ tallMid: from.tallMid + d })} end={persist} reset={() => reset('tallMid')} />{/if}
      {/if}
    </main>
  {/if}
  {#if !phone.current && !zen}<StatusBar />{/if}
  {#if !ui.chartFull}<Toasts />{/if}
  <Fx />
  <HelpTip />
  {#if !ui.chartFull && (ui.overlay === 'picker' || ui.overlay === 'compare')}<MarketPicker compare={ui.overlay === 'compare'} />{/if}
  {#if ui.overlay === 'interval'}<IntervalPicker />{/if}
  {#if ui.overlay === 'quick'}<QuickPicker />{/if}
  {#if ui.overlay === 'help'}{#await lazy.help() then Help}<Help activate={activateAction} />{:catch}{/await}{/if}
  {#if ui.overlay === 'migration'}{#await lazy.migration() then Migration}<Migration />{:catch}{/await}{/if}
  {#if ui.overlay === 'settings'}{#await lazy.settings() then Settings}<Settings />{:catch}{/await}{/if}
  {#if ui.overlay === 'leverage' && listed(market.coin) && !isSpot(market.coin)}<LeverageModal />{/if}
  {#if ui.overlay === 'margin' && listed(market.coin) && !isSpot(market.coin)}<MarginModal />{/if}
  {#if m?.kind === 'isoMargin' && listed(m.coin)}<AdjustMarginModal coin={m.coin} />{/if}
  {#if m?.kind === 'positionTpsl' && listed(m.coin)}<PositionTpslModal coin={m.coin} focus={m.focus} />{/if}
  {#if m?.kind === 'close' && listed(m.coin)}<CloseModal coin={m.coin} limit={m.limit} />{/if}
  {#if m?.kind === 'reverse' && listed(m.coin)}<ReverseModal coin={m.coin} />{/if}
  {#if m?.kind === 'trailing' && listed(m.coin)}<TrailingModal coin={m.coin} />{/if}
  {#if editing}<EditOrderModal order={editing} />{/if}
  {#if ui.overlay === 'link'}{#await lazy.link() then LinkModal}<LinkModal />{:catch}{/await}{/if}
  {#if ui.overlay === 'linkScan'}{#await lazy.linkScan() then LinkScan}<LinkScan onlink={showLink} />{:catch}{/await}{/if}
  {#if ui.overlay === 'sweep'}{#await lazy.sweep() then Sweep}<Sweep />{:catch}{/await}{/if}
  {#if ui.overlay === 'aiConnect'}{#await lazy.aiConnect() then AiConnectModal}<AiConnectModal />{:catch}{/await}{/if}
  {#if ui.overlay === 'linkImport'}{#await lazy.linkImport() then LinkImport}{#key linkBlob}<LinkImport blob={linkBlob} />{/key}{:catch}{/await}{/if}
</div>

<style>
  .app {
    display: grid; grid-template-rows: auto 1fr auto; grid-template-columns: minmax(0, 1fr); height: 100vh;
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  .grid {
    display: grid; gap: 1px; background: var(--gutter); min-height: 0; position: relative;
  }
  .app.banner { grid-template-rows: auto auto 1fr auto; }
  .hip3 { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin: 0; padding: 3px 12px; border-bottom: 1px solid var(--line); color: var(--warn); font-size: max(8px, calc(var(--fs) * 0.917)); }
  .hip3 button { background: none; color: var(--dim); padding: 0 4px; }
  section { background: var(--panel); min-width: 0; min-height: 0; overflow: auto; }
  .chart { grid-area: chart; overflow: hidden; }
  .charts { display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); gap: 1px; background: var(--line); }
  .charts.multi { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  .charts .main { min-width: 0; min-height: 0; overflow: hidden; background: var(--panel); }
  .book { grid-area: book; display: flex; flex-direction: column; }
  .panel { grid-area: panel; position: relative; display: flex; flex-direction: column; overflow: hidden; }
  .trade-section { display: flex; flex-direction: column; min-height: 0; flex: 0 1 auto; }
  .trade-section.minimized { flex: 1; }
  .minimized .side-tabs { z-index: 6; flex: 1; min-height: 0; border-bottom: 0; }
  .trade-body { min-height: 0; overflow: auto; }
  .trade-body[hidden], .summary-body[hidden], .account-summary[hidden] { display: none; }
  .account-summary { flex: 1 1 0; min-height: min(140px, 50%); display: flex; flex-direction: column; border-top: 1px solid var(--line); }
  .account-summary.minimized { flex: none; min-height: 34px; }
  .account-heading { display: flex; justify-content: space-between; width: 100%; background: none; color: var(--dim); padding: 8px 10px; text-align: left; }
  .summary-body { overflow: auto; min-height: 0; scrollbar-gutter: stable; }
  .summary-body :global(.account-block) { border-top: 0; padding-top: 4px; }
  .summary-body :global(.account-block > h4:first-child) { display: none; }
  .minimize { margin-left: auto; }
  .grid.tall > .panel:not(.shut) { display: contents; }
  .tall .trade-section { grid-area: panel; background: var(--panel); overflow: hidden; }
  .tall .account-summary { grid-area: summary; background: var(--panel); border-top: 0; min-height: 0; }
  .tall .summary-body { flex: 1 1 0; }
  .tall .summary-body :global(.account-block) { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18em), 1fr)); align-items: start; gap: 14px 16px; }
  .tall .summary-body :global(.account-block > *) { min-width: 0; }
  .tall .summary-body :global(.account-block :is(h4, section)) { margin-top: 0; }
  .tall .summary-body :global(.account-block p) { contain: inline-size; }
  .folded .minimize { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; margin: 0; padding: 7px 2px; border-bottom: 0; }
  .fold-label { writing-mode: vertical-rl; white-space: nowrap; }
  .flat .minimize { flex-direction: row; padding: 5px 8px; }
  .flat .fold-label { writing-mode: horizontal-tb; }

  .account { grid-area: account; }
  .side-tabs { display: flex; position: sticky; top: 0; z-index: 1; background: var(--panel); border-bottom: 1px solid var(--line); }
  .side-tabs button { padding: 5px 8px; }
  .segments button { flex: 1; }
  @media (max-width: 900px) { .app { height: 100dvh; padding-bottom: 0; } }
  @media (max-height: 500px) { :global(html[data-keyboard]) .topbar { height: 0; overflow: hidden; visibility: hidden; } }
  .phone { display: flex; flex-direction: column; gap: 1px; min-height: 0; overflow-y: auto; background: var(--gutter); }
  @media (max-width: 900px), (pointer: coarse) and (max-height: 500px) {
    :global(html) { touch-action: pan-x pan-y; }
    .phone, .trade-body, .zen .mobile-trade { scroll-padding-bottom: calc(var(--ctl) + 20px + max(0px, var(--kb, 0px) - var(--below, 0px))); scrollbar-width: none; }
    .phone::-webkit-scrollbar, .trade-body::-webkit-scrollbar, .zen .mobile-trade::-webkit-scrollbar { display: none; }
  }
  .market { position: relative; flex: 0 0 clamp(300px, 62%, 600px); min-height: 0; display: flex; flex-direction: column; overflow: visible; }
  .market.full { flex: 1 1 0; }
  .market.full + .positions { flex: none; min-height: 0; }
  @media (pointer: coarse) and (max-height: 500px) { .market:not(.full) { flex-basis: max(160px, calc(100% - 38px)); } .app:has(.market.full:not([hidden])) > :is(.topbar, .tabbar) { height: 0; padding: 0; border: 0; overflow: hidden; } }
  .market .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .market .pane.trades { overflow-y: auto; }
  .market[hidden], .market .pane[hidden] { display: none; }
  .phone .account { flex: 1 0 160px; display: flex; flex-direction: column; }
  .positions { flex: 1 0 auto; display: flex; flex-direction: column; min-height: 220px; background: var(--panel); }
  .me .positions { flex: none; border-top: 1px solid var(--line); }
  .positions.minimized { min-height: 34px; }
  .positions :global(.tabs) { height: auto; }
  .positions :global(.body) { flex: none; }
  .mobile-trade:not(.shown) { display: none; }
  /* A scroll container here would catch Place's sticky, and it never scrolls itself. */
  .trade-form { overflow: clip visible; }
  .mobile-trade { flex: none; display: grid; grid-template-columns: minmax(0, 58fr) minmax(0, 42fr); gap: 1px; }
  .trade-book { display: flex; flex-direction: column; contain: size; overflow: hidden; }
  .me { flex: 1 0 auto; }
  .devices { padding: 12px 10px; border-top: 1px solid var(--line); }
  .tabbar { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding-bottom: env(safe-area-inset-bottom); background: var(--panel); border-top: 1px solid var(--line); }
  .tabbar button { height: 48px; }
  .app.zen { height: 100dvh; padding-bottom: env(safe-area-inset-bottom); }
  .zen > .topbar, .zen > :global(footer), .grid > .shut { display: none; }
  .zen .phone { position: relative; overflow: hidden; }
  .zen .phone > .chart { flex: 1; }
  .zen .phone > .zen-book { flex: 0 0 30%; display: flex; flex-direction: column; overflow: hidden; }
  .zen .phone > .account { flex: 0 0 34%; min-height: 150px; }
  .zen .mobile-trade { display: block; position: absolute; inset: 0 0 auto; max-height: 100%; overflow: auto; z-index: 4; }
  .zen .mobile-trade:not(.shown) { display: none; }
  .zen .phone > .account.minimized { flex: none; min-height: 0; }
  .zen .phone:has(> .account:not(.minimized)) .mobile-trade { max-height: min(66%, calc(100% - 150px)); }
</style>
