<script lang="ts">
  import { onMount } from 'svelte';
  import { array, barsOf, eligibleAccount, fresh, HISTORY, isResolution, liveBar, marketOf, mergeBars, numeric, positionPnl, record, RESOLUTIONS, spread, spreadBps, text, type Bar, type Detail, type Market, type Resolution, type Session } from '$lib/ig/markets';
  import IgChart, { type Line } from '$lib/ig/IgChart.svelte';
  import ThemePicker from '$lib/ui/ThemePicker.svelte';
  import { THEMES } from '$lib/settings/themes';
  import { load, save } from '$lib/util/storage';
  import { isTyping, tabNavigation, tabStops } from '$lib/ui/touch';
  import { fmtNum } from '$lib/util/format';

  class ApiError extends Error {
    status: number; deliveryStatus: string;
    constructor(status: number, message: string, deliveryStatus = '') { super(message); this.status = status; this.deliveryStatus = deliveryStatus; }
  }
  type Pending = { id: string; accountId: string; environment: 'live'; reference?: string; status: string; message: string };
  type Draft = { direction: 'BUY' | 'SELL'; size: string; currency: string; stop: string; takeProfit: string };
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
  let category = $state('all'), sameExpiry = $state(true), ranking = $state<'bps' | 'points' | 'name'>('bps'), source = $state<'browse' | 'watch'>('browse');
  let now = $state(Date.now()), fetched = $state(0), searching = $state(''), searchTimer: ReturnType<typeof setTimeout> | undefined;
  let views = $state<View[]>([]), active = $state(''), layout = $state<'single' | 'grid'>('single'), innerWidth = $state(1440);
  let watchlist = $state<Market[]>([]), quotes = $state<Record<string, Market>>({});
  const inflight = new Map<string, Promise<void>>();
  let averages = $state(true), allowance = $state<{ remaining: number | null; total: number | null } | null>(null);
  const view = $derived(views.find(v => v.market.epic === active));
  const selected = $derived(view?.detail ?? null);
  const busyMarket = $derived(!!view?.busy);
  const grid = $derived(layout === 'grid' && innerWidth > 900);
  const shown = $derived.by(() => {
    if (!grid) return view ? [view] : [];
    const first = views.slice(0, GRID);
    return !view || first.includes(view) ? first : [...first.slice(0, GRID - 1), view];
  });
  let direction = $state<'BUY' | 'SELL'>('BUY'), size = $state(''), currency = $state('SGD'), stop = $state(''), takeProfit = $state('');
  let hotkeySizes = $state<Record<string, string>>({});
  const hotkeySize = $derived(selected ? hotkeySizes[selected.market.epic] ?? '' : '');
  const validSize = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 1e9;
  const hotkeyError = $derived(!hotkeySize.trim() ? 'Set a B/S size for this market.' : !validSize(hotkeySize) ? 'Enter a positive B/S size up to 1,000,000,000.' : selected?.minSize != null && Number(hotkeySize) < selected.minSize ? `Minimum B/S size is ${selected.minSize}.` : '');
  let reconcile = $state(false), reconciled = $state(false);
  let review = $state(false), sending = $state(false), pending = $state<Pending | null>(null);
  let positions = $state<Record<string, any>[]>([]), closing = $state<Record<string, any> | null>(null);
  let phoneTab = $state('chart');
  const phoneTabs = [['chart', 'Chart'], ['markets', 'Markets'], ['trade', 'Trade'], ['positions', 'Positions']] as const;
  let theme = $state('hyperliquid'), searchEl: HTMLInputElement;
  const findMarket = () => { phoneTab = 'markets'; source = 'browse'; requestAnimationFrame(() => searchEl?.focus()); };
  const account = $derived(session?.accounts.find(a => a.id === session?.accountId));
  const watched = (epic: string) => watchlist.some(m => m.epic === epic);
  const listed = $derived(source === 'watch' ? watchlist.map(m => quotes[m.epic] ?? m).filter(m => !query.trim() || `${m.name} ${m.epic}`.toLowerCase().includes(query.trim().toLowerCase())) : markets);
  const types = $derived([...new Set(listed.map(m => m.type).filter(Boolean))].sort());
  const rows = $derived(listed.filter(m => category === 'all' || m.type === category).filter(m => !sameExpiry || !selected || m.expiry === selected.market.expiry).toSorted((a, b) => {
    if (ranking === 'name') return a.name.localeCompare(b.name);
    const score = (m: Market) => fresh(m, now) ? (ranking === 'bps' ? spreadBps(m) : spread(m)) ?? Infinity : Infinity;
    return score(a) - score(b) || a.name.localeCompare(b.name);
  }));
  const best = $derived(ranking === 'bps' ? rows.find(m => fresh(m, now))?.epic : undefined);
  const invalid = $derived(!eligibleAccount(account) ? 'Select an enabled SGD CFD account.' : !selected ? 'Select a market.' : !fresh(selected.market, now) ? 'Refresh this market for a current, undelayed quote.' : !selected.marketOrders ? 'IG does not allow market orders for this instrument.' : selected.minSize === null ? 'IG has not supplied a supported minimum size.' : !selected.currencies.includes(currency) ? 'Choose an available dealing currency.' : !(Number(size) >= selected.minSize && Number(size) > 0) ? `Minimum size is ${selected.minSize}.` : (stop && !(Number(stop) > 0)) || (takeProfit && !(Number(takeProfit) > 0)) ? 'Stop and limit distances must be positive.' : '');
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
  const defaults = (d: Detail | null): Draft => ({ direction: 'BUY', size: d?.minSize?.toString() ?? '', currency: d?.currencies.includes('SGD') ? 'SGD' : d?.currencies[0] ?? 'SGD', stop: '', takeProfit: '' });
  function setDraft(d: Draft) { direction = d.direction; size = d.size; currency = d.currency; stop = d.stop; takeProfit = d.takeProfit; }
  function activate(epic: string) {
    if (epic !== active) {
      if (view) view.draft = { direction, size, currency, stop, takeProfit };
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
    return positions.filter(row => record(row.market).epic === epic).flatMap(row => {
      const p = record(row.position), pnl = positionPnl(row), level = numeric(p.level), stop = numeric(p.stopLevel), limit = numeric(p.limitLevel);
      const entry: Line[] = level === null ? [] : [{ price: level, title: `${p.direction === 'BUY' ? '+' : '−'}${quote(numeric(p.size))} · ${money(pnl?.value ?? null, p.currency)}`, tone: (pnl?.points ?? 0) < 0 ? 'sell' : 'buy' }];
      return [...entry, ...(stop === null ? [] : [{ price: stop, title: 'Stop', tone: 'sell' as const }]), ...(limit === null ? [] : [{ price: limit, title: 'Limit', tone: 'buy' as const }])];
    });
  }
  function openMarket(m: Market) {
    phoneTab = 'chart';
    if (!views.some(v => v.market.epic === m.epic)) {
      if (view) view.draft = { direction, size, currency, stop, takeProfit };
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
      else setDraft(fill({ direction, size, currency, stop, takeProfit }));
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
    if (!['b', 's'].includes(side) || document.hidden || !connected || !selected || loading || busyMarket || sending || pending || login || review || closing || reconcile || document.querySelector('[role=dialog], [role=menu], details.theme[open], [aria-label="Theme choices"]')) return;
    e.preventDefault(); phoneTab = 'trade';
    if (hotkeyError) { error = hotkeyError; document.querySelector<HTMLInputElement>('[data-testid="ig-hotkey-size"]')?.focus(); return; }
    direction = side === 'b' ? 'BUY' : 'SELL'; size = hotkeySize;
    if (invalid) { error = invalid; return; }
    error = ''; review = true;
  }
  function signedOut() { connection++; browseRequest++; session = null; connected = false; views = []; active = ''; quotes = {}; positions = []; review = false; closing = null; reconcile = false; setDraft(defaults(null)); }
  async function api<T>(path: string, method = 'GET', value: unknown = undefined): Promise<T> {
    const epoch = connection;
    const response = await fetch(`/api/ig/${path}`, { method, credentials: 'same-origin', headers: value ? { 'content-type': 'application/json' } : {}, ...(value ? { body: JSON.stringify(value) } : {}) });
    let result;
    try { result = await response.json(); } catch { throw new Error('IG service is unavailable on this deployment.'); }
    if (!response.ok) {
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
    if (epoch !== connection) return;
    session = next; positions = nextPositions; connected = true;
    noteQuotes(nextPositions.flatMap(row => marketOf(row.market) ?? []));
  }
  let beat = 0;
  function poll() {
    if (document.hidden || !connected || loading || sending || login || review || closing) return;
    if (view && !view.busy) void loadView(active);
    if (++beat % 3 === 0) refreshAccount().catch(() => {});
  }
  async function signIn() {
    const epoch = ++connection; browseRequest++; views = []; active = ''; positions = [];
    await run(async () => {
      let next: Session;
      try { next = await api<Session>('session', 'POST', { identifier: identifier.trim(), password, environment }); } finally { password = ''; }
      if (epoch !== connection) return;
      session = next;
      apiKey = ''; connected = true; login = false; notice = '';
      positions = array(record(await api('positions')).positions).map(record);
      restoreWorkspace();
      await browse();
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
    if (sending || pending || invalid || !selected) return;
    sending = true; review = false; error = '';
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 26);
    const intent = { accountId: session!.accountId, environment: session!.environment };
    pending = { id, ...intent, reference: id, status: 'sending', message: 'Sending to IG…' };
    try {
      const result = await api<{ status: string; reference?: string; error?: string }>('order', 'POST', { id, ...intent, epic: selected.market.epic, direction, size: Number(size), currency, ...(stop ? { stopDistance: Number(stop) } : {}), ...(takeProfit ? { limitDistance: Number(takeProfit) } : {}) });
      pending = { id, ...intent, reference: result.reference, status: result.status, message: result.error || 'Submitted to IG; execution has not yet been confirmed.' };
      if (result.reference) await confirm();
    } catch (e) { const refused = e instanceof ApiError && e.deliveryStatus === 'not-submitted'; pending = { id, ...intent, ...(refused ? {} : { reference: id }), status: refused ? 'not-submitted' : 'unconfirmed', message: e instanceof Error ? e.message : 'Delivery unconfirmed. Check IG before trying again.' }; } finally { sending = false; }
  }
  async function confirm() {
    if (!pending?.reference || pending.accountId !== session?.accountId || pending.environment !== session?.environment) return;
    const item = pending;
    try {
      const result = record(await api(`confirm?reference=${encodeURIComponent(item.reference!)}`));
      if (pending?.id !== item.id) return;
      if (!['ACCEPTED', 'REJECTED'].includes(result.dealStatus)) { pending = { ...item, status: 'unconfirmed', message: 'IG has not confirmed this request. Check again or inspect your IG account.' }; return; }
      pending = { ...item, status: result.dealStatus.toLowerCase(), message: result.dealStatus === 'ACCEPTED' ? `IG accepted the request${result.dealId ? ` · ${result.dealId}` : ''}.` : `IG rejected the request: ${result.reason || 'reason unavailable'}` };
      try { await refreshAccount(); } catch (e) { error = e instanceof Error ? e.message : 'Could not refresh positions'; }
    } catch (e) { pending = { ...item, status: 'unconfirmed', message: `${e instanceof Error ? e.message : 'Confirmation unavailable'}. Check IG before submitting again.` }; }
  }
  async function closePosition() {
    if (!closing || sending || pending) return;
    const p = record(closing.position), id = crypto.randomUUID().replaceAll('-', '').slice(0, 26);
    const intent = { accountId: session!.accountId, environment: session!.environment };
    sending = true; pending = { id, ...intent, status: 'sending', message: 'Sending close request…' }; closing = null;
    try {
      const result = await api<{ status: string; reference?: string; error?: string }>('close', 'POST', { id, ...intent, dealId: p.dealId, size: p.size });
      pending = { id, ...intent, status: result.status, reference: result.reference, message: result.error || 'Close submitted; awaiting IG confirmation.' };
      if (result.reference) await confirm();
    } catch (e) { pending = { id, ...intent, status: e instanceof ApiError && e.deliveryStatus === 'not-submitted' ? 'not-submitted' : 'unconfirmed', message: e instanceof Error ? e.message : 'Close delivery unconfirmed. Inspect your IG position.' }; } finally { sending = false; }
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
    try { const saved = record(JSON.parse(sessionStorage.getItem('ig:pending') || 'null')); if (/^[A-Za-z0-9_-]{1,30}$/.test(saved.id) && typeof saved.accountId === 'string' && saved.environment === 'live') pending = { ...saved, status: ['accepted', 'rejected', 'not-submitted'].includes(saved.status) ? saved.status : 'unconfirmed', message: 'Restored request. Check its confirmation before placing another order.' } as Pending; } catch { sessionStorage.removeItem('ig:pending'); }
    hydrated = true;
    hotkeySizes = Object.fromEntries(Object.entries(record(load<unknown>('ig:hotkey-sizes', {}))).filter(([, value]) => validSize(value)).slice(-100)) as Record<string, string>;
    watchlist = liteList(load<unknown>('ig:watchlist', []), MAX_WATCH);
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
      await browse();
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
  <header>
    <a class="brand" href="/ig">IG <span>CFD</span></a>
    {#if session}<span class="environment">Live account</span><select aria-label="SGD CFD account" value={session.accountId} disabled={loading || sending || !!pending} onchange={e => switchAccount(e.currentTarget.value)}>{#each session.accounts as a}<option value={a.id} disabled={!eligibleAccount(a)}>{a.name} · {a.currency} · {a.id}</option>{/each}</select><dl class="funds" data-testid="ig-funds"><div><dt>Funds</dt><dd class="num">{number(account?.balance)}</dd></div><div><dt>Profit/Loss</dt><dd class="num" class:buy={(account?.pnl ?? 0) > 0} class:sell={(account?.pnl ?? 0) < 0}>{number(account?.pnl)}</dd></div><div><dt>Margin</dt><dd class="num">{number(account?.margin)}</dd></div><div><dt>Available</dt><dd class="num">{number(account?.available)} {account?.currency || '—'}</dd></div></dl>{/if}
    <div class="header-actions"><ThemePicker value={theme} onchange={applyTheme} /><button class="ui-tab" data-testid="ig-key-settings" disabled={loading || sending} onclick={openKey}>API key{keyConfigured ? ' · Saved' : ''}</button><button class="ui-tab" disabled={loading || sending} onclick={() => connected ? signOut() : openLogin()}>{connected ? 'Sign out' : 'Connect IG'}</button></div>
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
      {#if !rows.length}<p class="empty">{!connected ? 'Connect your IG account to search markets and compare current spreads.' : source === 'watch' ? watchlist.length ? 'No watched markets match this filter.' : 'Star ★ a market to add it to your watchlist.' : loading || searching ? 'Loading markets…' : 'Browse a category or search for markets. No matching results are loaded.'}</p>{/if}
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
          <div class="chart-wrap" role="presentation" onpointerdown={() => grid && !review && !sending && activate(m.epic)}><IgChart bars={v.bars} live={v.live} {theme} epic={m.epic} scope={v.res} averages={averages ? AVERAGES : []} lines={linesOf(m.epic)} />{@render chartNote(v)}</div>
        </div>{:else}<div class="tile"><div class="chart-wrap"><IgChart bars={[]} {theme} />{@render chartNote(undefined)}</div></div>{/each}
      </div>
      <div class="positions" id="ig-panel-positions" role="tabpanel" tabindex="0" aria-labelledby="ig-tab-positions"><div class="section-title"><h2>Positions <span class="count">{positions.length || ''}</span></h2><button class="ui-tab" disabled={!connected || loading} onclick={() => run(refreshAccount)}>Refresh</button></div><div class="position-table"><table><thead><tr><th>Market</th><th>Direction</th><th>Size</th><th>Entry</th><th>Latest</th><th title="Estimated from the latest quote IG sent with the position, in its dealing currency. IG's own figure is authoritative.">P&amp;L</th><th>Stop</th><th>Limit</th><th></th></tr></thead><tbody>{#each positions as row}{@const pm = marketOf(row.market)}{@const pnl = positionPnl(row)}<tr data-testid="ig-position"><td>{#if pm}<button class="market-name" title="Open chart" onclick={() => openMarket(quotes[pm.epic] ?? pm)}>{pm.name}</button>{:else}{record(row.market).instrumentName}{/if}</td><td class:buy={record(row.position).direction === 'BUY'} class:sell={record(row.position).direction === 'SELL'}>{record(row.position).direction}</td><td class:buy={record(row.position).direction === 'BUY'} class:sell={record(row.position).direction === 'SELL'}>{record(row.position).direction === 'SELL' ? '−' : '+'}{quote(numeric(record(row.position).size))}</td><td>{quote(numeric(record(row.position).level))}</td><td>{quote(pnl?.exit)}</td><td class="num" class:buy={(pnl?.points ?? 0) > 0} class:sell={(pnl?.points ?? 0) < 0}>{pnl?.value == null ? record(row.position).currency : money(pnl.value, record(row.position).currency)}{#if pnl}<small>{pnl.points < 0 ? '−' : '+'}{quote(Math.abs(pnl.points))} pts</small>{/if}</td><td>{quote(numeric(record(row.position).stopLevel))}</td><td>{quote(numeric(record(row.position).limitLevel))}</td><td><button class="ui-tab" disabled={!!pending || sending || !eligibleAccount(account)} onclick={() => closing = row}>Close</button></td></tr>{/each}</tbody></table></div>{#if !positions.length}<p class="empty">{connected ? 'No open positions returned by IG.' : 'Your positions appear after connecting.'}</p>{/if}</div>
    </section>
    <div class="ticket" id="ig-panel-trade" role="tabpanel" tabindex="0" aria-labelledby="ig-tab-trade"><div class="ticket-head"><h2>Trade</h2><span data-testid="ig-ticket-market">{selected?.market.name ?? view?.market.name ?? 'No market selected'}</span></div><div class="side"><button class="ui-tab buy" aria-pressed={direction === 'BUY'} onclick={() => { direction = 'BUY'; review = false; }}>Buy {number(selected?.market.offer, 4)}</button><button class="ui-tab sell" aria-pressed={direction === 'SELL'} onclick={() => { direction = 'SELL'; review = false; }}>Sell {number(selected?.market.bid, 4)}</button></div><p class="explain">Market order · Fill or kill · Opens a separate position</p><label>Size <span>{selected?.unit.toLowerCase() || 'IG units'}</span><input class="ui-field" data-testid="ig-size" inputmode="decimal" bind:value={size} oninput={() => review = false} /></label><label>B / S size <span>{selected?.unit.toLowerCase() || "IG units"}</span><input class="ui-field" data-testid="ig-hotkey-size" aria-label="B / S size" aria-describedby="ig-hotkey-help" inputmode="decimal" value={hotkeySize} disabled={!selected} oninput={e => setHotkeySize(e.currentTarget.value)} placeholder="Set size for this market" /></label><p class="explain" id="ig-hotkey-help">B buys · S sells · Opens review for the active market with its saved size.{selected && hotkeyError ? ` ${hotkeyError}` : ''}</p><label>Dealing currency<select bind:value={currency} onchange={() => review = false}>{#each selected?.currencies ?? ['SGD'] as c}<option value={c}>{c}</option>{/each}</select></label><label>Stop distance <span>optional · points</span><input class="ui-field" inputmode="decimal" bind:value={stop} oninput={() => review = false} /></label><label>Take-profit distance <span>optional · points</span><input class="ui-field" inputmode="decimal" bind:value={takeProfit} oninput={() => review = false} /></label><dl><dt>Account currency</dt><dd>{account?.currency || '—'}</dd><dt>Spread</dt><dd>{selected ? quote(spread(selected.market)) : '—'} points</dd><dt>Relative spread</dt><dd>{selected ? number(spreadBps(selected.market)) : '—'} bps</dd><dt>Quote</dt><dd>{selected ? quoteAge(selected.market) : '—'}</dd></dl><p class="explain">Margin, fees and currency conversion follow IG’s rates. Stops are not guaranteed.</p>{#if invalid}<p class="explain" data-testid="ig-ticket-reason">{invalid}</p>{/if}<button class="review" data-testid="ig-review" disabled={!!invalid || busyMarket || sending || !!pending} onclick={() => review = true}>Review {direction === 'BUY' ? 'buy' : 'sell'}</button>
      {#if pending}<div class="delivery" role="status" data-testid="ig-delivery"><strong>{pending.status.replaceAll('-', ' ')}</strong><small>{pending.environment} · {pending.accountId}</small><p>{pending.message}</p>{#if pending.reference}<small>Reference {pending.reference}</small>{/if}{#if ['accepted', 'rejected', 'not-submitted'].includes(pending.status)}<button class="ui-tab" onclick={() => pending = null}>Done</button>{:else if pending.reference}<button class="ui-tab" disabled={sending || pending.accountId !== session?.accountId || pending.environment !== session?.environment} onclick={confirm}>Check confirmation</button>{:else if pending.status === 'unconfirmed'}<button class="ui-tab" disabled={sending || pending.accountId !== session?.accountId || pending.environment !== session?.environment} onclick={() => { reconciled = false; reconcile = true; }}>Reconcile in IG</button>{/if}</div>{/if}
    </div>
  </main>
  <footer><span>IG CFD · {connected ? `${session?.environment} · ${account?.currency || 'Select account'}` : 'Disconnected'}</span><span>{#if allowance?.remaining != null}<span data-testid="ig-allowance" title="IG's weekly allowance of historical price points for this API key. Each bar loaded uses one.">Price history {fmtNum(allowance.remaining, 0)}{allowance.total ? ` / ${fmtNum(allowance.total, 0)}` : ''} left</span>{' · '}{/if}Quotes refresh every {POLL / 1000}s · No automatic order retries</span></footer>
</div>
{#if login || review || closing || reconcile}<div class="scrim"><div class="dialog ui-menu" class:login-dialog={login} onkeydown={dialogKey} {@attach focusLogin} role="dialog" tabindex="-1" aria-modal="true" aria-label={login ? keySetup ? 'IG API key' : 'Connect IG' : closing ? 'Close position' : reconcile ? 'Reconcile IG request' : 'Review IG order'}>
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
      {#if error}<p class="login-error" role="alert" {@attach node => node.scrollIntoView({ block: 'nearest' })}>{error}</p>{/if}
      <div class="actions"><button type="button" class="ui-tab" disabled={loading} onclick={closeLogin}>Cancel</button><button class="connect-button" disabled={loading || !keyConfigured || !identifier || !password || !!usernameError}>{loading ? 'Connecting…' : 'Connect live'}</button></div>
    </form>
  {:else if reconcile && pending}<h2>Reconcile IG request</h2><p>Open IG separately and inspect positions and activity history for <strong>{pending.accountId} · {pending.environment}</strong>. Confirm that this request has finished processing and your account reflects its outcome. If it is still uncertain, keep the request pending.</p><p>Request {pending.id}. Clearing this notice does not confirm execution or resend the request.</p><label class="reconcile-check"><input type="checkbox" bind:checked={reconciled} /> I checked this account in IG and reconciled the request.</label><div class="actions"><button class="ui-tab" onclick={() => reconcile = false}>Keep pending</button><button disabled={!reconciled || pending.accountId !== session?.accountId || pending.environment !== session?.environment} onclick={clearUncertain}>Mark reconciled</button></div>{:else if closing}<h2>Close position</h2><p>Close {number(numeric(record(closing.position).size), 4)} of {record(closing.market).instrumentName} at the available market price on your {session?.environment} account?</p><div class="actions"><button class="ui-tab" onclick={() => closing = null}>Cancel</button><button disabled={sending || !!pending} onclick={closePosition}>Confirm close</button></div>{:else}<h2>Review {direction.toLowerCase()}</h2><p>{selected?.market.name}</p><dl><dt>Account</dt><dd>{account?.id} · {session?.environment}</dd><dt>Size</dt><dd>{size} {selected?.unit.toLowerCase()}</dd><dt>Dealing currency</dt><dd>{currency}</dd><dt>Order</dt><dd>Market · fill or kill</dd><dt>Stop / limit distance</dt><dd>{stop || 'None'} / {takeProfit || 'None'}</dd></dl><p>Execution can differ from the displayed quote. This opens a separate position.</p><div class="actions"><button class="ui-tab" onclick={() => review = false}>Cancel</button><button data-testid="ig-confirm" disabled={sending || !!invalid || !!pending} onclick={submit}>Confirm {session?.environment} {direction.toLowerCase()}</button></div>{/if}
</div></div>{/if}

<style>
  .ig-app { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
  header, footer { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 6px 12px; background: var(--panel); }
  header { border-bottom: 1px solid var(--line); } footer { justify-content: space-between; color: var(--dim); font-size: 10px; border-top: 1px solid var(--line); }
  header select { max-width: 260px; font-size: 12px; }
  .brand { color: var(--bright); font-size: 16px; font-weight: 650; text-decoration: none; white-space: nowrap; } .brand span { font-weight: 400; color: var(--dim); }
  .header-actions { display: flex; gap: 6px; margin-left: auto; } .funds { display: flex; gap: 4px 16px; margin: 0; font-size: 12px; } .funds div { display: grid; gap: 1px; } .funds dt { color: var(--dim); font-size: 10px; } .funds dd { margin: 0; color: var(--bright); white-space: nowrap; } .funds dd.buy { color: var(--buy-text); } .funds dd.sell { color: var(--sell-text); } .environment { color: var(--warn-text); font-size: 12px; }
  .phone-tabs, .phone-instrument { display: none; }
  main { flex: 1; min-height: 0; display: grid; grid-template-columns: 272px minmax(0, 1fr) 284px; gap: 1px; background: var(--line); }
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
  .positions { flex: 0 0 clamp(140px, 24vh, 220px); min-height: 0; padding: 10px 12px; overflow: auto; border-top: 1px solid var(--line); } .positions .section-title { margin-bottom: 6px; }
  .positions .market-name { font-size: 12px; }
  .ticket { display: flex; flex-direction: column; gap: 10px; } .ticket > label, .dialog label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 5px; color: var(--dim); font-size: 11px; } label > input:not([type=checkbox]), label > select { width: 100%; color: var(--text); }
  .ticket-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; } .ticket-head span { min-width: 0; color: var(--bright); font-size: 12px; font-weight: 500; text-align: right; overflow-wrap: anywhere; }
  .side { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; } .side button { padding: 9px 5px; white-space: normal; } dl { display: grid; grid-template-columns: 1fr auto; gap: 7px; margin: 5px 0; font-size: 11px; } dt { color: var(--dim); } dd { margin: 0; text-align: right; } .review { min-height: 38px; flex: none; background: var(--accent); color: var(--bg); font-weight: 600; }
  .message { flex: none; padding: 8px 12px; color: var(--warn-text); background: var(--surface); } .delivery { padding: 8px 0; overflow-wrap: anywhere; } .delivery strong { text-transform: capitalize; } .delivery p { font-size: 12px; }
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
    header { padding: 7px 10px; gap: 7px; } .brand { font-size: 15px; } .funds { gap: 4px 10px; font-size: 11px; } .position-table :is(th, td):nth-child(2), .position-table :is(th, td):nth-child(4), .position-table :is(th, td):nth-child(5), .position-table :is(th, td):nth-child(7), .position-table :is(th, td):nth-child(8) { display: none; } .header-actions { gap: 4px; } header select { max-width: 100%; }
    .phone-tabs { flex: none; display: flex; gap: 4px; padding: 5px 8px; background: var(--panel); border-bottom: 1px solid var(--line); } .phone-tabs button { font-size: max(11px, calc(var(--fs) * 0.833)); flex: 1; padding: 6px 4px; }
    .phone-instrument { flex: none; display: flex; gap: 4px; padding: 4px 8px; background: var(--panel); border-bottom: 1px solid var(--line); } .phone-instrument select { flex: 1; min-width: 0; }
    main { display: flex; flex-direction: column; } .interval-select { display: block; } .markets, .positions, .ticket, .instruments, .find, .layout, .intervals { display: none; } .workspace { flex: 1; } .charts { min-height: 0; } .chart-heading { padding: 8px 10px; } .chart-actions { margin-left: 0; } .stats { gap: 2px 12px; }
    main[data-view=markets] .markets { display: flex; flex: 1; overflow: auto; } .markets > :not(.market-table) { flex-shrink: 0; } .market-table { flex: 1 0 180px; min-height: 180px; margin: 0 -12px; } main[data-view=markets] .workspace, main[data-view=trade] .workspace { display: none; }
    main[data-view=trade] .ticket { display: flex; flex: 1; } main[data-view=positions] .chart-heading, main[data-view=positions] .charts { display: none; } main[data-view=positions] .positions { display: block; flex: 1; }
    footer { padding: 6px 10px; } footer > span:last-child { display: none; }
  }
  @media (max-width: 450px) { .header-actions { width: 100%; justify-content: space-between; } .environment { font-size: 11px; } .stats div:last-child { display: none; } }
</style>
