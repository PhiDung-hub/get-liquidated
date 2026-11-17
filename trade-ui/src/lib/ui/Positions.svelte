<script module lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  /** Phone cards opened by a tap, kept across tab switches. */
  const expanded = new SvelteSet<string>();
</script>

<script lang="ts">
  import { inventory, liqDist, markOf as mark, type Position } from '$lib/account/inventory.svelte';
  import { isTrailing, openOrders } from '$lib/account/orders.svelte';
  import { session, viewAddress } from '$lib/session/session.svelte';
  import { listed, maintenance, meta } from '$lib/market/meta.svelte';
  import { selectCoin } from '$lib/market/market.svelte';
  import { fmtCompact, fmtPct, fmtPx, fmtSz, fmtUsd, fmtUsdShort } from '$lib/util/format';
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
  const rows = $derived(sorter.sort(inventory.positions.filter((p) => p.szi !== 0 && inFilter(p.coin, p.szi > 0))));
  const totalFunding = $derived(-rows.reduce((sum, p) => sum + p.fundingSinceOpen, 0));
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
{#snippet roe(p: Position)}{Math.abs(p.roe * 100) >= 1000 ? `${p.roe < 0 ? '-' : '+'}${fmtCompact(Math.abs(p.roe * 100))}%` : fmtPct(p.roe)}{/snippet}
{#snippet pnl(p: Position)}
  <span class="pnl"><span data-testid="position-pnl" title="{fmtUsd(p.uPnl)} ({fmtPct(p.roe)})">{@render usd(p.uPnl, true)}</span>{' ('}<span data-testid="position-roe">{@render roe(p)}</span>)</span>
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
              <div class="field"><span class="label">Funding</span><span class="value num" class:buy={p.fundingSinceOpen <= 0} class:sell={p.fundingSinceOpen > 0}>{@render usd(-p.fundingSinceOpen, true)}</span></div>
              <div class="field"><span class="label">TP / SL</span><span class="value num">{@render tpsl(p, true)}</span></div>
            </div>
          {/if}
          {#if canTrade}<div class="position-controls" data-testid="position-controls">{@render actions(p)}</div>{/if}
        </div>
      </div>
    {/each}
    <p class="total dim"><abbr title="Open positions, since opening">Total funding</abbr> <b class="num" class:buy={totalFunding >= 0} class:sell={totalFunding < 0} data-testid="positions-total-funding">{@render usd(totalFunding)}</b></p>
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
          <td class="num" class:buy={p.fundingSinceOpen <= 0} class:sell={p.fundingSinceOpen > 0}>{@render usd(-p.fundingSinceOpen)}</td>
          <td class="num">{@render tpsl(p)}</td>
          <td>{#if canTrade}{@render actions(p)}{/if}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot><tr><td colspan="8" class="dim">Total funding · open positions, since opening</td><td class="num" class:buy={totalFunding >= 0} class:sell={totalFunding < 0} data-testid="positions-total-funding">{@render usd(totalFunding)}</td><td colspan="2"></td></tr></tfoot>
  </table>
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
  .total { display: flex; justify-content: space-between; gap: 8px; padding: 0 2px; }
  .margin [data-help] { cursor: default; text-decoration: underline dashed var(--faint); text-underline-offset: 3px; }
  .margin [data-help]:hover, :global(abbr:hover) { text-decoration-color: var(--dim); }
</style>
