<script lang="ts">
  import { onMount } from 'svelte';
  import { array, barsOf, contractValue, dealKey, dealPnl, eligibleAccount, fresh, held, HISTORY, isResolution, journalOf, levelError, liveBar, marginFor, marketOf, maxContracts, mergeBars, orderKind, numeric, positionPnl, record, RESOLUTIONS, spread, spreadBps, text, type Bar, type Deal, type Detail, type Market, type Resolution, type Session } from '$lib/ig/markets';
  import IgChart, { type Line } from '$lib/ig/IgChart.svelte';
  import IgCopilot from '$lib/ig/IgCopilot.svelte';
  import SizeSlider from '$lib/ui/order/SizeSlider.svelte';
  import type { IgContext, Mark } from '../../../../agent/src/wire.ts';
  import BuildProof from '$lib/ui/BuildProof.svelte';
  import ThemePicker from '$lib/ui/ThemePicker.svelte';
  import { THEMES } from '$lib/settings/themes';
  import { load, save } from '$lib/util/storage';
  import { isTyping, tabNavigation, tabStops } from '$lib/ui/touch';
  import { fmtNum } from '$lib/util/format';

  class ApiError extends Error {
    status: number; deliveryStatus: string;
    constructor(status: number, message: string, deliveryStatus = '') { super(message); this.status = status; this.deliveryStatus = deliveryStatus; }
  }
  type Job = { path: 'order' | 'cancel'; label: string; payload: Record<string, unknown>; why?: string };
  type Pending = { dealId?: string; id: string; accountId: string; environment: 'live'; reference?: string; status: string; message: string };
  type Ticket = 'market' | 'limit' | 'stop' | 'scale';
  type Draft = { direction: 'BUY' | 'SELL'; size: string; currency: string; stop: string; takeProfit: string; level: string; type: Ticket };
  type View = { market: Market; detail: Detail | null; res: Resolution; bars: Bar[]; live: Bar | null; pricesAt: number; at: number; busy: boolean; tried: boolean; note: string; draft: Draft | null };
  const MAX_VIEWS = 8, GRID = 4, MAX_WATCH = 50, MAX_CACHED = 12, AVERAGES = [7, 30, 99], POLL = 12_000;
  let connection = 0, browseRequest = 0, hydrated = $state(false);
  let session = $state<Session | null>(null);
  let loading = $state(false), connected = $state(false), error = $state(''), notice = $state('');
  let login = $state(false), apiKey = $state(''), identifier = $state(''), password = $state('');
  let keyConfigured = $state(false), keySetup = $state(false), continueLogin = $state(false);
  const environment = 'live';
  const usernameError = $derived(identifier && !/^[A-Za-z0-9_-]{1,30}$/.test(identifier) ? identifier.includes('@') ? 'Use your IG trading username. IG’s API does not accept email addresses.' : 'Use 1–30 letters, numbers, hyphens or underscores from your IG username.' : '');
  const openLogin = () => { error = ''; keySetup = !keyConfigured; continueLogin = true; login = true; };
  const openKey = () => { error = ''; apiKey = ''; password = ''; keySetup = true; continueLogin = false; login = true; };
  const closeLogin = () => { if (!loading) { login = false; apiKey = ''; password = ''; error = ''; } };
  function dialogKey(e: KeyboardEvent) { if (login && !loading && e.key === 'Escape') { e.preventDefault(); closeLogin(); return; } tabStops(e); }
  function focusLogin(node: HTMLElement) {
    if (!login) return;
    const previous = document.activeElement;
    node.querySelector<HTMLInputElement>(keySetup ? '#ig-api-key' : '#ig-username')?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }
  let query = $state(''), nodes = $state<{ id: string; name: string }[]>([]), trail = $state<{ id: string; name: string }[]>([]), markets = $state<Market[]>([]);
  let listError = $state(''), category = $state('all'), sameExpiry = $state(true), ranking = $state<'bps' | 'points' | 'name'>('bps'), source = $state<'browse' | 'watch'>('browse');
  let now = $state(Date.now()), fetched = $state(0), searching = $state(''), searchTimer: ReturnType<typeof setTimeout> | undefined;
  let views = $state<View[]>([]), active = $state(''), layout = $state<'single' | 'grid'>('single'), innerWidth = $state(1440);
  let watchlist = $state<Market[]>([]), quotes = $state<Record<string, Market>>({});
  const inflight = new Map<string, Promise<void>>();
  let averages = $state(true), allowance = $state<{ remaining: number | null; total: number | null } | null>(null);
  const view = $derived(views.find(v => v.market.epic === active));
  const selected = $derived(view?.detail ?? null);
  const account = $derived(session?.accounts.find(a => a.id === session?.accountId));
  const busyMarket = $derived(!!view?.busy);
  let accountExpanded = $state(false);
  const grid = $derived(layout === 'grid' && innerWidth > 900);
  const shown = $derived.by(() => {
    if (!grid) return view ? [view] : [];
    const first = views.slice(0, GRID);
    return !view || first.includes(view) ? first : [...first.slice(0, GRID - 1), view];
  });
  let direction = $state<'BUY' | 'SELL'>('BUY'), size = $state(''), currency = $state('SGD'), stop = $state(''), takeProfit = $state(''), level = $state(''), scaleTo = $state(''), scaleCount = $state(''), scaleSkew = $state('');
  let ticketType = $state<Ticket>('market'), exitUnit = $state<'pts' | 'price'>('pts'), trailStep = $state(''), guaranteed = $state(false), sizeUnit = $state<'contracts' | 'value'>('contracts'), valueText = $state(''), skipReview = $state(false), remember = $state(false);
  const TICKETS = [['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop'], ['scale', 'Scale']] as const;
  const levels = $derived(ticketType === 'market' ? [] : level.split(/[\s,]+/).filter(Boolean).map(Number));
  const kind = $derived(selected && levels[0] > 0 ? orderKind(direction === 'BUY', levels[0], selected.market) : '');
  const scaling = $derived(ticketType === 'scale');
  const typeError = $derived(!selected || !(levels[0] > 0) ? '' : ticketType !== 'scale' && levels.length > 1 ? 'Use Scale to place orders at several levels.' : ticketType === 'limit' && kind === 'STOP' ? `A ${direction === 'BUY' ? 'buy limit must be below the buy' : 'sell limit must be above the sell'} price; use Stop for this level.` : ticketType === 'stop' && kind === 'LIMIT' ? `A ${direction === 'BUY' ? 'buy stop must be above the buy' : 'sell stop must be below the sell'} price; use Limit for this level.` : '');
  /** A scale order: the total size split over working orders at several typed levels, or spaced evenly from the order level to `scaleTo`. Skew is last size ÷ first size. IG has no batch endpoint, so they are sent one at a time. */
  const rungs = $derived.by(() => {
    const to = Number(scaleTo), n = Number(scaleCount), skew = scaleSkew.trim() ? Number(scaleSkew) : 1;
    if (!scaling || !(skew > 0) || levels.length > 10 || !levels.every(v => v > 0)) return [];
    let at = levels;
    if (levels.length === 1) {
      if (!(to > 0) || !Number.isInteger(n) || n < 2 || n > 10) return [];
      const digits = Math.max(...[level, scaleTo, String(selected?.market.bid ?? '')].map(v => v.trim().split('.')[1]?.length ?? 0));
      at = Array.from({ length: n }, (_, k) => Number((levels[0] + ((to - levels[0]) * k) / (n - 1)).toFixed(digits)));
    }
    const weights = at.map((_, k) => 1 + ((skew - 1) * k) / (at.length - 1)), sum = weights.reduce((a, b) => a + b, 0);
    return at.map((level, k) => ({ level, size: Math.floor(((Number(size) * weights[k]) / sum) * 100 + 1e-6) / 100 }));
  });
  const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
  /** The price sizing and margin are read at: the order level, else the side of the quote this order takes. */
  const sizingPrice = $derived(levels[0] > 0 ? levels[0] : selected ? (direction === 'BUY' ? selected.market.offer : selected.market.bid) ?? 0 : 0);
  /** Value and % sizing need IG's margin bands in the account currency, dealt in that currency, as positionPnl assumes. */
  const perContract = $derived(selected && account && currency === account.currency && selected.bands.every(b => b.currency === account.currency) ? contractValue(selected, sizingPrice) : null);
  const maxSize = $derived(perContract !== null && selected ? maxContracts(selected, account?.available ?? 0, sizingPrice) : null);
  const sizePct = $derived(maxSize ? Math.min(100, Math.round(Number(size) / maxSize * 100)) || 0 : 0);
  const margin = $derived(perContract !== null && selected && Number(size) > 0 ? marginFor(selected, Number(size), sizingPrice) : null);
  function setSize(value: string) {
    review = false;
    if (sizeUnit === 'contracts') { size = value; return; }
    valueText = value;
    size = perContract && Number(value) > 0 ? String(floor2(Number(value) / perContract)) : '';
  }
  function setPct(pct: number) {
    if (!maxSize) return;
    size = String(floor2(maxSize * pct / 100)); review = false;
    if (sizeUnit === 'value') valueText = perContract ? (Number(size) * perContract).toFixed(2) : '';
  }
  function setUnit(unit: 'contracts' | 'value') {
    sizeUnit = unit; save('ig:size-unit', unit);
    valueText = unit === 'value' && perContract && Number(size) > 0 ? (Number(size) * perContract).toFixed(2) : '';
  }
  const trailing = $derived(ticketType === 'market' && trailStep.trim() !== '');
  /** Why the stop and take-profit cannot go with this order, or ''. Levels are checked against the quote for a market order and against each order level otherwise. */
  const exitError = $derived.by(() => {
    if (!selected) return '';
    if ([stop, takeProfit, trailStep].some(v => v.trim() && !(Number(v) > 0))) return 'Stop, take profit and trail step must be positive.';
    if (guaranteed && !stop.trim()) return 'A guaranteed stop needs a stop.';
    if (trailing && (exitUnit !== 'pts' || !stop.trim() || guaranteed)) return 'A trailing stop needs a stop distance in points and no guarantee.';
    if (exitUnit === 'pts') return '';
    const buy = direction === 'BUY', at = (v: string) => v.trim() ? Number(v) : null;
    const entries = rungs.length ? rungs.map(r => r.level) : levels.length ? [levels[0]] : [];
    if (!entries.length) return selected.market.bid === null || selected.market.offer === null ? '' : levelError(buy, at(stop), at(takeProfit), selected.market.bid, selected.market.offer);
    return entries.map(e => levelError(buy, at(stop), at(takeProfit), e, e).replace(/the (sell|buy) price/, 'every order level')).find(Boolean) ?? '';
  });
  let retry = $state<{ jobs: Job[]; what: string; tag: string } | null>(null), scales = $state<Record<string, string>>({}), cancelling = $state<{ title: string; rows: Record<string, any>[] } | null>(null);
  let hotkeySizes = $state<Record<string, string>>({});
  const hotkeySize = $derived(selected ? hotkeySizes[selected.market.epic] ?? '' : '');
  const validSize = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1e9;
  const hotkeyError = $derived(!hotkeySize.trim() ? 'Set a B/S size for this market.' : !validSize(hotkeySize) ? 'Enter a positive B/S size up to 1,000,000,000.' : selected?.minSize != null && Number(hotkeySize) < selected.minSize ? `Minimum B/S size is ${selected.minSize}.` : '');
  let reconcile = $state(false), reconciled = $state(false);
  let review = $state(false), sending = $state(false), pending = $state<Pending | null>(null);
  /** A request whose outcome is still unknown blocks new ones; a finished one only stays on screen. */
  const busy = $derived(!!pending && !['accepted', 'rejected', 'not-submitted'].includes(pending.status));
  let positions = $state<Record<string, any>[]>([]), closing = $state<Record<string, any> | null>(null);
  let orders = $state<Record<string, any>[]>([]), deals = $state<Deal[] | null>(null), bottom = $state<'positions' | 'orders' | 'history'>('positions');
  let journalDays = $state<7 | 30 | 90>(7), notes = $state(record(load<unknown>('ig:journal', {})) as Record<string, string>);
  let tags = $state(record(load<unknown>('ig:journal-tags', {})) as Record<string, string[]>), tagFilter = $state('');
  const tagsOf = (d: Deal) => array(tags[dealKey(d)]).map(text).filter(Boolean);
  const journal = $derived(journalOf((deals ?? []).filter(d => !tagFilter || tagsOf(d).includes(tagFilter))));
  const tagTotals = $derived([...new Set((deals ?? []).flatMap(tagsOf))].map(name => { const list = (deals ?? []).filter(d => tagsOf(d).includes(name)); return { name, trades: list.length, wins: list.filter(d => dealPnl(d) > 0).length, net: list.reduce((sum, d) => sum + dealPnl(d), 0) }; }).sort((a, b) => b.net - a.net));
  function tag(d: Deal, value: string) {
    const list = [...new Set(value.toLowerCase().split(/[,\s]+/).map(t => t.replace(/^#+/, '').slice(0, 24)).filter(Boolean))].slice(0, 8);
    tags = Object.fromEntries(Object.entries({ ...tags, [dealKey(d)]: list }).filter(([, v]) => v.length));
    save('ig:journal-tags', tags);
    if (!tagTotals.some(t => t.name === tagFilter)) tagFilter = '';
  }
  function note(d: Deal, value: string) { notes = Object.fromEntries(Object.entries({ ...notes, [dealKey(d)]: value.slice(0, 500) }).filter(([, v]) => v)); save('ig:journal', notes); }
  const scaleGroups = $derived(Object.values(Object.groupBy(orders.filter(row => scales[text(record(row.workingOrderData).dealId)]), row => scales[text(record(row.workingOrderData).dealId)])).map(rows => rows!));
  let rightTab = $state<'trade' | 'copilot'>('trade'), aiMarks = $state<Mark[]>([]);
  let editing = $state<{ row: Record<string, any>; stop: string; limit: string } | null>(null), moving = $state<{ row: Record<string, any>; level: string } | null>(null);
  const editLevel = (v: string) => v.trim() ? Number(v) : null;
  const editError = $derived.by(() => {
    if (!editing) return '';
    const p = record(editing.row.position), m = record(editing.row.market), stopLevel = editLevel(editing.stop), limitLevel = editLevel(editing.limit), bid = numeric(m.bid), offer = numeric(m.offer);
    if ([stopLevel, limitLevel].some(v => v !== null && !(v > 0))) return 'Levels must be positive prices.';
    return bid === null || offer === null ? 'Refresh positions for a current quote.' : levelError(p.direction === 'BUY', stopLevel, limitLevel, bid, offer);
  });
  let phoneTab = $state('chart');
  const phoneTabs = [['chart', 'Chart'], ['markets', 'Markets'], ['trade', 'Trade'], ['positions', 'Positions']] as const;
  let theme = $state('hyperliquid'), searchEl: HTMLInputElement;
  const findMarket = () => { phoneTab = 'markets'; source = 'browse'; requestAnimationFrame(() => searchEl?.focus()); };
  const watched = (epic: string) => watchlist.some(m => m.epic === epic);
  const listed = $derived(source === 'watch' ? watchlist.map(m => quotes[m.epic] ?? m).filter(m => !query.trim() || `${m.name} ${m.epic}`.toLowerCase().includes(query.trim().toLowerCase())) : markets);
  const types = $derived([...new Set(listed.map(m => m.type).filter(Boolean))].sort());
  const rows = $derived(listed.filter(m => category === 'all' || m.type === category).filter(m => !sameExpiry || !selected || m.expiry === selected.market.expiry).toSorted((a, b) => {
    if (ranking === 'name') return a.name.localeCompare(b.name);
    const score = (m: Market) => fresh(m, now) ? (ranking === 'bps' ? spreadBps(m) : spread(m)) ?? Infinity : Infinity;
    return score(a) - score(b) || a.name.localeCompare(b.name);
  }));
  const best = $derived(ranking === 'bps' ? rows.find(m => fresh(m, now))?.epic : undefined);
  const invalid = $derived(!eligibleAccount(account) ? 'Select an enabled SGD CFD account.' : !selected ? 'Select a market.' : !fresh(selected.market, now) ? 'Refresh this market for a current, undelayed quote.' : levels.some(v => !(v > 0)) || levels.length > 10 ? 'Order levels must be 1 to 10 positive prices.' : ticketType === 'market' && !selected.marketOrders ? 'IG does not allow market orders for this instrument. Use Limit or Stop.' : ticketType !== 'market' && !levels.length ? 'Enter an order level.' : typeError ? typeError : selected.minSize === null ? 'IG has not supplied a supported minimum size.' : !selected.currencies.includes(currency) ? 'Choose an available dealing currency.' : !(Number(size) >= selected.minSize && Number(size) > 0) ? `Minimum size is ${selected.minSize}.` : exitError ? exitError : scaling && !rungs.length ? 'A scale order needs a Scale to level and 2 to 10 orders, or several order levels, and a positive size skew.' : rungs.length && !(Math.min(...rungs.map(r => r.size)) >= selected.minSize) ? `Each of the ${rungs.length} orders must be at least ${selected.minSize}; raise the total size or lower the skew.` : '');
  /** What the ticket's stop and take profit are worth in the dealing currency at the order price, from IG's contract size. */
  const exits = $derived.by(() => {
    const m = selected?.market, per = selected?.contract ? Number(size) * selected.contract / selected.scaling : 0;
    const entry = levels[0] > 0 ? levels[0] : direction === 'BUY' ? m?.offer : m?.bid;
    if (!(per > 0) || !entry || levels.length > 1 || ticketType === 'scale') return null;
    const worth = (v: string) => !(Number(v) > 0) ? null : (exitUnit === 'pts' ? Number(v) : Math.abs(Number(v) - entry)) * per;
    const risk = worth(stop), reward = worth(takeProfit);
    return risk === null && reward === null ? null : { risk, reward, ratio: risk && reward ? reward / risk : null };
  });
  const number = (n: number | null | undefined, decimals = 2) => n == null ? '—' : fmtNum(n, decimals);
  const quoteFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 10 });
  const quote = (n: number | null | undefined) => n == null ? '—' : quoteFormat.format(n);
  const mid = (m: Market) => m.bid !== null && m.offer !== null ? quote((m.bid + m.offer) / 2) : '—';
  const quoteAge = (m: Market) => m.delay ? `${m.delay}m delayed` : !m.updated ? 'Time unavailable' : `${Math.max(0, Math.floor((now - m.updated) / 1000))}s ago`;
  const status = (m: Market) => fresh(m, now) ? 'Current' : !m.status ? 'No quote loaded' : m.status !== 'TRADEABLE' ? m.status.replaceAll('_', ' ') : quoteAge(m);
  const shownMarket = (v: View) => v.detail?.market ?? quotes[v.market.epic] ?? v.market;
  const liteList = (value: unknown, max: number): Market[] => array(value).map(record).filter((r, i, all) => /^[A-Za-z0-9._]{6,30}$/.test(r.epic) && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 120 && all.findIndex(o => o.epic === r.epic) === i).slice(0, max)
    .map(r => ({ epic: r.epic, name: r.name, type: text(r.type), expiry: text(r.expiry), bid: null, offer: null, status: '', delay: null, updated: null, streaming: false }));
  const lite = (m: Market) => ({ epic: m.epic, name: m.name, type: m.type, expiry: m.expiry });
  function persist() {
    const previous = record(load<unknown>('ig:workspace', {}));
    save('ig:workspace', { averages, open: connected ? views.map(v => ({ ...lite(v.market), res: v.res })) : array(previous.open), active: connected ? active : text(previous.active), layout, ranking, source });
  }
  function noteQuotes(list: Market[]) {
    for (const m of list) if ((m.updated ?? 0) >= (quotes[m.epic]?.updated ?? 0)) quotes[m.epic] = m;
  }
  function toggleWatch(m: Market) {
    watchlist = watched(m.epic) ? watchlist.filter(w => w.epic !== m.epic) : [...watchlist, m].slice(-MAX_WATCH);
    save('ig:watchlist', watchlist.map(lite));
  }
  const defaults = (d: Detail | null): Draft => ({ direction: 'BUY', size: d?.minSize?.toString() ?? '', currency: d?.currencies.includes('SGD') ? 'SGD' : d?.currencies[0] ?? 'SGD', stop: '', takeProfit: '', level: '', type: ticketType === 'scale' ? 'market' : ticketType });
  function setDraft(d: Draft) { direction = d.direction; size = d.size; currency = d.currency; stop = d.stop; takeProfit = d.takeProfit; level = d.level ?? ''; ticketType = d.type ?? 'market'; scaleTo = ''; scaleCount = ''; scaleSkew = ''; trailStep = ''; guaranteed = false; valueText = ''; }
  const draft = (): Draft => ({ direction, size, currency, stop, takeProfit, level, type: ticketType });
  function activate(epic: string) {
    if (epic !== active) {
      if (view) view.draft = draft();
      active = epic; review = false; error = '';
      const next = view;
      setDraft(next?.draft ?? defaults(next?.detail ?? null));
      if (next) next.draft = null;
      persist();
    }
    const v = view;
    if (v && !v.busy && (!v.detail || (!fresh(v.detail.market, now) && Date.now() - v.at > 10_000))) void loadView(epic);
  }
  const newView = (market: Market, res: Resolution = '1H'): View => ({ market, detail: null, res, bars: [], live: null, pricesAt: 0, at: 0, busy: false, tried: false, note: '', draft: null });
  type Cached = Record<string, { at: number; bars: Bar[] }>;
  const cachedBars = (epic: string, res: Resolution) => array(record(record(load<unknown>('ig:bars', {}))[`${epic}|${res}`]).bars).map(record).filter((b): b is Bar => [b.time, b.open, b.high, b.low, b.close].every(n => numeric(n) !== null)).slice(-HISTORY);
  function keepBars(epic: string, res: Resolution, bars: Bar[]) {
    const all = { ...record(load<unknown>('ig:bars', {})) as Cached, [`${epic}|${res}`]: { at: Date.now(), bars } };
    save('ig:bars', Object.fromEntries(Object.entries(all).sort((a, b) => numeric(b[1]?.at)! - numeric(a[1]?.at)!).slice(0, MAX_CACHED)));
  }
  function tick(v: View) {
    const m = v.detail?.market;
    v.live = m && fresh(m) ? liveBar(v.bars, v.live, (m.bid! + m.offer!) / 2, RESOLUTIONS[v.res][1]) : v.live && v.live.time >= (v.bars.at(-1)?.time ?? 0) ? v.live : null;
  }
  function setResolution(res: Resolution) {
    const v = view;
    if (!v || v.res === res) return;
    v.res = res; v.bars = []; v.live = null; v.pricesAt = 0; v.note = '';
    persist(); void loadView(v.market.epic);
  }
  const money = (value: number | null, currency: unknown) => value === null ? '—' : `${value < 0 ? '−' : '+'}${text(currency)} ${fmtNum(Math.abs(value), 2)}`;
  function linesOf(epic: string): Line[] {
    const working = orders.filter(row => record(row.marketData).epic === epic).flatMap(row => {
      const o = record(row.workingOrderData), price = numeric(o.orderLevel);
      return price === null ? [] : [{ price, title: `${o.direction === 'BUY' ? 'Buy' : 'Sell'} ${text(o.orderType).toLowerCase()} ${quote(numeric(o.orderSize))}`, tone: 'dim' as const, key: `order:${o.dealId}` }];
    });
    const ai = aiMarks.filter(m => m.coin === epic && m.type !== 'bias' && m.author !== 'user').flatMap(m => [m.a, m.b].flatMap(price => price == null ? [] : [{ price, title: `AI · ${m.label}`, tone: 'accent' as const }]));
    return [...ai, ...working, ...positions.filter(row => record(row.market).epic === epic).flatMap(row => {
      const p = record(row.position), pnl = positionPnl(row), level = numeric(p.level), stop = numeric(p.stopLevel), limit = numeric(p.limitLevel);
      const entry: Line[] = level === null ? [] : [{ price: level, title: `${p.direction === 'BUY' ? '+' : '−'}${quote(numeric(p.size))} · ${money(pnl?.value ?? null, p.currency)}`, tone: 'dim', key: `entry:${p.dealId}` }];
      return [...entry, ...(stop === null ? [] : [{ price: stop, title: 'Stop', tone: 'sell' as const, key: `stop:${p.dealId}` }]), ...(limit === null ? [] : [{ price: limit, title: 'Limit', tone: 'buy' as const, key: `limit:${p.dealId}` }])];
    }), ...(epic === active ? draftLines() : [])];
  }
  const places = (...values: unknown[]) => Math.max(1, ...values.map(v => `${v ?? ''}`.split('.')[1]?.length ?? 0));
  /** The ticket's order level, stop and take profit as draggable lines on the active chart; an empty Limit or Stop level starts at the quote. */
  function draftLines(): Line[] {
    const m = selected?.market;
    if (!connected || !m || m.bid === null || m.offer === null || scaling) return [];
    const buy = direction === 'BUY', entry = levels[0] > 0 ? levels[0] : buy ? m.offer : m.bid;
    const exit = (value: string, loss: boolean) => { const n = Number(value); return !(n > 0) ? null : exitUnit === 'price' ? n : entry + (buy !== loss ? n : -n); };
    const stopAt = exit(stop, true), limitAt = exit(takeProfit, false);
    return [
      ...(ticketType === 'market' ? [] : [{ price: entry, title: levels[0] > 0 ? `${buy ? 'Buy' : 'Sell'} ${ticketType} ${size} · draft` : `Drag to set the ${ticketType} level`, tone: buy ? 'buy' as const : 'sell' as const, key: 'draft:level' }]),
      ...(stopAt === null ? [] : [{ price: stopAt, title: 'Stop · draft', tone: 'sell' as const, key: 'draft:stop' }]),
      ...(limitAt === null ? [] : [{ price: limitAt, title: 'Take profit · draft', tone: 'buy' as const, key: 'draft:tp' }])
    ];
  }
  /** A dragged draft line fills the ticket and sends nothing; the level picks Limit or Stop by the side of the quote it lands on. */
  function moveDraft(id: string, price: number) {
    const m = selected?.market;
    if (!m) return;
    const buy = direction === 'BUY', digits = places(m.bid, m.offer), entry = levels[0] > 0 ? levels[0] : (buy ? m.offer : m.bid) ?? 0;
    review = false;
    if (id === 'level') { level = price.toFixed(digits); ticketType = orderKind(buy, Number(level), m) === 'LIMIT' ? 'limit' : 'stop'; return; }
    const value = exitUnit === 'price' ? price.toFixed(digits) : Math.abs(price - entry).toFixed(digits);
    if (id === 'stop') stop = value; else takeProfit = value;
  }
  /** A line dragged on the chart: a working order moves to the level, a position's stop or limit moves, and its entry line dragged away sets the stop (loss side) or limit (profit side). Each goes through its dialog unless Skip review is on. */
  function moveLine(key: string, price: number) {
    const [kind, id] = key.split(':');
    if (review || sending || busy || closing || moving) return;
    if (kind === 'draft') return moveDraft(id, price);
    if (kind === 'order') {
      const row = orders.find(r => record(r.workingOrderData).dealId === id);
      if (!row) return;
      moving = { row, level: price.toFixed(places(record(row.workingOrderData).orderLevel, record(row.marketData).bid)) };
      if (skipReview) void moveOrder();
      return;
    }
    const row = positions.find(r => record(r.position).dealId === id);
    if (!row) return;
    const p = record(row.position), field = kind === 'entry' ? ((p.direction === 'BUY') === price < (numeric(record(row.market).bid) ?? numeric(p.level) ?? 0) ? 'stop' : 'limit') : kind === 'stop' ? 'stop' : 'limit';
    startEdit(row);
    if (!editing) return;
    editing[field] = price.toFixed(places(p.level));
    if (skipReview && !editError) void editPosition();
  }
  function igContext(): IgContext | null {
    const v = view, m = v?.detail?.market;
    if (!v || !m) return null;
    const held = positions.flatMap(row => {
      const p = record(row.position), pm = record(row.market), size = numeric(p.size), entry = numeric(p.level);
      return size === null || entry === null || !['BUY', 'SELL'].includes(p.direction) ? [] : [{ name: text(pm.instrumentName) || text(pm.epic), epic: text(pm.epic), side: p.direction === 'BUY' ? 'buy' as const : 'sell' as const, size, entry, stop: numeric(p.stopLevel), limit: numeric(p.limitLevel), pnl: positionPnl(row)?.value ?? null, currency: text(p.currency) }];
    });
    const resting = orders.flatMap(row => {
      const o = record(row.workingOrderData), om = record(row.marketData), size = numeric(o.orderSize), level = numeric(o.orderLevel);
      return size === null || level === null ? [] : [{ name: text(om.instrumentName) || text(om.epic), epic: text(om.epic), side: o.direction === 'BUY' ? 'buy' as const : 'sell' as const, size, type: text(o.orderType).toLowerCase(), level }];
    });
    return { coin: m.epic, name: m.name, interval: v.res.toLowerCase(), bid: m.bid, offer: m.offer, candles: v.bars.slice(-HISTORY).map(b => [b.time * 1000, b.open, b.high, b.low, b.close] as [number, number, number, number, number]), positions: held, orders: resting,
      ...(account ? { funds: { currency: account.currency, balance: account.balance, pnl: account.pnl, margin: account.margin, available: account.available } } : {}) };
  }
  function openMarket(m: Market) {
    phoneTab = 'chart';
    if (!views.some(v => v.market.epic === m.epic)) {
      if (view) view.draft = draft();
      const slot = views.findIndex(v => v.market.epic === active);
      if (views.length < MAX_VIEWS) views.push(newView(m));
      else views[slot < 0 ? MAX_VIEWS - 1 : slot] = newView(m);
    }
    activate(m.epic);
    loadShown();
  }
  function closeView(epic: string) {
    const index = views.findIndex(v => v.market.epic === epic);
    if (index < 0) return;
    views.splice(index, 1);
    if (epic === active) { active = ''; const next = views[Math.min(index, views.length - 1)]; if (next) activate(next.market.epic); else setDraft(defaults(null)); }
    persist(); loadShown();
  }
  function setLayout(value: 'single' | 'grid') { layout = value; persist(); loadShown(); }
  function loadShown() { for (const v of shown) if (!v.detail && !v.busy && !v.tried) void loadView(v.market.epic); }
  function restoreWorkspace() {
    const saved = record(load<unknown>('ig:workspace', {})), open = liteList(saved.open, MAX_VIEWS);
    const kept = (epic: string) => array(saved.open).map(record).find(o => o.epic === epic)?.res;
    views = open.map(m => newView(m, isResolution(kept(m.epic)) ? kept(m.epic) : '1H')); active = '';
    const target = open.find(m => m.epic === saved.active)?.epic ?? open[0]?.epic;
    if (target) activate(target);
    loadShown();
  }
  const current = (epic: string, epoch: number) => epoch === connection ? views.find(v => v.market.epic === epic) : undefined;
  function loadView(epic: string) {
    const key = `${connection}:${epic}:${views.find(v => v.market.epic === epic)?.res}`;
    const running = inflight.get(key);
    if (running) return running;
    const task = fetchView(epic, connection).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }
  async function fetchView(epic: string, epoch: number) {
    const start = current(epic, epoch);
    if (!start) return;
    start.busy = true; start.tried = true;
    const res = start.res, step = RESOLUTIONS[res][1];
    if (!start.bars.length) start.note = 'Loading prices…';
    try {
      const detail = await api<Detail>(`market?epic=${encodeURIComponent(epic)}`);
      const v = current(epic, epoch);
      if (!v) return;
      v.detail = detail; v.market = detail.market; v.at = Date.now(); noteQuotes([detail.market]);
      const initial = defaults(detail), fill = (d: Draft): Draft => ({ ...d, size: d.size.trim() ? d.size : initial.size, currency: detail.currencies.includes(d.currency) ? d.currency : initial.currency });
      if (epic !== active) v.draft = fill(v.draft ?? initial);
      else setDraft(fill(draft()));
      tick(v);
      if (v.res !== res || (v.bars.length && Date.now() - v.pricesAt < Math.max(step, 900) * 1000)) return;
      const known = v.bars.length ? $state.snapshot(v.bars) : cachedBars(epic, res), last = known.at(-1)?.time;
      const max = last ? Math.min(HISTORY, Math.max(2, Math.ceil((Date.now() / 1000 - last) / step) + 1)) : HISTORY;
      const history = await api<{ prices: unknown[]; allowance?: typeof allowance }>(`prices?epic=${encodeURIComponent(epic)}&resolution=${res}&max=${max}`);
      const w = current(epic, epoch);
      if (!w || w.res !== res) return;
      const next = barsOf(array(history.prices));
      if (history.allowance) allowance = { remaining: numeric(history.allowance.remaining), total: numeric(history.allowance.total) };
      w.bars = last && next.length && next[0].time <= last ? mergeBars(known, next) : next.length ? next : known; w.pricesAt = Date.now();
      if (next.length) keepBars(epic, res, $state.snapshot(w.bars));
      tick(w);
      w.note = w.bars.length ? '' : 'IG returned no prices for this interval.';
    } catch (e) {
      const v = current(epic, epoch);
      if (!v) return;
      if (!v.bars.length) v.note = 'Chart unavailable.';
      if (epic === active) error = e instanceof Error ? e.message : 'Market unavailable';
    } finally { const v = current(epic, epoch); if (v) v.busy = false; }
  }
  function setHotkeySize(value: string) {
    if (!selected) return;
    hotkeySizes = { ...hotkeySizes, [selected.market.epic]: value.slice(0, 40) };
    save('ig:hotkey-sizes', Object.fromEntries(Object.entries(hotkeySizes).filter(([, size]) => validSize(size)).slice(-100)));
    error = '';
  }
  function tradeHotkey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e.target) || isTyping(document.activeElement)) return;
    const side = e.key.toLowerCase();
    if (!['b', 's'].includes(side) || document.hidden || !connected || !selected || loading || busyMarket || sending || pending || login || review || closing || editing || moving || reconcile || document.querySelector('[role=dialog], [role=menu], details.theme[open], [aria-label="Theme choices"]')) return;
    e.preventDefault(); phoneTab = 'trade'; rightTab = 'trade';
    if (hotkeyError) { error = hotkeyError; document.querySelector<HTMLInputElement>('[data-testid="ig-hotkey-size"]')?.focus(); return; }
    direction = side === 'b' ? 'BUY' : 'SELL'; size = hotkeySize;
    if (invalid) { error = invalid; return; }
    error = '';
    if (skipReview) void submit(); else review = true;
  }
  function signedOut() { tagFilter = ''; connection++; browseRequest++; session = null; connected = false; views = []; active = ''; quotes = {}; positions = []; orders = []; deals = null; review = false; closing = null; editing = null; moving = null; reconcile = false; setDraft(defaults(null)); }
  let reconnecting: Promise<boolean> | null = null;
  const reconnect = () => reconnecting ??= fetch('/api/ig/session', { credentials: 'same-origin' }).then(r => r.ok).catch(() => false).finally(() => reconnecting = null);
  async function api<T>(path: string, method = 'GET', value: unknown = undefined): Promise<T> {
    const epoch = connection;
    const response = await fetch(`/api/ig/${path}`, { method, credentials: 'same-origin', headers: value ? { 'content-type': 'application/json' } : {}, ...(value ? { body: JSON.stringify(value) } : {}) });
    let result;
    try { result = await response.json(); } catch { throw new Error('IG service is unavailable on this deployment.'); }
    if (!response.ok) {
      // A remembered login signs in again once; nothing the failed request carried was sent, so it is not retried.
      if (response.status === 401 && epoch === connection && path !== 'session' && await reconnect()) throw new ApiError(401, 'IG session renewed from your saved login. Nothing was sent; try again.', '');
      if (response.status === 401 && epoch === connection) { signedOut(); openLogin(); }
      if (response.status === 409 && path === 'session' && method === 'POST') { keyConfigured = false; keySetup = true; continueLogin = true; }
      throw new ApiError(response.status, typeof result.error === 'string' ? result.error : 'IG request failed', typeof result.status === 'string' ? result.status : '');
    }
    return result as T;
  }
  async function run(action: () => Promise<void>) {
    error = ''; loading = true;
    try { await action(); } catch (e) { error = e instanceof Error ? e.message : 'Request failed'; } finally { loading = false; }
  }
  async function refreshAccount() {
    const epoch = connection;
    const next = await api<Session>('session');
    const nextPositions = array(record(await api('positions')).positions).map(record);
    const nextOrders = array(record(await api('orders')).workingOrders).map(record);
    if (epoch !== connection) return;
    session = next; positions = nextPositions; orders = nextOrders; connected = true;
    noteQuotes(nextPositions.flatMap(row => marketOf(row.market) ?? []));
  }
  let beat = 0;
  let streaming = $state(false);
  const feedEpics = $derived(connected ? [...new Set([...views.map(v => v.market.epic), ...positions.map(row => text(record(row.market).epic)), ...rows.map(m => m.epic).sort()])].filter(Boolean).slice(0, 40).sort().join(',') : '');
  function applyTick(data: string) {
    let q: Record<string, any> = {};
    try { q = record(JSON.parse(data)); } catch { return; }
    const bid = numeric(q.bid), offer = numeric(q.offer);
    if (bid === null || offer === null) return;
    for (const v of views) {
      if (v.market.epic !== q.epic || !v.detail) continue;
      v.detail.market = v.market = { ...v.detail.market, bid, offer, updated: Date.now() };
      v.at = Date.now(); noteQuotes([v.market]); tick(v);
    }
    const listed = markets.findIndex(m => m.epic === q.epic);
    if (listed >= 0) markets[listed] = { ...markets[listed], bid, offer, updated: Date.now() };
    if (quotes[q.epic]) quotes[q.epic] = { ...quotes[q.epic], bid, offer, updated: Date.now() };
    for (const row of positions) if (row.market?.epic === q.epic) { row.market.bid = bid; row.market.offer = offer; }
  }
  $effect(() => {
    const epics = feedEpics;
    if (!epics || typeof EventSource === 'undefined') return;
    const source = new EventSource(`/api/ig/stream?epics=${encodeURIComponent(epics)}`);
    let lost: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { clearTimeout(lost); source.close(); streaming = false; };
    source.addEventListener('ready', () => { clearTimeout(lost); streaming = true; });
    source.addEventListener('fail', stop);
    // A dropped stream reconnects by itself; polling resumes only if it stays down or the server refused it.
    source.onerror = () => { clearTimeout(lost); if (source.readyState === EventSource.CLOSED) streaming = false; else lost = setTimeout(() => streaming = false, 10_000); };
    source.onmessage = e => applyTick(e.data);
    return stop;
  });
  function poll() {
    if (document.hidden || !connected || loading || sending || login || review || closing || editing || moving) return;
    if (view && !view.busy && (!streaming || beat % 5 === 0)) void loadView(active);
    if (++beat % 3 === 0) refreshAccount().catch(() => {});
  }
  async function signIn() {
    const epoch = ++connection; browseRequest++; views = []; active = ''; positions = [];
    await run(async () => {
      let next: Session;
      try { next = await api<Session>('session', 'POST', { identifier: identifier.trim(), password, environment, remember }); } finally { password = ''; }
      if (epoch !== connection) return;
      session = next;
      apiKey = ''; connected = true; login = false; notice = '';
      await refreshAccount();
      restoreWorkspace();
      await browse().catch(e => { listError = e instanceof Error ? e.message : 'IG categories are unavailable.'; });
    });
  }
  async function saveKey() {
    await run(async () => {
      await api('key', 'PUT', { apiKey: apiKey.trim() });
      apiKey = ''; keyConfigured = true;
      if (continueLogin) keySetup = false;
      else login = false;
    });
  }
  async function forgetKey() {
    await run(async () => { await api('key', 'DELETE'); apiKey = ''; keyConfigured = false; });
  }
  async function signOut() {
    signedOut();
    await run(async () => { await api('session', 'DELETE'); markets = []; nodes = []; });
  }
  async function switchAccount(id: string) {
    connection++; browseRequest++; review = false; views = []; active = ''; positions = [];
    await run(async () => { session = await api<Session>('session', 'PUT', { accountId: id }); await refreshAccount(); restoreWorkspace(); });
  }
  async function browse(node: { id: string; name: string } | undefined = undefined, back = false) {
    const version = ++browseRequest, epoch = connection, typing = query;
    clearTimeout(searchTimer); searching = '';
    const result = await api<{ nodes: typeof nodes; markets: Market[]; fetched: number }>('navigation' + (node ? `?node=${encodeURIComponent(node.id)}` : ''));
    if (version !== browseRequest || epoch !== connection) return;
    listError = '';
    nodes = result.nodes; markets = result.markets; fetched = result.fetched; category = 'all'; source = 'browse'; noteQuotes(result.markets);
    if (query === typing) query = '';
    trail = node ? back ? trail.slice(0, trail.findIndex(n => n.id === node.id) + 1) : [...trail, node] : [];
  }
  function typed() {
    clearTimeout(searchTimer);
    if (source === 'browse' && query.trim().length >= 2) searchTimer = setTimeout(search, 700);
  }
  async function search() {
    clearTimeout(searchTimer);
    const term = query.trim();
    if (source === 'watch' || term.length < 2 || term === searching) return;
    const version = ++browseRequest, epoch = connection;
    searching = term; error = '';
    try {
      const result = await api<{ markets: Market[]; fetched: number }>(`markets?q=${encodeURIComponent(term)}`);
      if (version !== browseRequest || epoch !== connection) return;
      markets = result.markets; fetched = result.fetched; category = 'all'; nodes = []; trail = []; noteQuotes(result.markets);
    } catch (e) { if (version === browseRequest) error = e instanceof Error ? e.message : 'Search failed'; } finally { if (searching === term) searching = ''; }
  }
  async function submit() {
    if (sending || busy || invalid || !selected) return;
    const [stopKey, limitKey] = exitUnit === 'pts' ? ['stopDistance', 'limitDistance'] : ['stopLevel', 'limitLevel'];
    const base = { epic: selected.market.epic, direction, currency, ...(stop ? { [stopKey]: Number(stop) } : {}), ...(takeProfit ? { [limitKey]: Number(takeProfit) } : {}), ...(guaranteed ? { guaranteed: true } : {}), ...(trailing ? { trailingIncrement: Number(trailStep) } : {}) };
    const plan: { level?: number; size: number; type?: string }[] = rungs.length ? rungs : [{ size: Number(size), ...(levels.length ? { level: levels[0], type: kind } : {}) }];
    await batch(plan.map(r => ({ path: 'order', label: r.level === undefined ? 'market' : `${r.size} at ${r.level}`, payload: { ...base, ...r } })), 'order');
  }
  /** Sends requests one at a time. A rejected or not-submitted one is kept for an explicit retry; an uncertain one stops the rest, because resending it could place it twice. */
  async function batch(jobs: Job[], what: string, tag = String(Date.now())) {
    if (sending || busy || !jobs.length) return;
    sending = true; review = false; cancelling = null; retry = null; error = '';
    const intent = { accountId: session!.accountId, environment: session!.environment }, many = jobs.length > 1, failed: Job[] = [], placed: string[] = [];
    try {
      for (const [i, job] of jobs.entries()) {
        const result = await place(intent, job, many ? `Sending ${what} ${i + 1} of ${jobs.length}…` : 'Sending to IG…', !many);
        if (!many) return;
        if (result.status === 'accepted') placed.push(result.dealId ?? '');
        else if (['rejected', 'not-submitted'].includes(result.status)) failed.push({ ...job, why: result.message });
        else { pending = { ...result, message: `${what[0].toUpperCase()}${what.slice(1)} ${i + 1} of ${jobs.length} (${job.label}): ${result.message} ${placed.length} accepted before it; the rest were not sent.` }; break; }
        if (i === jobs.length - 1) pending = { ...result, status: failed.length ? 'rejected' : 'accepted', message: failed.length ? `${placed.length} of ${jobs.length} accepted. Not done: ${failed.map(f => `${f.label} (${f.why})`).join('; ')}` : `IG accepted all ${jobs.length} ${what}s.` };
      }
      if (failed.length) retry = { jobs: failed, what, tag };
      if (what === 'order') { scales = Object.fromEntries(Object.entries({ ...scales, ...Object.fromEntries(placed.filter(Boolean).map(id => [id, tag])) }).slice(-200)); save('ig:scales', scales); }
      try { await refreshAccount(); } catch (e) { error = e instanceof Error ? e.message : 'Could not refresh positions'; }
    } finally { sending = false; }
  }
  async function place(intent: Pick<Pending, 'accountId' | 'environment'>, job: Job, message: string, refresh: boolean): Promise<Pending> {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 26), known = job.path === 'order' ? { reference: id } : {};
    pending = { id, ...intent, ...known, status: 'sending', message };
    try {
      const result = await api<{ status: string; reference?: string; error?: string }>(job.path, 'POST', { id, ...intent, ...job.payload });
      pending = { id, ...intent, reference: result.reference, status: result.status, message: result.error || 'Submitted to IG; execution has not yet been confirmed.' };
      if (result.reference) await confirm(refresh);
    } catch (e) { const refused = e instanceof ApiError && e.deliveryStatus === 'not-submitted'; pending = { id, ...intent, ...(refused ? {} : known), status: refused ? 'not-submitted' : 'unconfirmed', message: e instanceof Error ? e.message : 'Delivery unconfirmed. Check IG before trying again.' }; }
    return pending!;
  }
  const cancelRows = (rows: Record<string, any>[]) => batch(rows.map(row => ({ path: 'cancel', label: `${record(row.marketData).instrumentName} ${record(row.workingOrderData).orderLevel}`, payload: { dealId: record(row.workingOrderData).dealId } })), 'cancel');
  async function confirm(refresh: boolean | Event = true) {
    if (!pending?.reference || pending.accountId !== session?.accountId || pending.environment !== session?.environment) return;
    const item = pending;
    try {
      const result = record(await api(`confirm?reference=${encodeURIComponent(item.reference!)}`));
      if (pending?.id !== item.id) return;
      if (!['ACCEPTED', 'REJECTED'].includes(result.dealStatus)) { pending = { ...item, status: 'unconfirmed', message: 'IG has not confirmed this request. Check again or inspect your IG account.' }; return; }
      pending = { ...item, dealId: text(result.dealId) || undefined, status: result.dealStatus.toLowerCase(), message: result.dealStatus === 'ACCEPTED' ? `IG accepted the request${result.dealId ? ` · ${result.dealId}` : ''}.` : `IG rejected the request: ${result.reason || 'reason unavailable'}` };
      if (refresh === false) return;
      try { await refreshAccount(); } catch (e) { error = e instanceof Error ? e.message : 'Could not refresh positions'; }
    } catch (e) { pending = { ...item, status: 'unconfirmed', message: `${e instanceof Error ? e.message : 'Confirmation unavailable'}. Check IG before submitting again.` }; }
  }
  async function deliver(path: 'close' | 'edit' | 'cancel' | 'amend', payload: Record<string, unknown>, what: string) {
    if (sending || busy) return;
    retry = null;
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 26), intent = { accountId: session!.accountId, environment: session!.environment };
    sending = true; pending = { id, ...intent, status: 'sending', message: `Sending ${what} request…` }; closing = null; editing = null; moving = null;
    try {
      const result = await api<{ status: string; reference?: string; error?: string }>(path, 'POST', { id, ...intent, ...payload });
      pending = { id, ...intent, status: result.status, reference: result.reference, message: result.error || `${what[0].toUpperCase()}${what.slice(1)} submitted; awaiting IG confirmation.` };
      if (result.reference) await confirm();
    } catch (e) { pending = { id, ...intent, status: e instanceof ApiError && e.deliveryStatus === 'not-submitted' ? 'not-submitted' : 'unconfirmed', message: e instanceof Error ? e.message : `${what} delivery unconfirmed. Inspect your IG account.` }; } finally { sending = false; }
  }
  const askClose = (row: Record<string, any>) => { closing = row; if (skipReview) void closePosition(); };
  const closePosition = () => closing && deliver('close', { dealId: record(closing.position).dealId, size: record(closing.position).size }, 'close');
  const editPosition = () => editing && !editError && deliver('edit', { dealId: record(editing.row.position).dealId, stopLevel: editLevel(editing.stop), limitLevel: editLevel(editing.limit) }, 'edit');
  const moveOrder = () => moving && deliver('amend', { dealId: record(moving.row.workingOrderData).dealId, level: Number(moving.level) }, 'move');
  const startEdit = (row: Record<string, any>) => editing = { row, stop: numeric(record(row.position).stopLevel)?.toString() ?? '', limit: numeric(record(row.position).limitLevel)?.toString() ?? '' };
  async function showBottom(tab: typeof bottom) {
    bottom = tab;
    if (tab === 'history') await run(async () => { deals = (await api<{ transactions: Deal[] }>(`history?days=${journalDays}`)).transactions; });
    else await run(refreshAccount);
  }
  function clearUncertain() {
    if (!reconciled || pending?.status !== 'unconfirmed' || pending.accountId !== session?.accountId || pending.environment !== session?.environment) return;
    pending = null; reconcile = false; reconciled = false; notice = 'You marked the request reconciled in IG. No order was resent.';
  }
  $effect(() => { if (hydrated) { if (pending) sessionStorage.setItem('ig:pending', JSON.stringify(pending)); else sessionStorage.removeItem('ig:pending'); } });
  function applyTheme(value: string) {
    if (!THEMES.some(item => item.id === value)) return;
    theme = value; save('ig:theme', value); document.documentElement.dataset.theme = theme;
  }
  onMount(() => {
    try { const saved = record(JSON.parse(sessionStorage.getItem('ig:pending') || 'null')); if (/^[A-Za-z0-9_-]{1,30}$/.test(saved.id) && typeof saved.accountId === 'string' && saved.environment === 'live' && !['accepted', 'rejected', 'not-submitted'].includes(saved.status)) pending = { ...saved, status: 'unconfirmed', message: 'Restored request. Check its confirmation before placing another order.' } as Pending; } catch { sessionStorage.removeItem('ig:pending'); }
    hydrated = true;
    scales = Object.fromEntries(Object.entries(record(load<unknown>('ig:scales', {}))).filter(([, v]) => typeof v === 'string').slice(-200)) as Record<string, string>;
    hotkeySizes = Object.fromEntries(Object.entries(record(load<unknown>('ig:hotkey-sizes', {}))).filter(([, value]) => validSize(value)).slice(-100)) as Record<string, string>;
    watchlist = liteList(load<unknown>('ig:watchlist', []), MAX_WATCH);
    skipReview = load<unknown>('ig:skip-review', false) === true;
    remember = load<unknown>('ig:remember', false) === true;
    if (load<unknown>('ig:size-unit', 'contracts') === 'value') sizeUnit = 'value';
    const saved = record(load<unknown>('ig:workspace', {}));
    if (saved.layout === 'grid') layout = 'grid';
    averages = saved.averages !== false;
    if (['bps', 'points', 'name'].includes(saved.ranking)) ranking = saved.ranking;
    if (saved.source === 'watch') source = 'watch';
    applyTheme(load('ig:theme', theme));
    const timer = setInterval(() => now = Date.now(), 1000), polling = setInterval(poll, POLL);
    void run(async () => {
      keyConfigured = (await api<{ configured: boolean }>('key')).configured;
      try { await refreshAccount(); } catch (e) { if (e instanceof ApiError && e.status === 401) { login = false; return; } throw e; }
      restoreWorkspace();
      const keep = source;
      await browse().catch(e => { listError = e instanceof Error ? e.message : 'IG categories are unavailable.'; });
      source = keep;
    });
    return () => { clearInterval(timer); clearInterval(polling); clearTimeout(searchTimer); };
  });
</script>

<svelte:window onkeydown={tradeHotkey} bind:innerWidth />
<svelte:head><title>IG CFD · Get Liquidated</title><meta name="description" content="IG CFD trading, SGD account balances and comparable market spreads." /></svelte:head>
{#snippet chartNote(v: View | undefined)}
  {@const note = v ? v.note : !connected ? 'Connect IG to search markets and load a chart.' : 'Select a market to load its chart.'}
  {#if note}<div class="chart-note"><div><p>{note}</p>{#if !v}{#if connected}<button class="ui-tab" onclick={findMarket}>Browse markets</button>{:else}<button class="ui-tab" onclick={openLogin}>Connect IG account</button>{/if}{/if}</div></div>{/if}
{/snippet}
<div class="ig-app">
  <header class:chart-account={phoneTab === 'chart'}>
    <a class="brand" href="/ig"><img src="/icon-192.png" width="24" height="24" alt="" /> IG <span>CFD</span></a>
    {#if session}<span class="environment">Live account</span><button class="ui-tab account-toggle" aria-expanded={accountExpanded} aria-controls="ig-account-summary" onclick={() => accountExpanded = !accountExpanded}>Live · {session.accountId} {accountExpanded ? '▴' : '▾'}</button><div class="account-summary" id="ig-account-summary" class:expanded={accountExpanded}><select aria-label="SGD CFD account" value={session.accountId} disabled={loading || sending || busy} onchange={e => switchAccount(e.currentTarget.value)}>{#each session.accounts as a}<option value={a.id} disabled={!eligibleAccount(a)}>{a.name} · {a.currency} · {a.id}</option>{/each}</select><dl class="funds" data-testid="ig-funds"><div><dt>Funds</dt><dd class="num">{number(account?.balance)}</dd></div><div><dt>Profit/Loss</dt><dd class="num" class:buy={(account?.pnl ?? 0) > 0} class:sell={(account?.pnl ?? 0) < 0}>{number(account?.pnl)}</dd></div><div><dt>Margin</dt><dd class="num">{number(account?.margin)}</dd></div><div><dt>Available</dt><dd class="num">{number(account?.available)} {account?.currency || '—'}</dd></div></dl></div>{/if}
    <div class="header-actions"><ThemePicker value={theme} onchange={applyTheme} /><button class="ui-tab" data-testid="ig-key-settings" disabled={loading || sending} onclick={openKey}>API key{keyConfigured ? ' · Saved' : ''}</button><button class="ui-tab" class:connect={!connected} disabled={loading || sending} onclick={() => connected ? signOut() : openLogin()}>{connected ? 'Sign out' : 'Connect IG'}</button></div>
  </header>
  {#if error && !login}<div class="message" role="alert">{error}</div>{/if}
  {#if notice}<div class="message" role="status">{notice}</div>{/if}
  <div class="phone-tabs" role="tablist" aria-label="Trading panels" tabindex="-1" onkeydown={tabNavigation}>
    {#each phoneTabs as [id, label]}<button class="ui-tab" id="ig-tab-{id}" role="tab" aria-selected={phoneTab === id} aria-controls="ig-panel-{id}" tabindex={phoneTab === id ? 0 : -1} onclick={() => phoneTab = id}>{label}</button>{/each}
  </div>
  {#if views.length && (phoneTab === 'chart' || phoneTab === 'trade')}<div class="phone-instrument">
    <select aria-label="Active instrument" data-testid="ig-instrument-select" value={active} disabled={review || sending} onchange={e => activate(e.currentTarget.value)}>{#each views as v (v.market.epic)}{@const m = shownMarket(v)}<option value={m.epic}>{m.name} · {number(spreadBps(m))} bps</option>{/each}</select>
    <button class="ui-tab" aria-label="Open another instrument" onclick={findMarket}>＋</button>
    <button class="ui-tab" aria-label="Close {view?.market.name ?? 'instrument'}" disabled={!view || review} onclick={() => closeView(active)}>✕</button>
  </div>{/if}
  <main data-view={phoneTab}>
    <div class="markets" id="ig-panel-markets" role="tabpanel" tabindex="0" aria-labelledby="ig-tab-markets">
      <div class="section-title">
        <div class="sources" role="tablist" aria-label="Market lists" tabindex="-1" onkeydown={tabNavigation}>
          <button class="ui-tab" role="tab" aria-selected={source === 'browse'} tabindex={source === 'browse' ? 0 : -1} onclick={() => { source = 'browse'; category = 'all'; persist(); }}>Markets</button>
          <button class="ui-tab" role="tab" aria-selected={source === 'watch'} tabindex={source === 'watch' ? 0 : -1} data-testid="ig-watchlist-tab" onclick={() => { source = 'watch'; category = 'all'; persist(); }}>Watchlist <span class="count">{watchlist.length}</span></button>
        </div>
        {#if source === 'browse'}<button class="ui-tab" disabled={!connected || loading} onclick={() => run(() => browse())} aria-label="Browse categories">Categories</button>{/if}
      </div>
      <form class="search" onsubmit={e => { e.preventDefault(); void search(); }}><div class="ui-field search-field"><input aria-label={source === 'watch' ? 'Filter watchlist' : 'Search IG markets'} bind:this={searchEl} placeholder={source === 'watch' ? 'Filter watchlist' : 'Search markets'} bind:value={query} oninput={typed} disabled={!connected} />{#if query}<button type="button" class="clear" aria-label="Clear search" onclick={() => { query = ''; clearTimeout(searchTimer); searchEl.focus(); }}>✕</button>{/if}</div>{#if source === 'browse'}<button disabled={!connected || loading || query.trim().length < 2}>{searching ? 'Searching…' : 'Search'}</button>{/if}</form>
      {#if source === 'browse' && trail.length}<nav aria-label="Market category"><button class="ui-tab" onclick={() => run(() => browse())}>All markets</button>{#each trail as node}<span>/</span><button class="ui-tab" onclick={() => run(() => browse(node, true))}>{node.name}</button>{/each}</nav>{/if}
      {#if source === 'browse' && nodes.length}<div class="categories">{#each nodes as node}<button class="ui-tab" onclick={() => run(() => browse(node))}>{node.name} ›</button>{/each}</div>{/if}
      {#if types.length > 1}<div class="chips" role="group" aria-label="Instrument category"><button class="ui-tab" aria-pressed={category === 'all'} onclick={() => category = 'all'}>All</button>{#each types as type}<button class="ui-tab" aria-pressed={category === type} onclick={() => category = type}>{type.replaceAll('_', ' ').toLowerCase()}</button>{/each}</div>{/if}
      <div class="filters"><select aria-label="Sort spreads" value={ranking} onchange={e => { ranking = e.currentTarget.value as typeof ranking; persist(); }}><option value="bps">Lowest spread · bps</option><option value="points">Lowest raw spread · points</option><option value="name">Market name</option></select>{#if selected}<label title="Only show markets with the same expiry as {selected.market.name}"><input type="checkbox" bind:checked={sameExpiry} /> Same expiry</label>{/if}</div>
      {#if selected && selected.market.type && types.includes(selected.market.type) && category !== selected.market.type}<div class="peer-controls"><button class="ui-tab" onclick={() => category = selected!.market.type}>Same category as {selected.market.name}</button></div>{/if}
      <div class="market-table"><table><thead><tr><th>Market</th><th>Sell</th><th>Buy</th><th>Spread</th><th title="Bps compares spread relative to midpoint; points use each market’s quote units. Rankings cover loaded results and exclude commissions, financing and currency conversion.">{ranking === 'points' ? 'Points' : 'Bps'}</th><th>Quote</th></tr></thead><tbody>{#each rows as m (m.epic)}{@const on = watched(m.epic)}<tr class:selected={active === m.epic} data-testid="ig-market-row" data-epic={m.epic}><td><div class="market-cell"><button class="star" class:on aria-pressed={on} aria-label="Watch {m.name}" title={on ? 'Remove from watchlist' : 'Add to watchlist'} onclick={() => toggleWatch(m)}>★</button><div><button class="market-name" onclick={() => openMarket(m)}>{m.name}</button><small>{m.type.replaceAll('_', ' ').toLowerCase() || 'Type unavailable'} · {m.expiry || 'No expiry supplied'}{#if best === m.epic}{' · '}<b class="best">Lowest bps</b>{/if}{#if views.some(v => v.market.epic === m.epic)}{' · Open'}{/if}</small><small class="market-status"><span class="sell num">{quote(m.bid)}</span> / <span class="buy num">{quote(m.offer)}</span> · {status(m)}{#if fresh(m, now)}{` · ${quoteAge(m)}`}{/if}</small></div></div></td><td class="sell">{quote(m.bid)}</td><td class="buy">{quote(m.offer)}</td><td>{quote(spread(m))}</td><td class="spread-value"><span data-testid="ig-spread-bps">{ranking === 'points' ? quote(spread(m)) : number(spreadBps(m))}</span><small>{ranking === 'points' ? `${number(spreadBps(m))} bps` : `${quote(spread(m))} pts`}</small></td><td><span>{status(m)}</span><small>{quoteAge(m)}</small></td></tr>{/each}</tbody></table></div>
      {#if !rows.length}<p class="empty">{!connected ? 'Connect your IG account to search markets and compare current spreads.' : source === 'watch' ? watchlist.length ? 'No watched markets match this filter.' : 'Star ★ a market to add it to your watchlist.' : loading || searching ? 'Loading markets…' : listError ? `${listError} Search, or Refresh list to retry.` : 'Browse a category or search for markets. No matching results are loaded.'}</p>{/if}
      <div class="market-footer"><span title={fetched ? `Fetched ${new Date(fetched).toLocaleTimeString()}` : undefined}>{rows.length} markets{source === 'watch' ? ' · quotes refresh when opened' : ''}</span>{#if source === 'browse'}<button class="ui-tab" disabled={!connected || loading || !!searching} onclick={() => query.trim().length >= 2 ? search() : run(() => browse(trail.at(-1), true))}>Refresh list</button>{/if}</div>
    </div>
    <section class="workspace">
      {#if views.length}<nav class="instruments" aria-label="Open instruments">
        {#each views as v (v.market.epic)}{@const m = shownMarket(v)}<span class="instrument"><button class="open" data-testid="ig-instrument" data-epic={m.epic} aria-current={active === m.epic ? 'true' : undefined} disabled={review || sending} title="{m.name} · {m.epic} · {status(m)}" onclick={() => activate(m.epic)}><span class="name">{m.name}</span><span class="num">{mid(m)}</span><span class="num dim">{number(spreadBps(m))} bps</span>{#if v.busy}<span class="dim">…</span>{/if}</button><button class="close" aria-label="Close {m.name}" disabled={review} onclick={() => closeView(m.epic)}>✕</button></span>{/each}
        <button class="ui-tab add" aria-label="Open another instrument" title="Open another instrument" onclick={findMarket}>＋</button>
      </nav>{/if}
      <div class="chart-heading">
        <div class="title"><h1>{selected?.market.name || 'IG markets'}</h1><span>{selected?.market.epic || view?.market.epic || 'Choose a market'} · {view?.res ?? '1H'} · Midpoint</span></div>
        {#if selected}<dl class="stats"><div><dt>Sell</dt><dd class="sell num">{quote(selected.market.bid)}</dd></div><div><dt>Buy</dt><dd class="buy num">{quote(selected.market.offer)}</dd></div><div><dt>Spread</dt><dd class="num chart-spread">{number(spreadBps(selected.market))} bps</dd></div><div><dt>Quote</dt><dd class:warn={!fresh(selected.market, now)}>{status(selected.market)}{#if fresh(selected.market, now)}{` · ${quoteAge(selected.market)}`}{/if}</dd></div></dl>{/if}
        <div class="chart-actions">
          {#if view}<div class="intervals" role="group" aria-label="Chart interval">{#each Object.keys(RESOLUTIONS) as res}<button class="ui-tab" aria-pressed={view.res === res} onclick={() => setResolution(res as Resolution)}>{res}</button>{/each}</div><select class="interval-select" aria-label="Chart interval" value={view.res} onchange={e => setResolution(e.currentTarget.value as Resolution)}>{#each Object.keys(RESOLUTIONS) as res}<option value={res}>{res}</option>{/each}</select><button class="ui-tab" aria-pressed={averages} title="Moving averages of the close over {AVERAGES.join(', ')} bars" onclick={() => { averages = !averages; persist(); }}>MA</button><button class="ui-tab" disabled={busyMarket} onclick={() => loadView(active)}>{busyMarket ? 'Refreshing…' : 'Refresh quote'}</button>{/if}
          {#if views.length > 1}<div class="layout" role="group" aria-label="Chart layout"><button class="ui-tab" aria-pressed={layout === 'single'} aria-label="One chart" onclick={() => setLayout('single')}>1</button><button class="ui-tab" aria-pressed={layout === 'grid'} aria-label="Up to four charts" onclick={() => setLayout('grid')}>2×2</button></div>{/if}
          <button class="ui-tab find" onclick={findMarket}>Find a market</button>
        </div>
      </div>
      <div class="charts" class:grid={grid && shown.length > 1} data-count={shown.length} id="ig-panel-chart" role="tabpanel" tabindex="0" aria-labelledby="ig-tab-chart">
        {#each shown as v (v.market.epic)}{@const m = shownMarket(v)}<div class="tile" data-testid="ig-tile" data-epic={m.epic}>
          {#if grid && shown.length > 1}<button class="tile-head" aria-pressed={active === m.epic} aria-label="Make {m.name} active" disabled={review || sending} onclick={() => activate(m.epic)}><b>{m.name}</b><span class="sell num">{quote(m.bid)}</span><span class="buy num">{quote(m.offer)}</span><span class="num">{number(spreadBps(m))} bps</span><span class="dim">{status(m)}</span></button>{/if}
          <div class="chart-wrap" role="presentation" onpointerdown={() => grid && !review && !sending && activate(m.epic)}><IgChart bars={v.bars} live={v.live} {theme} epic={m.epic} scope={v.res} averages={averages ? AVERAGES : []} lines={linesOf(m.epic)} onmove={moveLine} />{@render chartNote(v)}</div>
        </div>{:else}<div class="tile"><div class="chart-wrap"><IgChart bars={[]} {theme} />{@render chartNote(undefined)}</div></div>{/each}
      </div>
      <div class="positions" class:tall={bottom === 'history'} id="ig-panel-positions" role="tabpanel" tabindex="0" aria-labelledby="ig-tab-positions"><div class="section-title"><div class="sources" role="tablist" aria-label="Account activity" tabindex="-1" onkeydown={tabNavigation}>{#each [['positions', 'Positions', positions.length], ['orders', 'Orders', orders.length], ['history', 'Journal', 0]] as const as [id, label, count]}<button class="ui-tab" role="tab" data-testid="ig-bottom-{id}" aria-selected={bottom === id} tabindex={bottom === id ? 0 : -1} disabled={!connected || loading} onclick={() => showBottom(id)}>{label} <span class="count">{count || ''}</span></button>{/each}</div><button class="ui-tab" disabled={!connected || loading} onclick={() => showBottom(bottom)}>Refresh</button></div>
        {#if bottom === 'positions'}<div class="position-table"><table><thead><tr><th>Market</th><th>Direction</th><th>Size</th><th>Entry</th><th>Latest</th><th title="Estimated from the latest quote IG sent with the position, in its dealing currency. IG's own figure is authoritative.">P&amp;L</th><th>Stop</th><th>Limit</th><th></th></tr></thead><tbody>{#each positions as row}{@const pm = marketOf(row.market)}{@const pnl = positionPnl(row)}<tr data-testid="ig-position"><td>{#if pm}<button class="market-name" title="Open chart" onclick={() => openMarket(quotes[pm.epic] ?? pm)}>{pm.name}</button>{:else}{record(row.market).instrumentName}{/if}</td><td class:buy={record(row.position).direction === 'BUY'} class:sell={record(row.position).direction === 'SELL'}>{record(row.position).direction}</td><td class:buy={record(row.position).direction === 'BUY'} class:sell={record(row.position).direction === 'SELL'}>{record(row.position).direction === 'SELL' ? '−' : '+'}{quote(numeric(record(row.position).size))}</td><td>{quote(numeric(record(row.position).level))}</td><td>{quote(pnl?.exit)}</td><td class="num" class:buy={(pnl?.points ?? 0) > 0} class:sell={(pnl?.points ?? 0) < 0}>{pnl?.value == null ? record(row.position).currency : money(pnl.value, record(row.position).currency)}{#if pnl}<small>{pnl.points < 0 ? '−' : '+'}{quote(Math.abs(pnl.points))} pts</small>{/if}</td>{#each ['stopLevel', 'limitLevel'] as field}<td><button class="ui-tab level" title="Edit stop and limit" disabled={busy || sending || !eligibleAccount(account)} onclick={() => startEdit(row)}>{numeric(record(row.position)[field]) === null ? 'Add' : quote(numeric(record(row.position)[field]))}</button></td>{/each}<td><button class="ui-tab phone-edit" aria-label="Edit stop and limit" disabled={busy || sending || !eligibleAccount(account)} onclick={() => startEdit(row)}>✎</button><button class="ui-tab" disabled={busy || sending || !eligibleAccount(account)} onclick={() => askClose(row)}>Close</button></td></tr>{/each}</tbody></table></div>{#if !positions.length}<p class="empty">{connected ? 'No open positions returned by IG.' : 'Your positions appear after connecting.'}</p>{/if}
        {:else if bottom === 'orders'}{#if orders.length > 1}<div class="bulk">{#each scaleGroups as rows}<button class="ui-tab" data-testid="ig-cancel-scale" disabled={busy || sending} onclick={() => cancelling = { title: 'Cancel scale', rows }}>Cancel scale · {record(rows[0].marketData).instrumentName} · {rows.length}</button>{/each}<button class="ui-tab" data-testid="ig-cancel-all" disabled={busy || sending} onclick={() => cancelling = { title: 'Cancel all orders', rows: orders }}>Cancel all {orders.length}</button></div>{/if}<div class="position-table orders"><table><thead><tr><th>Market</th><th>Order</th><th>Size</th><th>Level</th><th>Latest</th><th>Stop / limit</th><th></th></tr></thead><tbody>{#each orders as row}{@const o = record(row.workingOrderData)}{@const m = record(row.marketData)}<tr data-testid="ig-order"><td>{m.instrumentName}</td><td class:buy={o.direction === 'BUY'} class:sell={o.direction === 'SELL'}>{o.direction === 'BUY' ? 'Buy' : 'Sell'} {text(o.orderType).toLowerCase()}</td><td>{quote(numeric(o.orderSize))}</td><td>{quote(numeric(o.orderLevel))}</td><td>{quote(numeric(o.direction === 'BUY' ? m.offer : m.bid))}</td><td>{quote(numeric(o.stopDistance))} / {quote(numeric(o.limitDistance))} pts</td><td><button class="ui-tab" disabled={busy || sending || !eligibleAccount(account)} onclick={() => deliver('cancel', { dealId: o.dealId }, 'cancel')}>Cancel</button></td></tr>{/each}</tbody></table></div>{#if !orders.length}<p class="empty">{connected ? 'No working orders.' : 'Your orders appear after connecting.'}</p>{/if}
        {:else}{@const cur = account?.currency}
          <div class="journal-head"><div class="chips" role="group" aria-label="Journal range">{#each [7, 30, 90] as const as d}<button class="ui-tab" data-testid="ig-journal-{d}" aria-pressed={journalDays === d} disabled={loading} onclick={() => { journalDays = d; void showBottom('history'); }}>{d}d</button>{/each}</div>
            {#if deals?.length}<dl class="journal-stats" data-testid="ig-journal-stats"><div><dt>Net P&amp;L</dt><dd class:buy={journal.net > 0} class:sell={journal.net < 0}>{money(journal.net, cur)}</dd></div><div><dt>Trades</dt><dd>{journal.rows.length}</dd></div><div><dt title="Winning trades out of those that closed with a profit or a loss.">Win rate</dt><dd>{journal.wins + journal.losses ? fmtNum(journal.wins / (journal.wins + journal.losses) * 100, 0) + '%' : '—'}</dd></div><div><dt>Avg win</dt><dd>{money(journal.avgWin, cur)}</dd></div><div><dt>Avg loss</dt><dd>{money(journal.avgLoss, cur)}</dd></div><div><dt title="Gross profit divided by gross loss. Above 1 means the winners paid for the losers.">Profit factor</dt><dd>{journal.factor === null ? '—' : fmtNum(journal.factor, 2)}</dd></div></dl>{/if}</div>
          {#if deals?.length}<div class="position-table history"><table><thead><tr><th>Market</th><th>Closed (UTC)</th><th>Held</th><th>Size</th><th>Opening</th><th>Closing</th><th>P&amp;L</th><th>Tags · Note</th></tr></thead><tbody>{#each journal.days as day}<tr class="day" data-testid="ig-journal-day"><td colspan="8">{day.name} · {day.trades} {day.trades === 1 ? 'trade' : 'trades'} · {day.wins} won · <b class:sell={day.net < 0} class:buy={day.net > 0}>{money(day.net, cur)}</b></td></tr>{#each journal.rows.filter(r => r.day === day.name) as d}<tr data-testid="ig-deal"><td>{d.name}</td><td>{d.time.slice(11, 16)}</td><td>{held(d) || '—'}</td><td>{d.size}</td><td>{d.open}</td><td>{d.close}</td><td class="num" class:sell={d.value < 0} class:buy={d.value > 0}>{d.pnl}</td><td><span class="annot"><input class="note tags" data-testid="ig-journal-tag" aria-label="Tags for {d.name} closed {d.time.slice(0, 16).replace('T', ' ')}" title="Tags separated by spaces or commas, such as breakout fomo." placeholder="tags" list="ig-journal-taglist" value={tagsOf(d).join(' ')} onchange={e => tag(d, e.currentTarget.value)} /><input class="note" data-testid="ig-journal-note" aria-label="Note for {d.name} closed {d.time.slice(0, 16).replace('T', ' ')}" placeholder="Add a note" maxlength="500" value={notes[dealKey(d)] ?? ''} onchange={e => note(d, e.currentTarget.value.trim())} /></span></td></tr>{/each}{/each}</tbody></table></div>
            <datalist id="ig-journal-taglist">{#each tagTotals as t}<option value={t.name}></option>{/each}</datalist>
            {#if tagTotals.length}<p class="by-market" data-testid="ig-journal-tags">By tag{#each tagTotals as t}<button class="ui-tab" aria-pressed={tagFilter === t.name} title="Show only deals tagged {t.name}; press again for all." onclick={() => tagFilter = tagFilter === t.name ? '' : t.name}>#{t.name} <b class:sell={t.net < 0} class:buy={t.net > 0}>{money(t.net, cur)}</b> · {t.wins}/{t.trades}</button>{/each}</p>{/if}
            {#if journal.markets.length > 1}<p class="by-market" data-testid="ig-journal-markets">By market{#each journal.markets as m}<span>{m.name} <b class:sell={m.net < 0} class:buy={m.net > 0}>{money(m.net, cur)}</b> · {m.wins}/{m.trades}</span>{/each}</p>{/if}
          {:else}<p class="empty">{deals ? `No closed deals in the last ${journalDays} days.` : 'Loading journal…'}</p>{/if}{/if}</div>
    </section>
    <div class="ticket" id="ig-panel-trade" role="tabpanel" tabindex="0" aria-labelledby="ig-tab-trade"><div class="ticket-head"><div class="sources" role="tablist" aria-label="Trade or Co-pilot" tabindex="-1" onkeydown={tabNavigation}><button class="ui-tab" role="tab" aria-selected={rightTab === 'trade'} tabindex={rightTab === 'trade' ? 0 : -1} onclick={() => rightTab = 'trade'}>Trade</button><button class="ui-tab copilot-tab" role="tab" data-testid="ig-copilot-tab" aria-selected={rightTab === 'copilot'} tabindex={rightTab === 'copilot' ? 0 : -1} title="Your own Claude Code or Codex, through getliq on this computer" onclick={() => rightTab = 'copilot'}>Co-pilot</button></div><span data-testid="ig-ticket-market">{selected?.market.name ?? view?.market.name ?? 'No market selected'}</span></div><IgCopilot context={igContext} bind:marks={aiMarks} hidden={rightTab !== 'copilot'} /><div class="trade-form" hidden={rightTab !== 'trade'}>
        <div class="types" role="group" aria-label="Order type">{#each TICKETS as [id, label]}<button class="ui-tab" data-testid="ig-type-{id}" aria-pressed={ticketType === id} onclick={() => { ticketType = id; review = false; }}>{label}</button>{/each}</div>
        <div class="side" class:sell={direction === 'SELL'}><button class="buy" aria-pressed={direction === 'BUY'} onclick={() => { direction = 'BUY'; review = false; }}><span>Buy</span><b class="num">{quote(selected?.market.offer)}</b></button><span class="gap" title="Spread in points" data-testid="ig-side-spread">{selected ? quote(spread(selected.market)) : '—'}</span><button class="sell" aria-pressed={direction === 'SELL'} onclick={() => { direction = 'SELL'; review = false; }}><span>Sell</span><b class="num">{quote(selected?.market.bid)}</b></button></div>
        <p class="explain" data-testid="ig-order-kind" data-help title="Every order opens its own position; it never nets against or closes one you already hold. Close positions from the Positions tab or the chart.">{ticketType === 'market' ? 'Market order · Fill or kill' : ticketType === 'scale' ? `Scale · ${rungs.length || 'several'} working orders · Good till cancelled` : `${ticketType === 'limit' ? 'Limit' : 'Stop'} order · Good till cancelled`}{#if ticketType === 'limit' || ticketType === 'stop'}{' · drag its line on the chart'}{/if}</p>
        {#if ticketType !== 'market'}<label title={ticketType === 'scale' ? 'Type one level and a Scale to level, or up to 10 levels separated by commas.' : ticketType === 'limit' ? 'Fills at this level or better.' : 'Triggers at this level and fills at the market.'}>{ticketType === 'scale' ? 'Levels' : 'Order level'} <span>{ticketType === 'scale' ? 'start, or a list' : 'price'}</span><input class="ui-field" data-testid="ig-level" inputmode="decimal" bind:value={level} oninput={() => review = false} /></label>{/if}
        {#if scaling && levels.length <= 1}<div class="pair"><label title="Splits the size over working orders spaced evenly from the first level to this one.">Scale to <span>level</span><input class="ui-field" data-testid="ig-scale-to" inputmode="decimal" bind:value={scaleTo} oninput={() => review = false} /></label><label>Orders <span>2–10</span><input class="ui-field" data-testid="ig-scale-count" inputmode="numeric" bind:value={scaleCount} oninput={() => review = false} /></label></div>{/if}
        {#if scaling}<label title="Last order's size divided by the first order's. 1 or empty splits evenly; 2 makes the furthest order twice the nearest.">Size skew <span>last ÷ first · empty = even</span><input class="ui-field" data-testid="ig-scale-skew" inputmode="decimal" bind:value={scaleSkew} oninput={() => review = false} /></label>{/if}
        {#if rungs.length}<p class="explain" data-testid="ig-scale">{rungs.length} orders: {rungs.map(r => `${r.size} at ${r.level}`).join(', ')}</p>{/if}
        <div class="size-row"><label class="size">{scaling ? 'Total size' : 'Size'}<span class="ui-field"><input data-testid="ig-size" aria-label="Size" inputmode="decimal" value={sizeUnit === 'value' && perContract ? valueText : size} oninput={e => setSize(e.currentTarget.value)} /><select aria-label="Size unit" data-testid="ig-size-unit" value={perContract ? sizeUnit : 'contracts'} disabled={!perContract} onchange={e => setUnit(e.currentTarget.value as 'contracts' | 'value')}><option value="contracts">{selected?.unit.toLowerCase() || 'contracts'}</option><option value="value">{account?.currency ?? 'SGD'}</option></select></span></label><label title="Press B to buy or S to sell: sends this saved size on the active market, through review unless Skip review is on.">B / S <span>size</span><input class="ui-field" data-testid="ig-hotkey-size" aria-label="B / S size" aria-describedby="ig-hotkey-help" inputmode="decimal" value={hotkeySize} disabled={!selected} oninput={e => setHotkeySize(e.currentTarget.value)} placeholder="Not set" /></label></div>
        {#if maxSize !== null}<SizeSlider pct={sizePct} onpct={setPct} id="ig" />{/if}
        <p class="explain" id="ig-hotkey-help" hidden={!selected || !hotkeySize.trim() || !hotkeyError}>{hotkeyError}</p>
        <div class="pair exits"><label>Stop <span>{exitUnit === 'pts' ? 'distance' : 'level'}</span><input class="ui-field" data-testid="ig-stop" inputmode="decimal" bind:value={stop} oninput={() => review = false} /></label><label>Take profit <span>{exitUnit === 'pts' ? 'distance' : 'level'}</span><input class="ui-field" data-testid="ig-take-profit" inputmode="decimal" bind:value={takeProfit} oninput={() => review = false} /></label></div>
        <div class="exit-options"><select aria-label="Stop and take profit unit" data-testid="ig-exit-unit" value={exitUnit} onchange={e => { exitUnit = e.currentTarget.value as typeof exitUnit; review = false; }}><option value="pts">In points</option><option value="price">At price</option></select>{#if ticketType === 'market' && selected?.trailing}<label class="inline" title="IG moves the stop after the price by this many points. Needs a stop distance in points.">Trail <input class="ui-field" data-testid="ig-trail" inputmode="decimal" placeholder="pts" bind:value={trailStep} oninput={() => review = false} /></label>{/if}{#if selected?.guaranteed}<label class="check" title="IG charges a premium when a guaranteed stop is triggered, and sets a minimum distance."><input type="checkbox" data-testid="ig-guaranteed" bind:checked={guaranteed} onchange={() => review = false} /> Guaranteed</label>{/if}</div>
        <dl title="Value and margin are estimates from IG's margin bands at the order price. Fees, financing and IG's own margin figure are authoritative.">{#if (selected?.currencies.length ?? 0) > 1}<dt>Currency</dt><dd><select aria-label="Dealing currency" bind:value={currency} onchange={() => review = false}>{#each selected!.currencies as c}<option value={c}>{c}</option>{/each}</select></dd>{/if}{#if perContract !== null}<dt>Value</dt><dd class="num" data-testid="ig-ticket-value">{Number(size) > 0 ? `${number(Number(size) * perContract)} ${account?.currency}` : '—'}{#if sizeUnit === 'value' && Number(size) > 0}<small>{size} {selected?.unit.toLowerCase()}</small>{/if}</dd><dt>Margin</dt><dd class="num" data-testid="ig-ticket-margin">{margin === null ? '—' : `≈ ${number(margin)} ${account?.currency}`}</dd>{/if}{#if exits}<dt title="Loss at the stop and profit at the take profit for this size, before spread, fees and slippage. The ratio is reward for each unit of risk.">Risk / Reward</dt><dd class="num" data-testid="ig-ticket-risk"><span class="sell">{exits.risk === null ? '—' : '−' + number(exits.risk)}</span> / <span class="buy">{exits.reward === null ? '—' : '+' + number(exits.reward)}</span> {currency}{#if exits.ratio !== null}{' · 1:' + number(exits.ratio, 1)}{/if}</dd>{/if}<dt>Available</dt><dd class="num" data-testid="ig-ticket-available">{number(account?.available)} {account?.currency || '—'}</dd><dt>Spread</dt><dd class="num">{selected ? `${quote(spread(selected.market))} pts · ${number(spreadBps(selected.market))} bps` : '—'}</dd></dl>
        {#if invalid}<p class="explain" data-testid="ig-ticket-reason">{invalid}</p>{/if}
        <button class="review" class:sell={direction === 'SELL'} data-testid="ig-review" disabled={!!invalid || busyMarket || sending || busy} onclick={() => skipReview ? submit() : review = true}>{skipReview ? `${direction === 'BUY' ? 'Buy' : 'Sell'} ${size || ''} · ${ticketType === 'market' ? 'market' : ticketType === 'scale' ? `${rungs.length} orders` : `${ticketType} ${levels[0] ?? ''}`}` : `Review ${direction === 'BUY' ? 'buy' : 'sell'}`}</button>
        <label class="check skip" title="Orders, B/S keys, position closes and lines dragged on the chart send at once, without the review dialog. Uncertain deliveries still block new ones."><input type="checkbox" data-testid="ig-skip-review" checked={skipReview} onchange={e => { skipReview = e.currentTarget.checked; save('ig:skip-review', skipReview); }} /> Skip review · send on click</label>
      </div>
      {#if pending}<div class="delivery" role="status" data-testid="ig-delivery"><strong>{pending.status.replaceAll('-', ' ')}</strong><small>{pending.environment} · {pending.accountId}</small><p>{pending.message}</p>{#if pending.reference}<small>Reference {pending.reference}</small>{/if}{#if ['accepted', 'rejected', 'not-submitted'].includes(pending.status)}{#if retry}<button class="ui-tab" data-testid="ig-retry" disabled={sending} onclick={() => { const r = retry!; pending = null; void batch(r.jobs, r.what, r.tag); }}>Retry {retry.jobs.length} failed</button>{/if}<button class="ui-tab" onclick={() => { pending = null; retry = null; }}>Done</button>{:else if pending.reference}<button class="ui-tab" disabled={sending || pending.accountId !== session?.accountId || pending.environment !== session?.environment} onclick={confirm}>Check confirmation</button>{:else if pending.status === 'unconfirmed'}<button class="ui-tab" disabled={sending || pending.accountId !== session?.accountId || pending.environment !== session?.environment} onclick={() => { reconciled = false; reconcile = true; }}>Reconcile in IG</button>{/if}</div>{/if}
    </div>
  </main>
  <footer><span>IG CFD · {connected ? `${session?.environment} · ${account?.currency || 'Select account'}` : 'Disconnected'}</span><span>{#if allowance?.remaining != null}<span data-testid="ig-allowance" title="IG's weekly allowance of historical price points for this API key. Each bar loaded uses one.">Price history {fmtNum(allowance.remaining, 0)}{allowance.total ? ` / ${fmtNum(allowance.total, 0)}` : ''} left</span>{' · '}{/if}<span data-testid="ig-feed">{streaming ? 'Quotes streaming' : `Quotes refresh every ${POLL / 1000}s`}</span> · No automatic order retries</span><BuildProof /></footer>
</div>
{#if login || review || closing || editing || moving || reconcile || cancelling}<div class="scrim"><div class="dialog ui-menu" class:login-dialog={login} onkeydown={dialogKey} {@attach focusLogin} role="dialog" tabindex="-1" aria-modal="true" aria-label={login ? keySetup ? 'IG API key' : 'Connect IG' : cancelling ? cancelling.title : moving ? 'Move order' : closing ? 'Close position' : editing ? 'Edit stop and limit' : reconcile ? 'Reconcile IG request' : 'Review IG order'}>
  {#if login && keySetup}
    <div class="login-heading"><div><h2>IG API key</h2><p>Set up API access separately from your account login.</p></div><button class="ui-tab" aria-label="Close API key dialog" disabled={loading} onclick={closeLogin}>✕</button></div>
    <form class="login-form" onsubmit={e => { e.preventDefault(); void saveKey(); }}>
      {#if keyConfigured}<p class="key-status">An API key is saved for this browser. Leave this field empty to keep it.</p>{/if}
      <div class="login-field"><label for="ig-api-key">{keyConfigured ? 'Replace API key' : 'API key'}</label><div class="ui-field credential-field"><input id="ig-api-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Paste your IG API key" aria-describedby="ig-key-help" bind:value={apiKey} minlength="10" maxlength="100" pattern="[A-Za-z0-9_-]+" required /></div><p id="ig-key-help" class="field-help">Create a personal key in My IG → Settings → API keys. <a href="https://labs.ig.com/getting-started.html" target="_blank" rel="noreferrer">IG’s setup guide</a></p></div>
      {#if error}<p class="login-error" role="alert" {@attach node => node.scrollIntoView({ block: 'nearest' })}>{error}</p>{/if}
      <p class="login-privacy">Saved encrypted for 30 days in this browser. Signing out keeps it for your next login. IG checks the key when you sign in.</p>
      {#if keyConfigured}<div class="key-controls"><button type="button" class="ui-tab" disabled={loading} onclick={forgetKey}>Forget key</button>{#if continueLogin}<button type="button" class="ui-tab" disabled={loading} onclick={() => { apiKey = ''; keySetup = false; }}>Back to login</button>{/if}</div><p class="field-help">Changes apply to your next sign-in. Your current login stays active.</p>{/if}
      <div class="actions"><button type="button" class="ui-tab" disabled={loading} onclick={closeLogin}>Cancel</button><button class="connect-button" disabled={loading || !/^[A-Za-z0-9_-]{10,100}$/.test(apiKey.trim())}>{loading ? 'Saving…' : continueLogin ? 'Save and continue' : 'Save key'}</button></div>
    </form>
  {:else if login}
    <div class="login-heading"><div><h2>Connect IG</h2><p>Use your live IG trading login.</p></div><button class="ui-tab" aria-label="Close connection dialog" disabled={loading} onclick={closeLogin}>✕</button></div>
    <form class="login-form" onsubmit={e => { e.preventDefault(); if (!usernameError) void signIn(); }}>
      <div class="key-status"><span>API key saved</span><button type="button" class="ui-tab" disabled={loading} onclick={() => { password = ''; error = ''; continueLogin = true; keySetup = true; }}>Change</button></div>
      <div class="login-field"><div class="field-label"><label for="ig-username">IG username</label><a href="https://www.ig.com/sg/lost-details" target="_blank" rel="noreferrer">Find my username</a></div><div class="ui-field credential-field" class:invalid={!!usernameError}><input id="ig-username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Your IG trading username" aria-describedby={usernameError ? 'ig-user-help ig-user-error' : 'ig-user-help'} aria-invalid={!!usernameError} bind:value={identifier} required /></div><p id="ig-user-help" class="field-help">Your trading username, separate from your API key and email.</p>{#if usernameError}<p id="ig-user-error" class="field-error" aria-live="polite">{usernameError}</p>{/if}</div>
      <div class="login-field"><label for="ig-password">Password</label><div class="ui-field credential-field"><input id="ig-password" type="password" autocomplete="current-password" placeholder="Your IG account password" aria-describedby="ig-password-help" bind:value={password} required /></div><p id="ig-password-help" class="field-help">The password for the IG username above.</p></div>
      <label class="check remember"><input type="checkbox" data-testid="ig-remember" checked={remember} onchange={e => { remember = e.currentTarget.checked; save('ig:remember', remember); }} /> <span>Stay signed in on this device<small class="field-help">Keeps this login encrypted in a secure cookie for 30 days and signs in again when IG's session ends. Sign out forgets it.</small></span></label>
      {#if error}<p class="login-error" role="alert" {@attach node => node.scrollIntoView({ block: 'nearest' })}>{error}</p>{/if}
      <div class="actions"><button type="button" class="ui-tab" disabled={loading} onclick={closeLogin}>Cancel</button><button class="connect-button" disabled={loading || !keyConfigured || !identifier || !password || !!usernameError}>{loading ? 'Connecting…' : 'Connect live'}</button></div>
    </form>
  {:else if reconcile && pending}<h2>Reconcile IG request</h2><p>Open IG separately and inspect positions and activity history for <strong>{pending.accountId} · {pending.environment}</strong>. Confirm that this request has finished processing and your account reflects its outcome. If it is still uncertain, keep the request pending.</p><p>Request {pending.id}. Clearing this notice does not confirm execution or resend the request.</p><label class="reconcile-check"><input type="checkbox" bind:checked={reconciled} /> I checked this account in IG and reconciled the request.</label><div class="actions"><button class="ui-tab" onclick={() => reconcile = false}>Keep pending</button><button disabled={!reconciled || pending.accountId !== session?.accountId || pending.environment !== session?.environment} onclick={clearUncertain}>Mark reconciled</button></div>{:else if editing}{@const ep = record(editing.row.position)}{@const em = record(editing.row.market)}<h2>Edit stop and limit</h2><p>{em.instrumentName} · {ep.direction === 'BUY' ? '+' : '−'}{quote(numeric(ep.size))} at {quote(numeric(ep.level))} · Sell {quote(numeric(em.bid))} / Buy {quote(numeric(em.offer))}</p><label>Stop level <span>empty removes it</span><input class="ui-field" data-testid="ig-edit-stop" inputmode="decimal" bind:value={editing.stop} /></label><label>Limit level <span>empty removes it</span><input class="ui-field" data-testid="ig-edit-limit" inputmode="decimal" bind:value={editing.limit} /></label>{#if editError}<p class="explain" role="alert">{editError}</p>{/if}<div class="actions"><button class="ui-tab" onclick={() => editing = null}>Cancel</button><button data-testid="ig-edit-confirm" disabled={sending || busy || !!editError} onclick={editPosition}>Save levels</button></div>{:else if cancelling}<h2>{cancelling.title}</h2><p>Cancel these {cancelling.rows.length} working orders on your {session?.environment} account? They are cancelled one at a time.</p><p>{cancelling.rows.map(row => `${record(row.marketData).instrumentName} ${record(row.workingOrderData).direction === 'BUY' ? 'buy' : 'sell'} ${record(row.workingOrderData).orderSize} at ${record(row.workingOrderData).orderLevel}`).join(' · ')}</p><div class="actions"><button class="ui-tab" onclick={() => cancelling = null}>Keep</button><button data-testid="ig-cancel-confirm" disabled={sending || busy} onclick={() => cancelRows(cancelling!.rows)}>Cancel {cancelling.rows.length} orders</button></div>{:else if moving}{@const mo = record(moving.row.workingOrderData)}<h2>Move order</h2><p>Move the {mo.direction === 'BUY' ? 'buy' : 'sell'} {text(mo.orderType).toLowerCase()} of {quote(numeric(mo.orderSize))} on {record(moving.row.marketData).instrumentName} from {quote(numeric(mo.orderLevel))} to <strong>{moving.level}</strong> on your {session?.environment} account? Its size, stop and limit distances stay as they are.</p><div class="actions"><button class="ui-tab" onclick={() => moving = null}>Cancel</button><button data-testid="ig-move-confirm" disabled={sending || busy} onclick={moveOrder}>Move to {moving.level}</button></div>{:else if closing}<h2>Close position</h2><p>Close {number(numeric(record(closing.position).size), 4)} of {record(closing.market).instrumentName} at the available market price on your {session?.environment} account?</p><div class="actions"><button class="ui-tab" onclick={() => closing = null}>Cancel</button><button disabled={sending || busy} onclick={closePosition}>Confirm close</button></div>{:else}<h2>Review {direction.toLowerCase()}</h2><p>{selected?.market.name}</p><dl><dt>Account</dt><dd>{account?.id} · {session?.environment}</dd><dt>Size</dt><dd>{size} {selected?.unit.toLowerCase()}{rungs.length ? ` over ${rungs.length} orders` : ''}</dd><dt>Dealing currency</dt><dd>{currency}</dd><dt>Order</dt><dd>{rungs.length ? `${rungs.map(r => `${r.size} at ${r.level} (${orderKind(direction === 'BUY', r.level, selected!.market) === 'LIMIT' ? 'limit' : 'stop'})`).join(', ')} · good till cancelled` : kind ? `${kind === 'LIMIT' ? 'Limit' : 'Stop'} at ${levels[0]} · good till cancelled` : 'Market · fill or kill'}</dd><dt>Stop / take profit</dt><dd>{stop || 'None'} / {takeProfit || 'None'}{stop || takeProfit ? exitUnit === 'pts' ? ' pts' : ' (levels)' : ''}{guaranteed ? ' · guaranteed' : ''}{trailing ? ` · trailing ${trailStep} pts` : ''}</dd>{#if margin !== null}<dt>Margin</dt><dd>≈ {number(margin)} {account?.currency}</dd>{/if}</dl><p>{kind ? 'The order waits at IG until the market reaches its level or you cancel it.' : 'Execution can differ from the displayed quote.'} {rungs.length ? 'Orders are sent one at a time. Any that IG rejects can be retried afterwards; an uncertain result stops the rest. Each fill opens a separate position.' : 'This opens a separate position.'}</p><div class="actions"><button class="ui-tab" onclick={() => review = false}>Cancel</button><button data-testid="ig-confirm" disabled={sending || !!invalid || busy} onclick={submit}>Confirm {session?.environment} {direction.toLowerCase()}</button></div>{/if}
</div></div>{/if}

<style>
  /* Buy green, sell red on the IG screen; Paper and Bloomberg already pair them. */
  :global(:root:has(.ig-app):is([data-theme='hyperliquid'], [data-theme='getliq'], :not([data-theme]))) { --buy: #2ebd85; --buy-text: #45d49a; --sell: #f6465d; --sell-action: #f6465d; --sell-text: #ff6b7f; --chart-up: #2ebd85; --chart-down: #f6465d; }
  .ig-app { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
  header, footer { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 6px 12px; background: var(--panel); }
  header { border-bottom: 1px solid var(--line); } footer { justify-content: space-between; color: var(--dim); font-size: 10px; border-top: 1px solid var(--line); }
  .account-toggle { display: none; } .account-summary { display: contents; }
  header select { max-width: 260px; font-size: 12px; }
  .brand { display: inline-flex; align-items: center; gap: 5px; color: var(--bright); font-size: 16px; font-weight: 650; text-decoration: none; white-space: nowrap; } .brand span { font-weight: 400; color: var(--dim); }
  .brand img { border-radius: var(--radius); }
  .header-actions .connect { background: var(--accent); color: var(--bg); font-weight: 600; padding: 6px 14px; }
  .header-actions { display: flex; gap: 6px; margin-left: auto; } .funds { display: flex; gap: 4px 16px; margin: 0; font-size: 12px; } .funds div { display: grid; gap: 1px; } .funds dt { color: var(--dim); font-size: 10px; } .funds dd { margin: 0; color: var(--bright); white-space: nowrap; } .funds dd.buy { color: var(--buy-text); } .funds dd.sell { color: var(--sell-text); } .environment { color: var(--warn-text); font-size: 12px; }
  .phone-tabs, .phone-instrument { display: none; }
  main { flex: 1; min-height: 0; display: grid; grid-template-columns: 272px minmax(0, 1fr) 284px; gap: 1px; background: var(--gutter); }
  main > * { min-width: 0; min-height: 0; background: var(--panel); } .markets, .ticket { padding: 10px 12px; }
  .markets { display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
  .section-title, .chart-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  h1, h2 { margin: 0; color: var(--bright); font-size: 13px; font-weight: 600; } .section-title { flex: none; }
  .count { color: var(--accent); font-size: 11px; font-weight: 500; }
  .sources { display: flex; gap: 2px; } .sources .ui-tab { padding: 4px 8px; font-weight: 600; font-size: 13px; }
  .search { display: flex; gap: 5px; } .search-field { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
  .search-field input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; padding: 5px 8px; }
  .search-field .clear { flex: none; background: none; color: var(--dim); padding: 2px 8px; }
  .filters { display: flex; align-items: center; gap: 8px; } .filters select { flex: 1; min-width: 0; font-size: 12px; } .filters label { display: flex; align-items: center; gap: 5px; color: var(--dim); font-size: 11px; white-space: nowrap; }
  .chips, .categories, .markets nav { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; }
  .chips .ui-tab { padding: 2px 8px; font-size: 11px; text-transform: capitalize; }
  .categories .ui-tab, .markets nav .ui-tab { max-width: 100%; white-space: normal; text-align: left; font-size: 12px; } .markets nav span { color: var(--faint); }
  .peer-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; } .peer-controls .ui-tab { font-size: 11px; white-space: normal; text-align: left; }
  .bulk { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0; }
  .positions.tall { flex-basis: clamp(200px, 42vh, 460px); }
  .journal-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding-bottom: 4px; } .journal-stats { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0; font-size: 12px; } .journal-stats div { display: flex; gap: 6px; align-items: baseline; } .journal-stats dt { color: var(--dim); font-size: 10px; } .journal-stats dd { margin: 0; font-variant-numeric: tabular-nums; }
  .history tr.day td { padding-top: 10px; color: var(--dim); font-size: 11px; } .annot { display: flex; gap: 4px; } .history .tags { flex: 0 0 13ch; min-width: 0; } .by-market .ui-tab { padding: 0 6px; font-size: 11px; } .history .note { flex: 1; width: 100%; min-width: 0; padding: 2px 6px; font-size: 11px; text-align: left; } .history td:last-child { width: 38%; }
  .by-market { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; color: var(--dim); font-size: 11px; } .history .day b, .by-market b { font-weight: 500; font-variant-numeric: tabular-nums; }
  .explain, .empty { margin: 0; color: var(--dim); font-size: 11px; line-height: 1.6; } .empty { padding: 14px 0; }
  .market-table, .position-table, .ticket { overflow: auto; scrollbar-width: thin; scrollbar-color: var(--dim) var(--panel); }
  .market-table { flex: 1; min-height: 0; margin: 0 -12px; } table { width: 100%; } th { color: var(--dim); font-weight: 400; font-size: 10px; white-space: nowrap; } th, td { padding: 6px 8px; text-align: right; } th:first-child, td:first-child { text-align: left; } td { border-bottom: 1px solid var(--gutter); font-size: 12px; }
  .market-table th:first-child, .market-table td:first-child { padding-left: 12px; } .market-table th:last-child, .market-table td:last-child, .market-table .spread-value { padding-right: 12px; }
  .market-table :is(th, td):nth-child(2), .market-table :is(th, td):nth-child(3), .market-table :is(th, td):nth-child(4), .market-table :is(th, td):nth-child(6) { display: none; }
  .market-table td:first-child { white-space: normal; } .market-table th { position: sticky; top: 0; z-index: 1; background: var(--panel); }
  .market-table tbody tr:hover { background: var(--gutter); } tr.selected { background: var(--selected-bg); color: var(--selected-text); }
  .market-cell { display: flex; align-items: flex-start; gap: 4px; } .market-cell > div { min-width: 0; }
  .star { flex: none; background: none; color: var(--faint); padding: 1px 4px 0 0; line-height: 1.3; } .star:hover { color: var(--warn); } .star.on { color: var(--warn); }
  .market-name { padding: 0; background: none; color: var(--bright); text-align: left; white-space: normal; min-height: 20px; font-weight: 500; } small { display: block; font-size: 10px; color: var(--dim); } .market-status { margin-top: 1px; } .best { color: var(--accent); font-weight: 500; }
  .spread-value { white-space: nowrap; } .spread-value > span { color: var(--bright); font-weight: 500; }
  .market-footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10px; color: var(--dim); }
  .workspace { display: flex; flex-direction: column; overflow: hidden; }
  .instruments { flex: none; display: flex; align-items: center; gap: 2px; padding: 4px 6px; overflow-x: auto; scrollbar-width: thin; border-bottom: 1px solid var(--line); }
  .instrument { flex: none; display: flex; align-items: center; border-radius: var(--radius); }
  .instrument:has(.open[aria-current='true']) { background: var(--selected-bg); }
  .instrument .open { display: flex; align-items: baseline; gap: 6px; background: none; color: var(--dim); padding: 4px 4px 4px 8px; font-size: 12px; white-space: nowrap; }
  .instrument .open[aria-current='true'] { color: var(--selected-text); font-weight: 600; } .instrument .open:hover:not(:disabled) .name { color: var(--bright); }
  .instrument .num { font-size: 11px; font-weight: 400; } .instrument .open[aria-current='true'] .num:not(.dim) { color: var(--text); }
  .instrument .close { background: none; color: var(--faint); padding: 4px 6px; font-size: 10px; } .instrument .close:hover:not(:disabled) { color: var(--bright); }
  .instruments .add { flex: none; padding: 2px 8px; }
  .chart-heading { flex: none; padding: 8px 12px; flex-wrap: wrap; } .title { min-width: 0; } .chart-heading h1 { font-size: 15px; } .title span { display: block; color: var(--dim); font-size: 10px; }
  .stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; font-size: 12px; } .stats div { display: grid; gap: 1px; } .stats dt { color: var(--dim); font-size: 10px; } .stats dd { margin: 0; text-align: left; white-space: nowrap; } .stats .warn { color: var(--warn-text); } .chart-spread { color: var(--bright); }
  .chart-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: auto; } .layout, .intervals { display: flex; gap: 1px; } .interval-select { display: none; } .layout .ui-tab { min-width: 28px; }
  .charts { position: relative; flex: 1; min-height: 120px; display: flex; flex-direction: column; }
  .charts.grid { display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: minmax(0, 1fr); gap: 1px; background: var(--line); }
  .charts.grid[data-count='3'] > :first-child { grid-row: span 2; }
  .tile { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--panel); }
  .tile-head { flex: none; display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 5px 10px; background: none; border-radius: 0; color: var(--dim); font-size: 11px; text-align: left; white-space: nowrap; overflow: hidden; }
  .tile-head b { color: var(--text); font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; } .tile-head[aria-pressed='true'] { background: var(--selected-bg); color: var(--selected-text); } .tile-head[aria-pressed='true'] b { color: var(--selected-text); }
  .chart-wrap { position: relative; flex: 1; min-height: 0; } .chart-note { position: absolute; inset: 0; display: grid; place-items: center; color: var(--dim); background: var(--panel); padding: 20px; text-align: center; pointer-events: none; } .chart-note button { pointer-events: auto; } .chart-note p { margin: 0 0 10px; }
  .positions { flex: 0 0 clamp(140px, 24vh, 220px); min-height: 0; padding: 10px 12px; overflow: auto; border-top: 1px solid var(--line); } .positions .section-title { margin-bottom: 6px; } .positions .section-title { flex-wrap: wrap; } .level { padding: 0 4px; min-height: 20px; } .phone-edit { display: none; }
  .positions .market-name { font-size: 12px; }
  .ticket { display: flex; flex-direction: column; gap: 10px; } .trade-form { display: contents; } .trade-form[hidden] { display: none; } .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; } .ticket label, .dialog label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 5px; color: var(--dim); font-size: 11px; } label > input:not([type=checkbox]) { width: 100%; color: var(--text); }
  .ticket-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; } .ticket-head > span { min-width: 0; color: var(--bright); font-size: 12px; font-weight: 500; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .types { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; } .types .ui-tab { padding: 5px 0; text-align: center; font-size: 12px; }
  .side { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: stretch; gap: 4px; padding: 2px; background: var(--surface); border-radius: var(--radius); }
  .side button { display: grid; align-content: center; justify-items: center; gap: 1px; min-height: var(--ctl); padding: 4px; border: 0; border-radius: var(--radius); background: transparent; color: var(--buy-text); font: inherit; font-size: 12px; cursor: pointer; transition: background-color .1s, color .1s; }
  .side button.sell { color: var(--sell-text); }
  .side button[aria-pressed='true'] { background: var(--buy); color: var(--bg); font-weight: 600; }
  .side button.sell[aria-pressed='true'] { background: var(--sell-action); }
  .side b { font-size: 13px; font-variant-numeric: tabular-nums; }
  .side .gap { align-self: center; color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
  .size-row { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 8px; align-items: end; }
  .size > .ui-field { display: flex; align-items: center; width: 100%; } .size input { flex: 1; min-width: 0; border: 0; background: none; outline: none; padding: 5px 8px; color: var(--text); }
  .size select { flex: none; max-width: 50%; border: 0; background: none; color: var(--dim); font-size: 11px; padding: 0 4px; }
  .ticket :global(.slider .pct) { height: calc(var(--ctl) * .8); padding: 0 6px; } .ticket :global(.slider .pct input) { text-align: right; }
  .exit-options { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: -4px; } .exit-options select { font-size: 11px; padding: 2px 4px; }
  .ticket label.inline { flex-wrap: nowrap; align-items: center; justify-content: flex-start; } .inline input { width: 7ch; padding: 3px 6px; }
  .ticket label.check { flex-wrap: nowrap; justify-content: flex-start; align-items: center; cursor: pointer; } .skip { margin-top: -4px; }
  dd small { display: block; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 7px; margin: 5px 0; font-size: 11px; } dt { color: var(--dim); } dd { margin: 0; text-align: right; } dd select { padding: 1px 4px; font-size: 11px; } dl { align-items: center; } .review { min-height: var(--ctl); flex: none; background: var(--buy); color: var(--bg); font-weight: 600; }
  .review.sell { background: var(--sell-action); }
  .review:disabled { background: var(--surface); color: var(--dim); opacity: 1; }
  .message { flex: none; padding: 8px 12px; color: var(--warn-text); background: var(--surface); } .delivery { padding: 8px 0; overflow-wrap: anywhere; } .delivery strong { text-transform: capitalize; } .delivery p { font-size: 12px; }
  .remember { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; } .remember small { display: block; margin-top: 2px; }
  .dialog.login-dialog { width: min(480px, 100%); padding: 24px; scroll-padding-block: 20px 100px; }
  .login-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
  .login-heading h2 { font-size: 18px; line-height: 1.4; font-weight: 600; }
  .login-heading p { margin: 6px 0 0; line-height: 1.5; }
  .login-heading button { flex: none; min-width: 28px; padding: 4px; color: var(--dim); }
  .login-dialog .login-form { gap: 18px; }
  .login-field { display: grid; gap: 7px; }
  .field-label, .key-status, .key-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .key-status { margin: 0; padding: 8px 10px; background: var(--surface); color: var(--dim); font-size: 12px; border-radius: var(--radius); }
  .login-dialog a { color: var(--accent); font-size: 12px; }
  .login-dialog .login-field label { display: block; color: var(--bright); font-size: 13px; font-weight: 500; }
  .credential-field { background: var(--bg); }
  .credential-field:focus-within { background: var(--surface); }
  .credential-field input { width: 100%; min-height: 42px; padding: 9px 11px; background: transparent; border: 0; outline: none; color: var(--text); font-size: max(14px, var(--fs)); caret-color: var(--accent); }
  .credential-field input::placeholder { color: var(--dim); opacity: 0.8; }
  .credential-field input:autofill { -webkit-text-fill-color: var(--text); caret-color: var(--accent); }
  .credential-field.invalid { border-color: var(--warn); }
  .login-dialog .field-help, .login-dialog .field-error, .login-dialog .login-privacy { margin: 0; font-size: 12px; line-height: 1.5; }
  .login-dialog .field-error { color: var(--warn-text); }
  .login-dialog .login-error { margin: 0; padding: 10px 12px; font-size: 12px; line-height: 1.5; color: var(--warn-text); background: var(--surface); border-radius: var(--radius); }
  .login-dialog .login-privacy { color: var(--dim); }
  .login-form .actions { position: sticky; bottom: -24px; z-index: 1; margin: 0 -24px -24px; padding: 16px 24px 24px; background: var(--panel); border-top: 1px solid var(--line); }
  .login-form .actions button { min-height: 40px; padding: 8px 14px; }
  .login-form .connect-button { background: var(--accent); color: var(--bg); font-weight: 600; }
  .scrim { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 16px; background: #0008; } .dialog { width: min(440px, 100%); max-height: calc(100dvh - 32px); overflow: auto; padding: 20px; } .dialog p { color: var(--dim); font-size: 13px; } .dialog form { display: grid; gap: 12px; } .dialog .reconcile-check { flex-wrap: nowrap; justify-content: flex-start; align-items: flex-start; gap: 8px; } .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
  @media (min-width: 901px) and (max-width: 1100px) { main { grid-template-columns: 236px minmax(0, 1fr) 260px; } .markets, .ticket { padding: 10px; } .market-table { margin: 0 -10px; } .stats { display: none; } }
  @media (max-width: 900px) {
    .credential-field input { font-size: max(16px, var(--fs)); }
    header { padding: calc(6px + env(safe-area-inset-top)) 10px 6px; gap: 7px; } .brand { font-size: 15px; } .funds { gap: 4px 10px; font-size: 11px; } .position-table :is(th, td):nth-child(2), .position-table :is(th, td):nth-child(4), .position-table :is(th, td):nth-child(5), .position-table :is(th, td):nth-child(7), .position-table :is(th, td):nth-child(8) { display: none; } .history :is(th, td):nth-child(7), .history :is(th, td):nth-child(8) { display: table-cell; } .annot { flex-direction: column; } .history .tags { flex: none; } .header-actions { gap: 4px; } header select { max-width: 100%; }
    .phone-tabs { flex: none; display: flex; gap: 4px; padding: 5px 8px; background: var(--panel); border-bottom: 1px solid var(--line); } .phone-tabs button { font-size: max(11px, calc(var(--fs) * 0.833)); flex: 1; padding: 6px 4px; }
    .phone-instrument { flex: none; display: flex; gap: 4px; padding: 4px 8px; background: var(--panel); border-bottom: 1px solid var(--line); } .phone-instrument select { flex: 1; min-width: 0; }
    main { display: flex; flex-direction: column; } .interval-select { display: block; } .copilot-tab { display: none; } .phone-edit { display: inline-block; min-width: 28px; padding: 0 4px; } .orders :is(th, td):nth-child(5), .orders :is(th, td):nth-child(6), .history :is(th, td):nth-child(3), .history :is(th, td):nth-child(4), .history :is(th, td):nth-child(5), .history :is(th, td):nth-child(6) { display: none; } .history td:last-child { width: 34%; } .markets, .positions, .ticket, .instruments, .find, .layout, .intervals { display: none; } .workspace { flex: 1; } .charts { min-height: 0; } .chart-heading { padding: 8px 10px; } .chart-actions { margin-left: 0; } .stats { gap: 2px 12px; }
    main[data-view=markets] .markets { display: flex; flex: 1; overflow: auto; } .markets > :not(.market-table) { flex-shrink: 0; } .market-table { flex: 1 0 180px; min-height: 180px; margin: 0 -12px; } main[data-view=markets] .workspace, main[data-view=trade] .workspace { display: none; }
    main[data-view=trade] .ticket { display: flex; flex: 1; } .review { position: sticky; bottom: 0; z-index: 1; box-shadow: 0 0 0 8px var(--panel); } main[data-view=positions] .chart-heading, main[data-view=positions] .charts { display: none; } main[data-view=positions] .positions { display: block; flex: 1; }
    footer { padding: 6px 10px; } footer > span:nth-child(2) { display: none; }
  }
  @media (max-width: 450px) {
    .chart-account .environment, .chart-account .account-summary:not(.expanded) { display: none; }
    .chart-account .account-toggle { display: inline-block; color: var(--warn-text); }
    .header-actions { flex-wrap: wrap; }
    .chart-account:has(.account-toggle) .header-actions { width: 100%; justify-content: space-between; }
    .header-actions .ui-tab { font-size: max(12px, calc(var(--fs) * .9)); padding-inline: 6px; }
    .environment { font-size: 11px; } .stats div:last-child { display: none; } }
</style>
