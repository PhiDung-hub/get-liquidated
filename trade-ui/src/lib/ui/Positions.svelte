<script module lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  /** Phone cards opened by a tap, kept across tab switches. */
  const expanded = new SvelteSet<string>();
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { dailyFunding, FUNDING_DAY_MS } from '$lib/account/funding.svelte';
  import { fractionOfEquity, inventory, liqDist, markOf as mark, summary, type Position } from '$lib/account/inventory.svelte';
  import { isTrailing, openOrders } from '$lib/account/orders.svelte';
  import { session, viewAddress } from '$lib/session/session.svelte';
  import { listed, maintenance, meta } from '$lib/market/meta.svelte';
  import { market, selectCoin } from '$lib/market/market.svelte';
  import { socket } from '$lib/transport/ws.svelte';
  import { fmtCompact, fmtNum, fmtPct, fmtPx, fmtSz, fmtUsd, fmtUsdShort } from '$lib/util/format';
  import { toast } from './toast.svelte';
  import Coin from './Coin.svelte';
  import { ui, type Modal } from './state.svelte';
  import SortHead from './SortHead.svelte';
  import { cardFold, cards, inFilter, Sorter, sweepOf } from './tables.svelte';

  const sorter = new Sorter<Position>([
    { key: 'coin', label: 'Coin', value: (p) => p.coin },
    { key: 'size', label: 'Size', value: (p) => p.szi },
    { key: 'value', label: 'Value', value: (p) => p.positionValue },
    { key: 'entry', label: 'Entry', value: (p) => p.entryPx },
    { key: 'mark', label: 'Mark', value: (p) => mark(p) },
    { key: 'pnl', label: 'uPnL (ROE)', value: (p) => p.uPnl, title: 'excl. funding & fees' },
    { key: 'liq', label: 'Liq. (dist)', value: (p) => p.liqPx },
    { key: 'margin', label: 'Margin', value: (p) => p.marginUsed },
    { key: 'funding', label: 'Funding', value: (p) => -p.fundingSinceOpen }
  ], '');
  const openPositions = $derived(inventory.positions.filter((p) => p.szi !== 0));
  const rows = $derived(sorter.sort(openPositions.filter((p) => inFilter(p.coin, p.szi > 0))));
  let dayStart = $state<number | null>(null);
  onMount(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const now = Date.now();
      dayStart = Math.floor(now / FUNDING_DAY_MS) * FUNDING_DAY_MS;
      timer = setTimeout(update, dayStart + FUNDING_DAY_MS - now);
    };
    update();
    return () => clearTimeout(timer);
  });
  const todayFunding = $derived(dayStart !== null && socket.state === 'open' ? dailyFunding(dayStart) : null);
  function hourlyFunding(p: Position): number | null {
    const ctx = (p.coin === market.coin ? market.ctx : null) ?? meta.ctxs.get(p.coin);
    if (socket.state !== 'open' || !ctx || ctx.oraclePx === null || !(ctx.oraclePx > 0) || ctx.funding === null) return null;
    const amount = -p.szi * ctx.oraclePx * ctx.funding;
    return Number.isFinite(amount) ? amount : null;
  }
  const totals = $derived.by(() => {
    if (inventory.broken.length) return null;
    let pnl = 0, margin = 0, since = 0;
    let today: number | null = todayFunding ? 0 : null;
    let hourly: number | null = 0;
    for (const p of openPositions) {
      pnl += p.uPnl;
      margin += p.marginUsed;
      since -= p.fundingSinceOpen;
      if (today !== null) today += todayFunding?.get(p.coin) ?? 0;
      if (hourly !== null) {
        const amount = hourlyFunding(p);
        hourly = amount === null ? null : hourly + amount;
      }
    }
    return { pnl, margin, since, today, hourly };
  });
  const fundingAmount = (n: number | null) => n === null ? '—' : Math.abs(n) > 0 && Math.abs(n) < 0.01 ? `${n < 0 ? '-' : '+'}$${fmtNum(Math.abs(n), 4)}` : `${n > 0 ? '+' : ''}${fmtUsd(n)}`;
  const equity = $derived(summary().equity);
  const accountReturn = $derived(fractionOfEquity(totals?.pnl ?? NaN, equity));
  const dec = (coin: string) => meta.byName.get(coin)?.szDecimals;
  const priceTone = (p: Position) => {
    const move = (mark(p) - p.entryPx) * Math.sign(p.szi);
    return !Number.isFinite(move) || move === 0 ? '' : move > 0 ? 'buy' : 'sell';
  };
  const triggers = (p: Position) => openOrders.list.filter((o) => o.coin === p.coin && o.isTrigger && !isTrailing(o) && o.reduceOnly && o.side === (p.szi > 0 ? 'A' : 'B'));
  const canTrade = $derived(!!session.agent && session.holdsSigner);
  const keyOf = (p: Position) => p.dex + p.coin;
  const toggle = (k: string) => (expanded.has(k) ? expanded.delete(k) : expanded.add(k));
  const allOpen = $derived(rows.every((p) => expanded.has(keyOf(p))));
  const toggleAll = () => (allOpen ? expanded.clear() : rows.forEach((p) => expanded.add(keyOf(p))));
  $effect(() => {
    cardFold.open = allOpen;
    cardFold.run = cards.current && rows.length > 1 ? toggleAll : null;
    return () => void (cardFold.run = null);
  });

  function maint(p: Position) {
    const a = meta.byName.get(p.coin);
    if (!a) return { text: '—', title: `${p.coin} is not in the market list` };
    const m = maintenance(a, p.positionValue);
    const less = m.deduction ? ` − ${fmtUsd(m.deduction)} tier deduction` : '';
    return {
      text: fmtUsdShort(m.margin),
      title: `used: this position's margin from HL (value ÷ leverage). maint: value ${fmtUsd(p.positionValue)} × ${(m.rate * 100).toFixed(3)}%${less} = ${fmtUsd(m.margin)}, where the rate is 1 / (2 × max leverage of the tier the value falls in, from ${p.coin}'s margin table). Cross positions are liquidated when account value falls below the sum of their maint.\n\nCross margin is your account balance, shared by every cross position: Hyperliquid adds or removes margin only on isolated positions, so add margin here by depositing USDC on Hyperliquid. An open position can't switch to isolated.`
    };
  }
  function adjust(e: MouseEvent, coin: string) {
    (e.currentTarget as HTMLElement).blur();
    if (!listed(coin)) return toast.error(`${coin} is not in the market list yet`);
    ui.overlay = { kind: 'isoMargin', coin };
  }

  function editTpsl(e: MouseEvent, coin: string) {
    (e.currentTarget as HTMLElement).blur();
    if (!listed(coin)) return toast.error(`${coin} market metadata is unavailable. Wait for markets to load or check whether it was delisted.`);
    ui.overlay = { kind: 'positionTpsl', coin, focus: 'TP' };
  }

  function act(e: MouseEvent, overlay: Modal & { coin: string }) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).blur();
    if (!listed(overlay.coin)) return toast.error(`${overlay.coin} is not in the market list yet`);
    ui.overlay = overlay;
  }
</script>

{#snippet coinCell(p: Position)}<span class="identity"><button class="link" class:buy={p.szi > 0} class:sell={p.szi < 0} onclick={() => selectCoin(p.coin)}><Coin coin={p.coin} /></button><span class="leverage" data-testid="position-leverage">{p.leverage.value}×</span></span>{/snippet}
{#snippet usd(n: number, card = false)}<span title={Math.abs(n) >= (card ? 1000 : 1e5) ? fmtUsd(n) : undefined}>{card && Math.abs(n) >= 1000 ? `${n < 0 ? '-' : ''}$${fmtCompact(Math.abs(n))}` : fmtUsdShort(n)}</span>{/snippet}
{#snippet fundingValue(since: number | null, today: number | null, hourly: number | null, total = false)}
  {@const details = `Since open  ${fundingAmount(since)}\nToday UTC  ${fundingAmount(today)}\nEst. / hr  ${fundingAmount(hourly)}\nEst. / day  ${fundingAmount(hourly === null ? null : hourly * 24)}`}
  <button type="button" class="funding-value num" class:buy={(since ?? 0) > 0} class:sell={(since ?? 0) < 0}
    data-testid={total ? 'positions-total-funding' : 'position-funding'} data-help-detail={details}
    aria-label={`${total ? 'Total funding for open positions' : 'Position funding'}. ${details.replaceAll('\n', '. ')}`}>
    {since === null ? '—' : Math.abs(since) >= 1000 && cards.current ? `${since < 0 ? '-' : ''}$${fmtCompact(Math.abs(since))}` : since !== 0 && Math.abs(since) < 0.01 ? fundingAmount(since) : fmtUsdShort(since)}
  </button>
{/snippet}
{#snippet positionFunding(p: Position)}
  {@render fundingValue(-p.fundingSinceOpen, todayFunding ? todayFunding.get(p.coin) ?? 0 : null, hourlyFunding(p))}
{/snippet}
{#snippet percentage(ratio: number)}{Math.abs(ratio * 100) >= 1000 ? `${ratio < 0 ? '-' : '+'}${fmtCompact(Math.abs(ratio * 100))}%` : fmtPct(ratio)}{/snippet}
{#snippet pnl(p: Position)}
  <span class="pnl"><span data-testid="position-pnl" data-help title="{fmtUsd(p.uPnl)} · {fmtPct(p.roe)} ROE · {fmtPct(fractionOfEquity(p.uPnl, equity))} of account equity">{@render usd(p.uPnl, true)}</span>{' ('}<span data-testid="position-roe">{@render percentage(p.roe)}</span>)</span>
{/snippet}
{#snippet liq(p: Position)}{@const d = liqDist(p)}{p.liqPx ? fmtPx(p.liqPx, dec(p.coin)) : '—'}{#if p.liqPx && d !== '>1000%'}{' '}<span class="dim" data-testid="position-liq-distance">({p.liqPx < mark(p) ? '-' : '+'}{d})</span>{/if}{/snippet}
{#snippet margin(p: Position, card = false)}
  <span class="margin-amount">
  {#if p.leverage.type === 'cross'}
    {@const m = maint(p)}
    <span data-help title={m.title}>{@render usd(p.marginUsed, card)}{#if !card}{' · '}{m.text} maint{/if}</span>
  {:else}
    {@render usd(p.marginUsed, card)}{#if canTrade}<button aria-label="Adjust margin" title="Adjust margin" data-testid="margin-edit" onclick={(e) => adjust(e, p.coin)}>✎</button>{/if}
  {/if}
  </span>
  {#if !card}{' '}<span class="margin-mode dim" data-testid="position-margin-mode">{p.leverage.type === 'cross' ? 'Cross' : 'Isolated'}</span>{/if}
{/snippet}
{#snippet tpsl(p: Position, card = false)}{@const exits = triggers(p)}<button class="link tpsl" class:buy={exits.length > 0 && p.szi < 0} class:sell={exits.length > 0 && p.szi > 0} title="Add or edit TP/SL" data-testid="position-tpsl" disabled={!listed(p.coin)} aria-label={`Edit ${p.coin} TP/SL`} onclick={(e) => editTpsl(e, p.coin)}>{#if card && exits.length}{#each exits as o (o.oid)}<span class="tpsl-trigger">{o.orderType.startsWith('Take') ? 'TP' : 'SL'} {fmtPx(o.triggerPx, dec(p.coin))}</span>{/each}{:else}{exits.map((o) => `${o.orderType.startsWith('Take') ? 'TP' : 'SL'} ${fmtPx(o.triggerPx, dec(p.coin))}`).join(' / ') || '+ Add'}{/if}</button>{/snippet}

{#snippet actions(p: Position)}
  <span class="actions">
    <button class="link" data-testid="position-limit" onclick={(e) => act(e, { kind: 'close', coin: p.coin, limit: true })}>Limit</button>
    <button class="link" data-testid="position-market" onclick={(e) => act(e, { kind: 'close', coin: p.coin, limit: false })}>Market</button>
    <button class="link" data-testid="position-trailing" title="Follows price; triggers on a set retracement." onclick={(e) => act(e, { kind: 'trailing', coin: p.coin })}>Trailing</button>
    {#if !meta.byName.get(p.coin)?.isDelisted}<button class="link" data-testid="position-reverse" title="Close your position and open a position with the same size in the opposite direction." onclick={(e) => act(e, { kind: 'reverse', coin: p.coin })}>Reverse</button>{/if}
  </span>
{/snippet}
{#snippet closeAll()}<button class="sweep" data-testid="flatten-open" onclick={(e) => sweepOf(e, 'flatten')}>Close All</button>{/snippet}

{#snippet pnlTotal()}
  <b class="sum num" class:buy={(totals?.pnl ?? 0) > 0} class:sell={(totals?.pnl ?? 0) < 0} data-testid="positions-total-pnl">
    {@render usd(totals?.pnl ?? NaN)} <span class="account-return" data-help title="Unrealized PnL as a share of account equity ({fmtUsd(equity)}): {fmtPct(accountReturn)}">({@render percentage(accountReturn)} acct)</span>
  </b>
{/snippet}
{#snippet marginTotal()}<b class="sum num" data-testid="positions-total-margin">{@render usd(totals?.margin ?? NaN)}</b>{/snippet}
{#snippet fundingTotal()}
  <span class="sum">{@render fundingValue(totals?.since ?? null, totals?.today ?? null, totals?.hourly ?? null, true)}</span>
{/snippet}

{#if !rows.length}
  {#if canTrade && !cards.current && (openOrders.list.length || inventory.positions.some((p) => p.szi !== 0))}<div class="sweeps">{@render closeAll()}</div>{/if}
  <p class="dim" data-testid="account-empty">{viewAddress() && !inventory.loaded ? 'Loading positions…' : inventory.positions.some((p) => p.szi !== 0) ? 'No positions match the filter.' : 'No open positions.'}</p>
{:else if cards.current}
  <div class="cards">
    {#each rows as p (keyOf(p))}
      {@const k = keyOf(p)}
      {@const open = expanded.has(k)}
      {@const tone = priceTone(p)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="card" class:open data-testid="position-row" onclick={(e) => !open && !(e.target as Element).closest('button, [data-help], abbr') && toggle(k)}>
        <button class="chevron" data-testid="position-expand" aria-expanded={open} aria-label="{open ? 'Hide' : 'Show'} {p.coin} position details" onclick={(e) => { e.stopPropagation(); toggle(k); }}>{open ? '▴' : '▾'}</button>
        <div class="position-content">
          <div class="position-heading">{@render coinCell(p)}<span class="head-pnl"><abbr class="label" title="excl. funding & fees">PnL</abbr><span class="value num" class:buy={p.uPnl >= 0} class:sell={p.uPnl < 0}>{@render pnl(p)}</span></span></div>
          <div class="grid summary">
            <div class="field"><span class="label">Size</span><span class="value num" title={fmtSz(p.szi, dec(p.coin))} class:buy={p.szi > 0} class:sell={p.szi < 0}>{Math.abs(p.szi) >= 1000 ? fmtCompact(p.szi) : fmtSz(p.szi, dec(p.coin))}</span></div>
            <div class="field"><span class="label">Entry</span><span class="value num price entry {tone}" data-testid="position-entry">{fmtPx(p.entryPx, dec(p.coin))}</span></div>
            <div class="field" data-testid="position-liq"><span class="label">Liq. price</span><span class="value num">{@render liq(p)}</span></div>
          </div>
          {#if open}
            <div class="position-details">
              <div class="field"><span class="label">Mark</span><span class="value num price mark {tone}" data-testid="position-mark">{fmtPx(mark(p), dec(p.coin))}</span></div>
              <div class="field"><span class="label">Value</span><span class="value num">{@render usd(p.positionValue, true)}</span></div>
              <div class="field margin" data-testid="position-margin"><span class="label">Margin <span class="margin-mode dim" data-testid="position-margin-mode">{p.leverage.type === 'cross' ? 'Cross' : 'Isolated'}</span></span><span class="value num">{@render margin(p, true)}</span></div>
              <div class="field"><span class="label">Funding</span><span class="value">{@render positionFunding(p)}</span></div>
              <div class="field"><span class="label">TP / SL</span><span class="value num">{@render tpsl(p, true)}</span></div>
            </div>
          {/if}
          {#if canTrade}<div class="position-controls" data-testid="position-controls">{@render actions(p)}</div>{/if}
        </div>
      </div>
    {/each}
  </div>
{:else}
  <table class="pin-last">
    <thead><tr><SortHead {sorter} /><th>TP / SL</th><th>{#if canTrade}{@render closeAll()}{/if}</th></tr></thead>
    <tbody>
      {#each rows as p (p.dex + p.coin)}
        {@const tone = priceTone(p)}
        <tr data-testid="position-row">
          <td>{@render coinCell(p)}</td>
          <td class="num" class:buy={p.szi > 0} class:sell={p.szi < 0}>{fmtSz(p.szi, dec(p.coin))}</td>
          <td class="num">{@render usd(p.positionValue)}</td>
          <td class="num price entry {tone}" data-testid="position-entry">{fmtPx(p.entryPx, dec(p.coin))}</td>
          <td class="num price mark {tone}" data-testid="position-mark">{fmtPx(mark(p), dec(p.coin))}</td>
          <td class="num" class:buy={p.uPnl >= 0} class:sell={p.uPnl < 0}>{@render pnl(p)}</td>
          <td class="num">{@render liq(p)}</td>
          <td class="num margin" data-testid="position-margin">{@render margin(p)}</td>
          <td>{@render positionFunding(p)}</td>
          <td class="num">{@render tpsl(p)}</td>
          <td>{#if canTrade}{@render actions(p)}{/if}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot class="totals" aria-label="All open perp positions" data-testid="positions-totals">
      <tr>
        <td colspan="5"></td>
        <td>{@render pnlTotal()}</td>
        <td></td>
        <td>{@render marginTotal()}</td>
        <td>{@render fundingTotal()}</td>
        <td></td><td></td>
      </tr>
    </tfoot>
  </table>
{/if}
{#if openPositions.length && (cards.current || !rows.length)}
  <div class="totals summary-grid" aria-label="All open perp positions" role="group" data-testid="positions-totals">
    <div><span class="total-label">Unrealized PnL</span>{@render pnlTotal()}</div>
    <div><span class="total-label" title="Sum of margin used by open positions">Margin used</span>{@render marginTotal()}</div>
    <div><span class="total-label">Funding</span>{@render fundingTotal()}</div>
  </div>
{/if}

<style>
  .link { background: none; padding: 0; font-weight: 600; }
  .link.buy { color: var(--buy-text); }
  .link.sell { color: var(--sell-text); }
  .tpsl { cursor: pointer; text-decoration: underline dotted var(--faint); text-underline-offset: 3px; }
  .tpsl:hover, .tpsl:focus-visible { text-decoration: underline; }
  .tpsl:not(.buy, .sell):is(:hover, :focus-visible) { color: var(--accent); }
  .tpsl:focus-visible { outline: 1px solid var(--accent); outline-offset: 3px; }
  p { padding: 12px; }
  .margin { white-space: nowrap; }
  .margin-mode { margin-left: 4px; font-size: max(8px, 0.9em); }
  .margin [data-testid='margin-edit'] { background: none; color: var(--accent); }
  .sweeps { display: flex; justify-content: flex-end; padding: 6px 8px 0; }
  .card { position: relative; container-type: inline-size; -webkit-tap-highlight-color: transparent; }
  .card:not(.open) { cursor: pointer; }
  .position-content { display: grid; gap: 2px; }
  .position-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px; min-width: 0; min-height: 24px; padding-right: 32px; }
  .head-pnl { display: flex; align-items: baseline; gap: 4px; margin-left: auto; white-space: nowrap; }
  .head-pnl .value { font-weight: 500; }
  .summary, .position-details { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(max-content, 1.3fr); gap: 4px 8px; align-items: start; }
  .card [data-testid='position-liq'] .value { gap: 4px; }
  .card [data-testid='position-liq-distance'] { font-size: max(10px, 0.857em); }
  .card .field { min-width: 0; }
  .position-details, .card .field, .position-controls { border: 0; }
  .field:nth-child(3n+2) { align-items: center; text-align: center; }
  .field:nth-child(3n) { align-items: flex-end; text-align: right; }
  .pnl { white-space: nowrap; }
  .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .summary .label, .position-details .label, .head-pnl .label { font-size: max(10px, calc(var(--fs) * 0.857)); }
  .summary > .field > .value { font-weight: 500; }
  .card .value { display: flex; align-items: baseline; min-height: 20px; font-size: min(var(--fs), 5cqi); line-height: 20px; white-space: nowrap; overflow-wrap: normal; }
  .card .margin-amount { display: flex; align-items: baseline; min-height: 24px; }
  .card .margin-mode { margin-left: 4px; font-size: inherit; }
  .card .tpsl, .card [data-testid='margin-edit'] { display: flex; align-items: stretch; justify-content: flex-start; min-height: 24px; min-width: 0; padding: 0; text-align: left; line-height: inherit; }
  .card .tpsl { flex-direction: column; text-align: inherit; white-space: nowrap; }
  .tpsl-trigger { display: block; }
  .card .chevron { position: absolute; top: 4px; right: 4px; width: 32px; height: 32px; min-width: 32px; min-height: 32px; display: grid; place-items: center; background: none; padding: 0; color: var(--dim); font-size: 18px; line-height: 1; }
  .position-controls { display: flex; justify-content: flex-end; margin-top: auto; }
  .identity { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
  .card .identity .link { display: inline-flex; align-items: center; min-height: 28px; min-width: 0; }
  .leverage { flex: none; color: var(--dim); white-space: nowrap; font-size: max(8px, calc(var(--fs) * 0.917)); }
  .card .actions { flex: 0 1 auto; min-width: 0; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; gap: 0 8px; }
  .card .actions .link { flex: none; min-height: 32px; min-width: 0; padding: 0; white-space: nowrap; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  table :global(:is(th, td)) { padding-inline: 4px; }
  table :global(:is(th, td):first-child) { padding-left: 8px; }
  .actions .link { color: var(--accent); font-size: max(8px, calc(var(--fs) * 0.917)); font-weight: 500; }
  .actions .link:hover { text-decoration: underline; }
  .price.entry.buy { color: color-mix(in srgb, var(--buy-text) 65%, var(--dim)); }
  .price.entry.sell { color: color-mix(in srgb, var(--sell-text) 65%, var(--dim)); }
  .price.mark.buy { color: var(--buy-text); }
  .price.mark.sell { color: var(--sell-text); }
  @media (pointer: coarse) { .actions .link { min-height: 32px; } }
  tfoot td { padding-block: 12px 6px; vertical-align: bottom; }
  .sum { position: relative; display: inline-block; padding-top: 5px; }
  .account-return { white-space: nowrap; }
  .sum::before { content: ''; position: absolute; inset: 0 0 auto; height: 1px; background: var(--dim); transform: scaleY(0.5); }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8em), 1fr)); gap: 8px 12px; padding: 12px 8px 6px; }
  .total-label { display: block; margin-bottom: 2px; color: var(--dim); font-weight: 400; white-space: normal; }
  .funding-value { min-height: 0; min-width: 0; padding: 0; background: none; white-space: nowrap; cursor: help; }
  .totals .funding-value { font-weight: 700; }
  .totals .funding-value:not(.buy, .sell) { color: inherit; }
  .funding-value.buy { color: var(--buy-text); }
  .funding-value.sell { color: var(--sell-text); }
  .margin [data-help] { cursor: default; text-decoration: underline dashed var(--faint); text-underline-offset: 3px; }
  .margin [data-help]:hover, :global(abbr:hover) { text-decoration-color: var(--dim); }
</style>
