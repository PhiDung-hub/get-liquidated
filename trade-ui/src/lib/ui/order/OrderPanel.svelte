<script module lang="ts">
  let active: ((viaKey: boolean) => Promise<void>) | undefined;
  /** The Place button's path for the Enter key: the same build, checks and send, without the wallet prompts. */
  export const placeTicket = () => (active ? active(true) : Promise.reject(new Error('order panel not open')));
  export const ticketOpen = () => !!active;

  // Typed text lives here, not in the instance, so a resize across the phone breakpoint (which mounts the other layout's panel) keeps it.
  let sizeText = $state('');
  let scaleFrom = $state('');
  let scaleTo = $state('');
  let scaleSeeded = false;
  let capOn = $state(false);
  let capText = $state('');
  let capFor = '';
  const legs = $state({ tp: { unit: '%' as '%' | '$', text: '', from: '', basis: '' }, sl: { unit: '%' as '%' | '$', text: '', from: '', basis: '' } });
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { market } from '$lib/market/market.svelte';
  import { isolatedOnly, isSpot, meta, quoteOf, symOf } from '$lib/market/meta.svelte';
  import { bbo, watchBbo } from '$lib/market/book.svelte';
  import { assetData } from '$lib/account/assetData.svelte';
  import { balanceOf, freeOf, inventory, modeOf, positionOf } from '$lib/account/inventory.svelte';
  import { session, connectWallet, enableTrading, viewAddress } from '$lib/session/session.svelte';
  import { persist, settings } from '$lib/settings/settings.svelte';
  import { convertSize, estFill, marketBuyPx, midPx, maxSize, refPx, resolveSize, ticketSizing } from '$lib/orders/size';
  import type { Draft } from '$lib/orders/market';
  import { bestPx, limitDraft } from '$lib/orders/limit';
  import { optPx } from '$lib/orders/tpsl';
  import { scaleDrafts, scaleRange } from '$lib/orders/scale';
  import { isTrigger } from '$lib/orders/trigger';
  import { ticketDrafts } from '$lib/orders/entry';
  import { assertPositionsLoaded, minLabel, place, precheck, quoteIn, readable } from '$lib/orders/execute';
  import { startChase, capFromPct } from '$lib/orders/chase.svelte';
  import type { Grouping, Tif } from '$lib/exchange/actions';
  import { MIN_NOTIONAL, cutDecimals, cutPx, cutSz, roundPx } from '$lib/signing/wire';
  import { fmtIn, fmtNum, fmtPx, fmtSz } from '$lib/util/format';
  import { placing, ticket, type TicketKind } from '$lib/orders/ticket.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import { openSettings, ui } from '$lib/ui/state.svelte';
  import Menu from './Menu.svelte';
  import Field from './Field.svelte';
  import SideToggle from './SideToggle.svelte';
  import TypeTabs from './TypeTabs.svelte';
  import SizeSlider from './SizeSlider.svelte';
  import InfoRows from './InfoRows.svelte';

  type Leg = 'tp' | 'sl';
  const TIFS = [
    { value: 'Gtc', label: 'GTC', testid: 'panel-tif-gtc', description: 'Good till cancelled. Unfilled quantity stays open until filled or cancelled.' },
    { value: 'Ioc', label: 'IOC', testid: 'panel-tif-ioc', description: 'Immediate or cancel. Fills now at your limit price or better; cancels any unfilled quantity.' },
    { value: 'Alo', label: 'ALO', testid: 'panel-tif-alo', description: 'Add liquidity only. Post-only: cancelled if it would execute immediately.' }
  ];
  const tifHelpId = $props.id();
  let tifHelpOpen = $state(false);
  const selectedTif = $derived(TIFS.find((option) => option.value === (isTrigger(ticket.kind) ? 'Gtc' : ticket.tif)) ?? TIFS[0]);
  const LABEL = { connect: 'Connect', enable: 'Enable Trading', readonly: 'Read-only', ready: 'Place Order' } as const;

  const coin = $derived(market.coin);
  const szDecimals = $derived(meta.byName.get(coin)?.szDecimals);
  const szDec = $derived(szDecimals ?? 0);
  const quote = $derived(quoteOf(coin));
  const spot = $derived(isSpot(coin));
  const asset = $derived(meta.byName.get(coin));
  const base = $derived(asset?.base ?? symOf(coin));
  const lev = $derived(assetData.coin === coin ? assetData.leverage : null);
  const pos = $derived(positionOf(coin));
  // On spot: the free quote to buy with, the free base to sell.
  const avail = $derived(spot ? freeOf(ticket.isBuy ? quote : base) : assetData.coin === coin ? assetData.availableToTrade[ticket.isBuy ? 0 : 1] : 0);
  const unit = $derived(settings.panel.sizeUnit);
  const kind = $derived(ticket.kind);
  const priced = $derived(kind === 'limit' || kind === 'stopLimit' || kind === 'takeLimit');
  const showTif = $derived(priced || kind === 'scale');
  $effect(() => { if (!showTif) tifHelpOpen = false; });
  const showTpsl = $derived(!spot && (kind === 'market' || kind === 'limit'));
  const mode = $derived(!session.master ? 'connect' : session.readOnlyReason ? 'readonly' : !session.agent ? 'enable' : 'ready');

  const tryOr = <T,>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  const blur = (e: MouseEvent) => (e.currentTarget as HTMLElement).blur();
  const numOf = (v: string) => (v.trim() ? Number(v) : NaN);

  // Typed prices belong to the coin and account they were typed for. The new coin's own bbo (tagged by coin, unlike the global one for a tick after a switch) fills the limit price once.
  let prevCoin = market.coin;
  let prevUser = viewAddress();
  let own = $state({ coin: '', bid: 0, ask: 0 });
  let seededFor = '';
  function clearTyped() {
    seededFor = '';
    Object.assign(ticket, { px: '', trigger: '', tp: '', sl: '' });
    if (ticket.unit === 'coin') ticket.size = 0;
    sizeText = scaleFrom = scaleTo = '';
  }
  $effect(() => {
    const u = viewAddress();
    untrack(() => {
      if (prevUser && u !== prevUser) clearTyped();
      prevUser = u;
    });
  });
  $effect(() => {
    const c = market.coin;
    untrack(() => {
      if (c === prevCoin) return;
      prevCoin = c;
      clearTyped();
    });
    // untrack: subscribe reads the socket's reactive state, which must not re-run this effect.
    return untrack(() => watchBbo(c, (b) => (own = { coin: c, bid: b.bid, ask: b.ask })));
  });
  // Filled when a priced tab is shown, so a later switch from Market never shows the mid from page load.
  $effect(() => {
    const a = meta.byName.get(coin);
    if (!priced || seededFor === coin || own.coin !== coin || !a || !(own.bid > 0 && own.ask > 0)) return;
    seededFor = coin;
    untrack(() => {
      if (!ticket.px) ticket.px = String(roundPx((own.bid + own.ask) / 2, a, ticket.isBuy));
    });
  });

  // Reduce Only and a Stop/Take kind carry over from a perp; spot has neither, so they drop (unsaved) on a spot pair. TP/SL stays for the next perp: spot orders never attach it.
  $effect(() => {
    if (spot)
      untrack(() => {
        ticket.reduceOnly = false;
        if (isTrigger(ticket.kind)) ticket.kind = 'limit';
      });
  });
  // Reduce Only and TP/SL exclude each other; this also covers the R hotkey.
  $effect(() => {
    if (ticket.reduceOnly) untrack(() => (ticket.tpsl = false));
  });
  // Stop Limit offers no TP/SL (HL acceptance unverified), so a tick carried over from Limit must not make its send refuse.
  $effect(() => {
    if (kind === 'stopLimit') untrack(() => (ticket.tpsl = false));
  });
  $effect(() => {
    void [coin, ticket.kind, ticket.isBuy, ticket.size, ticket.px, ticket.trigger, ticket.tp, ticket.sl, ticket.scaleCount, ticket.scaleSkew];
    untrack(() => (placing.error = ''));
  });
  // Reading coin makes a coin switch re-seed the distance too; it stays per order and is never saved.
  $effect(() => {
    const k = kind === 'chase' ? coin : '';
    if (k && k !== capFor) untrack(() => (capText = String(settings.chase.capPct)));
    capFor = k;
  });

  // A % of balance must fit at the order's own price: a spot buy's held quote, a limit's price.
  const orderPx = $derived(kind === 'market' ? (spot ? tryOr(() => marketBuyPx(coin), undefined) : undefined) : (kind === 'limit' && Number(ticket.px)) || undefined);
  const sz = $derived(tryOr(() => resolveSize(coin, ticket.isBuy, ticketSizing(), undefined, orderPx), 0));
  const maxSz = $derived(tryOr(() => maxSize(coin, ticket.isBuy, ticket.reduceOnly, undefined, orderPx), 0));
  function quantityHint(isBuy: boolean) {
    try {
      const quantity = resolveSize(coin, isBuy, ticketSizing(), undefined, orderPx);
      if (!(quantity > 0)) return 'Enter a size to preview asset quantity';
      return `${isBuy ? 'Buy' : 'Sell'} ${fmtSz(quantity, szDec)} ${symOf(coin)} · estimated order quantity`;
    } catch { return 'Asset quantity unavailable — check size and market data'; }
  }
  const hint = $derived(quantityHint(ticket.isBuy));
  const pct = $derived(
    ticket.unit === 'pct' && ticket.basis === 'balance'
      ? Math.min(100, ticket.size)
      : sz > 0 && maxSz > 0 ? Math.min(100, Math.round((sz / maxSz) * 100)) : 0
  );
  const sizeShown = $derived.by(() => {
    if (ticket.unit === unit) return sizeText.trim() && Number(sizeText) === ticket.size ? sizeText : ticket.size ? String(ticket.size) : '';
    if (!(sz > 0)) return '';
    const shown = unit === 'coin' ? sz : tryOr(() => convertSize(coin, sz, 'usd'), 0);
    return shown > 0 ? String(shown) : '';
  });

  const chasePx = $derived(ticket.isBuy ? bbo.bid : bbo.ask);
  const px = $derived.by(() => {
    const ref = tryOr(() => refPx(coin), 0);
    if (priced) return Number(ticket.px) || 0;
    if (kind === 'stopMarket' || kind === 'takeMarket') return Number(ticket.trigger) || 0;
    if (kind === 'market') return (sz > 0 && estFill(ticket.isBuy, sz)) || ref;
    return chasePx || ref;
  });
  const entryPx = $derived(((kind === 'limit' || kind === 'stopLimit') && Number(ticket.px)) || tryOr(() => refPx(coin), 0));
  const levX = $derived(spot ? 1 : (lev?.value ?? 1));

  const defRange = $derived(tryOr(() => scaleRange(ticket.isBuy, refPx(coin), settings.scale.rangePct, settings.scale.offsetPct), { from: 0, to: 0 }));
  $effect(() => {
    if (kind === 'scale') untrack(() => {
      if (scaleSeeded) return;
      ticket.scaleCount = String(settings.scale.count);
      ticket.scaleSkew = String(settings.scale.skew);
      scaleSeeded = true;
    });
  });
  function scaleOf(totalSz: number): Draft[] {
    const count = numOf(ticket.scaleCount), skew = numOf(ticket.scaleSkew);
    const { shape } = settings.scale;
    if (!Number.isFinite(count)) throw new Error('enter the number of scale orders');
    if (!Number.isFinite(skew)) throw new Error('enter a scale skew');
    const from = optPx(scaleFrom, 'scale start') ?? defRange.from;
    const to = optPx(scaleTo, 'scale end') ?? defRange.to;
    const tif = ticket.tif;
    return scaleDrafts({ coin, isBuy: ticket.isBuy, from, to, count, totalSz, skew, shape, reduceOnly: ticket.reduceOnly }).map((d) => ({ ...d, type: { tif } }));
  }
  const ladder = $derived(kind !== 'scale' || !(sz > 0) ? [] : tryOr(() => scaleOf(sz), [] as Draft[]));
  /** The ladder's average child and its smallest opening child's notional, for the line under the scale fields. */
  const perOrder = $derived.by(() => {
    if (!ladder.length) return null;
    const n = ladder.length;
    const sz = ladder.reduce((t, d) => t + d.sz, 0) / n;
    const usd = ladder.reduce((t, d) => t + d.px * d.sz, 0) / n;
    const min = ticket.reduceOnly ? Infinity : Math.min(...ladder.map((d) => d.px * d.sz));
    return { n, sz, usd, min };
  });
  let ladderOpen = $state(false);
  const fewRows = $derived(ladder.length < 3);
  $effect(() => {
    void [coin, kind, fewRows];
    untrack(() => (ladderOpen = false));
  });
  async function showLadder(open: boolean) {
    ladderOpen = open;
    await tick();
    document.querySelector<HTMLElement>(`[data-testid="${open ? 'scale-less' : 'scale-more'}"]`)?.focus({ preventScroll: true });
  }

  function capPct(): number {
    if (!capOn || !capText.trim()) return settings.chase.capPct;
    const v = Number(capText);
    if (!(v >= 0.01 && v <= 10)) throw new Error('chase distance must be 0.01–10%');
    return v;
  }
  const capShown = $derived(tryOr(capPct, settings.chase.capPct));

  // Every box is cut to what Hyperliquid accepts as it is typed (signing/wire.ts); quote amounts and percentages keep 2 places.
  const typePx = (v: string) => cutPx(v, meta.byName.get(coin));
  const typeSz = (v: string) => (unit === 'coin' ? cutSz(v, szDecimals) : cutDecimals(v, 2));
  const typeAmt = (v: string) => cutDecimals(v, 2);
  const typeGain = (v: string) => cutDecimals(v, 2, true);
  const typeCount = (v: string) => cutDecimals(v, 0);
  function typeSize(v: string) {
    sizeText = v;
    const n = Number(v);
    Object.assign(ticket, { unit, size: Number.isFinite(n) && n > 0 ? n : 0 });
  }
  function setPct(v: number) {
    sizeText = '';
    Object.assign(ticket, { unit: 'pct', basis: 'balance', size: v });
  }
  function pickUnit(v: string) {
    const to = v as 'coin' | 'usd';
    placing.error = '';
    if (to === unit) return;
    const typed = ticket.unit === 'coin' || ticket.unit === 'usd';
    let n = 0;
    try {
      if (typed && ticket.size > 0) n = ticket.unit === to ? ticket.size : convertSize(coin, ticket.size, to);
    } catch (err) {
      // No book or mark to convert at: the number stays in the unit it was typed in rather than turn into a wrong one.
      return void (placing.error = (err as Error).message);
    }
    settings.panel.sizeUnit = to;
    persist();
    if (!typed) return;
    sizeText = n > 0 ? String(n) : '';
    Object.assign(ticket, { unit: to, size: n });
  }
  const pickTif = (v: string) => {
    if (!isTrigger(ticket.kind)) ticket.tif = v as Tif;
  };
  function setTpsl(v: boolean) {
    ticket.tpsl = v;
    if (v) ticket.reduceOnly = false;
  }
  function mid(e: MouseEvent) {
    blur(e);
    try {
      ticket.px = String(midPx(ticket.isBuy));
    } catch (err) {
      placing.error = (err as Error).message;
    }
  }
  function best(e: MouseEvent) {
    blur(e);
    try {
      if (own.coin !== coin) throw new Error(`no ${coin} book yet`);
      ticket.px = String(bestPx(ticket.isBuy));
    } catch (err) {
      placing.error = (err as Error).message;
    }
  }

  /** TP gain or SL loss as % return on margin at the current leverage, or as $ on the current size. */
  function gainOf(k: Leg): string {
    const p = Number(ticket[k]);
    if (!(p > 0 && entryPx > 0)) return '';
    const move = (ticket.isBuy ? 1 : -1) * (k === 'tp' ? 1 : -1) * (p - entryPx);
    if (legs[k].unit === '%') return ((move / entryPx) * levX * 100).toFixed(2);
    return sz > 0 ? (move * sz).toFixed(2) : '';
  }
  // The typed Gain/Loss stands only while the inputs its price came from are unchanged. The live mid is left out, so a tick never rewrites the box mid-keystroke.
  const basisOf = (k: Leg) => [kind, kind === 'limit' || kind === 'stopLimit' ? ticket.px : '', ticket.size, ticket.unit, ticket.basis, levX, legs[k].unit, ticket.isBuy].join();
  function setGain(k: Leg, v: string) {
    legs[k].text = v;
    legs[k].basis = basisOf(k);
    const g = Number(v);
    if (!v.trim() || !(entryPx > 0)) return void (ticket[k] = legs[k].from = '');
    if (!Number.isFinite(g)) return void (ticket[k] = legs[k].from = v);
    const move = legs[k].unit === '%' ? (g / 100 / levX) * entryPx : sz > 0 ? g / sz : NaN;
    if (!Number.isFinite(move)) return void (legs[k].text = '');
    const p = entryPx + (ticket.isBuy ? 1 : -1) * (k === 'tp' ? 1 : -1) * move;
    // A price at or below zero stays in the box so optPx refuses it; a blank would quietly drop the leg.
    ticket[k] = legs[k].from = p > 0 ? String(roundPx(p, meta.byName.get(coin) ?? { szDecimals: 0, spot: false }, !ticket.isBuy)) : String(p);
  }
  const gainShown = (k: Leg) => (legs[k].text && legs[k].from === ticket[k] && legs[k].basis === basisOf(k) ? legs[k].text : gainOf(k));
  function pickGainUnit(k: Leg, v: string) {
    legs[k].unit = v as '%' | '$';
    legs[k].text = '';
  }

  const typedSize = () => (ticket.unit === 'coin' || ticket.unit === 'usd') && ticket.size > 0;
  const draftsFor = async (c: string, isBuy: boolean, k: Exclude<TicketKind, 'chase'>, size: number): Promise<[Draft[], Grouping]> =>
    k === 'scale' ? [scaleOf(size), 'na'] : ticketDrafts(c, isBuy, k, size);

  /** Coin, side and kind are read once: a market switch during the price lookup must not carry this order onto another coin. */
  async function build(): Promise<() => Promise<void>> {
    const [c, isBuy, k] = [coin, ticket.isBuy, ticket.kind];
    const size = resolveSize(c, isBuy, ticketSizing(), undefined, orderPx);
    if (ticket.reduceOnly) {
      const maximum = maxSize(c, isBuy);
      if (!(maximum > 0)) {
        assertPositionsLoaded();
        throw new Error(`Reduce Only ${isBuy ? 'buy' : 'sell'} requires a ${isBuy ? 'short' : 'long'} position`);
      }
      if (size > maximum) throw new Error('Reduce Only size exceeds the current position');
    }
    if (!(size > 0) && typedSize()) throw new Error(`${sizeText || ticket.size} ${ticket.unit === 'usd' ? quoteOf(c) : symOf(c)} rounds to 0 ${symOf(c)}: below Hyperliquid's ${minLabel(c)} minimum`);
    if (!(size > 0)) throw new Error('enter a size');
    if (k === 'chase') {
      const p = { coin: c, isBuy, sz: size, cap: capFromPct(isBuy, refPx(c), capPct()), timeoutSec: settings.chase.timeoutSec, onStop: settings.chase.onStop, reduceOnly: ticket.reduceOnly };
      const first = limitDraft(c, isBuy, refPx(c), size, 'Alo', p.reduceOnly);
      precheck(c, [first]);
      return async () => void (await startChase(p));
    }
    const [drafts, grouping] = await draftsFor(c, isBuy, k, size);
    if (market.coin !== c) throw new Error(`market switched from ${c}, nothing sent`);
    precheck(c, drafts);
    return async () => {
      const entries = await place(k, c, drafts, grouping);
      const failed = entries.find((x) => x.state === 'error');
      // place() already toasted it.
      if (failed) placing.error = readable(c, failed.error ?? 'rejected');
    };
  }

  let sending = 0;
  /** A key never opens a wallet prompt: without a trading agent it only checks the ticket. Keys come through the hotkey queue, so they may overlap one in flight. */
  async function submit(viaKey: boolean) {
    if (placing.busy && !viaKey) return void toast.error('an order from the ticket is still in flight');
    const m = mode;
    const fail = (err: unknown) => {
      placing.error = (err as Error).message || 'order failed';
      toast.error(placing.error);
    };
    sending++;
    placing.busy = true;
    placing.error = '';
    let prompt = false;
    try {
      if (m === 'ready') {
        await (await build())();
      } else {
        // A typed order is checked before the wallet prompt, so a bad one is refused before anything is signed.
        if (sz > 0 || typedSize() || viaKey) await build();
        if (viaKey) throw new Error(m === 'readonly' ? session.readOnlyReason : m === 'connect' ? 'Connect a wallet first' : 'Enable trading first');
        if (m === 'connect') prompt = true;
        else await enableTrading();
      }
    } catch (err) {
      fail(err);
    } finally {
      placing.busy = --sending > 0;
    }
    // connectWallet refuses while the ticket is busy, so its prompt opens once the check is done.
    if (prompt) await connectWallet().catch(fail);
  }
  $effect(() => {
    active = submit;
    return () => void (active === submit && (active = undefined));
  });
</script>

{#snippet ladderRow(c: Draft)}
  <tr data-testid="scale-row" ondblclick={fewRows ? undefined : () => showLadder(!ladderOpen)}><td class={c.isBuy ? 'buy' : 'sell'}>{fmtPx(c.px, szDec, spot)}</td><td>{fmtSz(c.sz, szDecimals)}</td><td class="dim">{fmtIn(c.px * c.sz, quoteIn(coin))}</td></tr>
{/snippet}
{#snippet ladderToggle(testid: string, label: string, text: string, onclick: () => void)}
  <tr><td colspan="3"><button class="more dim" data-testid={testid} aria-label={label} {onclick}>{text}</button></td></tr>
{/snippet}

{#snippet check(label: string, on: boolean, set: (v: boolean) => void, testid: string)}
  <label class="check">
    <input type="checkbox" data-testid={testid} checked={on} onchange={(e) => (set(e.currentTarget.checked), e.currentTarget.blur())} />{label}
  </label>
{/snippet}

{#snippet leg(k: Leg, label: string, short: string, aria: string, gainLabel: string, gainAria: string, placeholder: string)}
  <div class="two leg">
    <Field {label} {short} bind:value={() => ticket[k], (v) => (ticket[k] = v)} cut={typePx} ariaLabel={aria} {placeholder} inputmode="decimal" />
    <Field label={gainLabel} bind:value={() => gainShown(k), (v) => setGain(k, v)} cut={typeGain} ariaLabel={gainAria} placeholder={gainLabel} inputmode="decimal">
      {#snippet suffix()}
        <Menu
          testid="panel-{k}-unit" ariaLabel="{gainLabel} unit" align="right" value={legs[k].unit} onpick={(v) => pickGainUnit(k, v)}
          options={[{ value: '%', label: '%', testid: `panel-${k}-unit-pct` }, { value: '$', label: '$', testid: `panel-${k}-unit-usd` }]}
        />
      {/snippet}
    </Field>
  </div>
{/snippet}

<div class="panel" data-testid="panel">
  <div class="form">
    <div class="acct" class:spot>
      {#if !spot}
      <button data-testid="margin-button" disabled={!meta.loaded} onclick={(e) => (blur(e), (ui.overlay = 'margin'))}>
        {asset?.marginMode === 'strictIsolated' ? 'Isolated (locked)' : lev?.type === 'isolated' || isolatedOnly(asset) ? 'Isolated' : lev || asset ? 'Cross' : 'Margin'}
      </button>
      <button data-testid="leverage-button" disabled={!meta.loaded} onclick={(e) => (blur(e), (ui.overlay = 'leverage'))}>{lev ? `${lev.value}x` : asset?.maxLeverage ? `${asset.maxLeverage}x` : 'Leverage'}</button>
      {/if}
      <button class="gear" data-testid="panel-settings" aria-label="execution settings" title="Execution settings" onclick={(e) => (blur(e), openSettings('execution'))}>⚙</button>
    </div>
    <TypeTabs bind:kind={ticket.kind} {spot} />
    <SideToggle bind:isBuy={ticket.isBuy} {spot} />
    <div class="lines">
      {#if spot}
        <div><span class="dim">Available to Trade</span><span data-testid="panel-avail">{ticket.isBuy ? `${fmtNum(avail, 2)} ${quote}` : `${fmtSz(avail, szDecimals)} ${base}`}</span></div>
        {#if ticket.isBuy && quote === 'USDC' && !(avail > 0) && modeOf(inventory.abstraction) === 'standard'}<p class="dim" data-testid="panel-spot-hint">Move USDC from perps to spot on Hyperliquid to buy</p>{/if}
        <div><span class="dim">Current Balance</span><span data-testid="panel-current">{fmtSz(balanceOf(base), szDecimals)} {base}</span></div>
      {:else}
        <div><span class="dim">Available to Trade</span><span data-testid="panel-avail">{fmtNum(avail, 2)} {quote}</span></div>
        <div><span class="dim">Current Position</span><span data-testid="panel-current" class:buy={(pos?.szi ?? 0) > 0} class:sell={(pos?.szi ?? 0) < 0}>{fmtSz(pos?.szi ?? 0, szDecimals)} {symOf(coin)}</span></div>
      {/if}
    </div>

    {#if kind === 'chase'}
      <div class="chase-px" class:sell={!ticket.isBuy}>
        <Field label="Chase Price" value={chasePx > 0 ? fmtPx(chasePx, szDec, spot) : ''} readonly testid="panel-chase-px" />
      </div>
    {/if}
    {#if isTrigger(kind)}
      <Field label="Trigger Price ({quote})" bind:value={ticket.trigger} cut={typePx} testid="panel-trigger" inputmode="decimal" />
    {/if}
    {#if priced}
      <Field label="Price ({quote})" short="Price" bind:value={ticket.px} cut={typePx} testid="panel-px" inputmode="decimal">
        {#snippet suffix()}<button class="mid" data-testid="panel-mid" onclick={mid}>Mid</button>{#if kind === 'limit' && ticket.tif === 'Alo'}<button class="mid" data-testid="panel-best" title="Best maker price: the {ticket.isBuy ? 'bid' : 'ask'}" onclick={best}>Best</button>{/if}{/snippet}
      </Field>
    {/if}
    <div class="size-field"><Field label={kind !== 'scale' ? 'Size' : 'Total size'} short={kind === 'scale' ? 'Total' : undefined} bind:value={() => sizeShown, typeSize} cut={typeSz} testid="panel-size" inputmode="decimal">
      {#snippet suffix()}
        <Menu
          testid="panel-unit" ariaLabel="size unit" align="right" value={unit} onpick={pickUnit} dropdown
          options={[{ value: 'usd', label: quote, testid: 'panel-unit-usd' }, { value: 'coin', label: symOf(coin), testid: 'panel-unit-coin' }]}
        />
      {/snippet}
    </Field></div>
    <SizeSlider {pct} onpct={setPct} />
    {#if !ticket.reduceOnly && maxSz > 0 && sz > maxSz * 1.0001}<p class="warn" data-testid="panel-max">Max {fmtSz(maxSz, szDecimals)} {spot ? base : symOf(coin)}{spot ? '' : ` at ${levX}x`}</p>{/if}

    {#if kind === 'scale'}
      <Field label="Start ({quote})" short="Start" bind:value={scaleFrom} cut={typePx} placeholder={defRange.from > 0 ? fmtPx(defRange.from, szDec, spot) : undefined} testid="panel-scale-start" inputmode="decimal" />
      <Field label="End ({quote})" short="End" bind:value={scaleTo} cut={typePx} placeholder={defRange.to > 0 ? fmtPx(defRange.to, szDec, spot) : undefined} testid="panel-scale-end" inputmode="decimal" />
      <div class="form">
        <div class="two scale-options">
          <Field label="Total Orders" short="Orders" bind:value={ticket.scaleCount} cut={typeCount} ariaLabel="Total orders" inputmode="numeric" />
          <Field label="Size Skew" short="Skew" bind:value={ticket.scaleSkew} cut={typeAmt} ariaLabel="Size skew" inputmode="decimal" />
        </div>
        {#if perOrder}
          <p class="dim" data-testid="scale-each">{perOrder.n} orders · ≈ {fmtNum(perOrder.sz, szDec)} {symOf(coin)} ({quoteIn(coin) === 'USDC' ? '$' : ''}{fmtNum(perOrder.usd, perOrder.usd < 100 ? 2 : 0)}{quoteIn(coin) === 'USDC' ? '' : ` ${quoteIn(coin)}`}) each</p>
          {#if perOrder.min < MIN_NOTIONAL}<p class="warn" data-testid="scale-min">An order is {fmtIn(perOrder.min, quoteIn(coin))}, under Hyperliquid's {minLabel(coin)} minimum</p>{/if}
        {/if}
      </div>
    {/if}

    <div class="opt">
      {#if !spot}{@render check('Reduce Only', ticket.reduceOnly, (v) => (ticket.reduceOnly = v), 'panel-reduce')}{/if}
      {#if showTif}
        <span class="tif">
          <span class="tif-help" role="group" onpointerenter={() => tifHelpOpen = true} onpointerleave={() => tifHelpOpen = false}>
            <button type="button" class="help" data-testid="panel-tif-help" aria-label="About time in force" aria-describedby={tifHelpOpen ? tifHelpId : undefined} onfocus={() => tifHelpOpen = true} onblur={() => tifHelpOpen = false} onclick={() => tifHelpOpen = true} onkeydown={(e) => { if (e.key === 'Escape') { tifHelpOpen = false; e.stopPropagation(); } }}>
              TIF
            </button>
            {#if tifHelpOpen}<span class="tif-tip" role="tooltip" id={tifHelpId} data-testid="panel-tif-help-tooltip"><strong>{selectedTif.label} <span>· Time in force</span></strong><span>{selectedTif.description}</span></span>{/if}
          </span>
          <Menu
            testid="panel-tif" ariaLabel="time in force" align="right" onpick={pickTif}
            value={isTrigger(kind) ? 'Gtc' : ticket.tif} options={isTrigger(kind) ? TIFS.slice(0, 1) : TIFS}
          />
        </span>
      {/if}
    </div>
    {#if showTpsl}
      <div class="opt">{@render check('Take Profit / Stop Loss', ticket.tpsl, setTpsl, 'panel-tpsl')}</div>
      {#if ticket.tpsl}
        {@render leg('tp', 'TP Price', 'TP', 'TP price', 'Gain', 'TP gain', 'optional')}
        {@render leg('sl', 'SL Price', 'SL', 'SL price', 'Loss', 'SL loss', 'optional')}
      {/if}
    {/if}
    {#if kind === 'chase'}
      <div class="opt">{@render check('Max Chase Distance', capOn, (v) => (capOn = v), 'panel-chase-cap')}</div>
      {#if capOn}<Field label="Distance (%)" bind:value={capText} cut={typeAmt} testid="panel-chase-distance" inputmode="decimal" />{/if}
      <p class="dim" data-testid="panel-chase-note">
        Cap {capShown}% · timeout {settings.chase.timeoutSec ? `${settings.chase.timeoutSec}s` : 'off'} · on stop {settings.chase.onStop === 'rest' ? 'leave resting' : 'market'}
      </p>
    {/if}
    {#if ladder.length}
      <table class="ladder"><tbody>
        {#if fewRows || ladderOpen}
          {#each ladder as c}{@render ladderRow(c)}{/each}
          {#if ladderOpen}{@render ladderToggle('scale-less', 'Show fewer scale orders', 'less', () => showLadder(false))}{/if}
        {:else}
          {@render ladderRow(ladder[0])}
          {@render ladderToggle('scale-more', `Show all ${ladder.length} scale orders`, `⋯ ${ladder.length - 2} more`, () => showLadder(true))}
          {@render ladderRow(ladder[ladder.length - 1])}
        {/if}
      </tbody></table>
    {/if}
  </div>

  <div class="bottom">
    <div class="place">
      <button class="submit {mode}" class:sell={mode === 'ready' && !ticket.isBuy} data-testid="panel-submit" data-side={ticket.isBuy ? 'buy' : 'sell'} data-quantity-hint={hint} aria-label={`${LABEL[mode]}: ${hint}`} disabled={placing.busy || mode === 'readonly'} onclick={(e) => (blur(e), submit(false))}>{LABEL[mode]}</button>
      {#if placing.error}<p class="err" data-testid="panel-error">{placing.error}</p>{/if}
    </div>
    <hr />
    <InfoRows {kind} isBuy={ticket.isBuy} {sz} {px} {ladder} />
  </div>
</div>

<style>
  .submit { position: relative; }
  .place { display: contents; }

  .panel {
    --ctl: max(32px, calc(var(--fs) * 2.4));
    container: order-ticket / inline-size;
    display: flex; flex-direction: column; padding: 8px;
    font-family: var(--sans); font-size: var(--fs); font-weight: 400; font-variant-numeric: tabular-nums; color: var(--text);
  }
  .form { display: flex; flex-direction: column; gap: 6px; }
  .acct { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; }
  .acct .gear { padding: 0 8px; }
  .acct.spot { grid-template-columns: auto; justify-content: end; }
  .acct button {
    display: flex; align-items: center; justify-content: center; height: var(--ctl); padding: 0 8px; border: 1px solid transparent; border-radius: var(--radius); background: var(--surface); color: var(--bright);
    transition: background-color 0.2s ease-in-out, color 0.2s ease-in-out;
  }
  .panel :global(.side) { margin: 2px 0; }
  .panel :global(.slider) { grid-template-columns: 1fr minmax(calc(var(--fs) * 4), auto); gap: 6px; }
  .panel :global(.pct) { padding: 0 6px; }
  .panel :global(.pct input) { text-align: right; }
  .lines { display: grid; gap: 4px; line-height: calc(var(--fs) * 1.25); }
  /* A value too wide for the row drops to its own right-aligned line rather than breaking mid-number. */
  .lines div { display: flex; flex-wrap: wrap; justify-content: space-between; column-gap: 8px; }
  .lines span:nth-child(even) { margin-left: auto; text-align: right; color: var(--bright); overflow-wrap: anywhere; }
  .lines span:nth-child(even).buy { color: var(--buy-text); }
  .lines span:nth-child(even).sell { color: var(--sell-text); }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; }
  .size-field :global(.field) { gap: 4px; padding-block: 0; }
  .size-field :global(input) { flex: 1 1 0; width: 0; min-width: 0; }
  .size-field :global(.suffix), .size-field :global(.menu) { align-self: stretch; align-items: stretch; }
  .size-field :global([data-testid='panel-unit']) { height: 100%; min-width: 0; gap: 4px; padding: 0; line-height: 1; }
  .leg :global(.field + .field input::placeholder) { color: transparent; }
  .mid { padding: 0; background: none; color: var(--accent); }
  .chase-px :global(.value) { color: var(--buy); }
  .chase-px.sell :global(.value) { color: var(--sell); }
  .opt { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; min-height: 21px; }
  .check { display: grid; grid-template-columns: 16px 1fr; gap: 6px; align-items: center; color: var(--bright); cursor: pointer; }
  .check input {
    appearance: none; width: 16px; height: 16px; margin: 0; padding: 0; border: 1px solid var(--faint); border-radius: var(--radius);
    background: none; cursor: pointer; outline: none;
  }
  .check input:checked { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 3px var(--panel); }
  .check input:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .tif { position: relative; display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .tif-help { display: inline-flex; }
  .help { padding: 0; background: none; color: var(--dim); }
  .help:hover, .help:focus-visible { color: var(--bright); }
  .tif-tip { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 6; width: min(260px, calc(100vw - 32px)); display: grid; gap: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: 0 6px 20px #0005; color: var(--text); font-size: max(12px, var(--fs)); line-height: 1.5; white-space: normal; }
  .tif-tip strong { color: var(--accent); }
  .tif-tip strong span { color: var(--dim); font-weight: 400; }
  .dim { color: var(--dim); }
  p { margin: 0; }
  .ladder { width: 100%; border-collapse: collapse; font-size: max(8px, calc(var(--fs) * 0.917)); }
  .ladder td { padding: 1px 0; text-align: right; }
  .more { display: block; width: 100%; height: auto; padding: 0; border: 0; background: none; font: inherit; text-align: right; cursor: pointer; }
  .more:hover { color: var(--bright); }
  .more:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .bottom { display: flex; flex-direction: column; gap: 6px; margin-top: auto; padding-top: 8px; }
  .submit {
    height: var(--ctl); border: 1px solid transparent; border-radius: var(--radius); font-size: var(--fs);
    transition: background-color 0.2s ease-in-out, color 0.2s ease-in-out;
  }
  .submit.connect, .submit.enable { background: var(--accent); color: var(--bg); }
  .submit.readonly { background: var(--surface); color: var(--dim); }
  .submit.ready { background: var(--buy); color: var(--bg); }
  .submit.ready.sell { background: var(--sell-action); }
  .err { color: var(--sell); }
  .warn { color: var(--warn); }
  hr { width: 100%; margin: 0; border: 0; border-top: 1px solid var(--line); }
  @container order-ticket (max-width: 260px) {
    .acct { grid-template-columns: minmax(0, 1fr) auto auto; }
    .acct button { min-width: 0; padding-inline: 6px; }
    .two { grid-template-columns: minmax(0, 1fr); }
    .panel :global(.field) { padding-inline: 6px; }
    .panel :global(.field .label) { min-width: 0; white-space: normal; line-height: 1.1; }
  }
  @media (max-width: 900px) {
    .panel { --ctl: max(40px, calc(var(--fs) * 2.4)); }
    .acct { grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px; }
    .acct button { min-width: 0; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .form { gap: 4px; }
    .acct .gear { font-size: 1.3em; }
    .two { grid-template-columns: repeat(auto-fit, minmax(min(100%, 15em), 1fr)); }
    .two.scale-options { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px; }
    .scale-options :global(.label) { font-size: max(10px, calc(var(--fs) * 0.857)); }
    .scale-options :global(.field:first-child input) { min-width: 2ch; }
    .two.leg { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px; }
    .leg :global(.field) { gap: 3px; }
    .leg :global(.label) { max-width: 1.5em; }
    .leg :global(input) { min-width: 0; }
    .leg :global(.field + .field .label) { display: none; }
    .leg :global(.field + .field input::placeholder) { color: var(--dim); }
    .opt { min-height: 32px; }
    .tif-tip { width: min(260px, calc(58vw - 24px)); }
    .check { align-self: stretch; }
  }
  @media (max-width: 900px), (pointer: coarse) and (max-height: 500px) {
    .panel { gap: 6px; }
    .bottom { display: contents; }
    hr { margin-top: auto; }
    .place {
      order: 1; position: sticky; bottom: max(0px, calc(var(--kb, 0px) - var(--below, 0px))); z-index: 1;
      display: flex; flex-direction: column-reverse; gap: 4px; padding: 4px 0; background: var(--panel);
    }
    .submit { min-height: 44px; }
  }
</style>
