<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import { market } from '$lib/market/market.svelte';
  import { isSpot, meta, quoteOf } from '$lib/market/meta.svelte';
  import { liqDist, positionOf } from '$lib/account/inventory.svelte';
  import { socket } from '$lib/transport/ws.svelte';
  import { session } from '$lib/session/session.svelte';
  import { armed, setArmed } from '$lib/hotkeys/armed.svelte';
  import { fmtIn, fmtPct, fmtPx, fmtSz, fmtUsd } from '$lib/util/format';
  import { settings } from '$lib/settings/settings.svelte';
  import { ui } from './state.svelte';
  import { toggleZenPart } from './zen';
  import Coin from './Coin.svelte';
  import FundingRate from './FundingRate.svelte';
  import ZenToggle from './ZenToggle.svelte';

  const ctx = $derived(market.ctx ?? meta.ctxs.get(market.coin) ?? null);
  const dec = $derived(meta.byName.get(market.coin)?.szDecimals);
  const spot = $derived(isSpot(market.coin));
  const quote = $derived(quoteOf(market.coin));
  const change = $derived(ctx ? (ctx.markPx - ctx.prevDayPx) / ctx.prevDayPx : NaN);
  const pos = $derived(positionOf(market.coin));
  const tap = (f: () => void) => (e: MouseEvent) => ((e.currentTarget as HTMLElement).blur(), f());
  const PARTS = [['order', 'Order', 'Ord'], ['positions', 'Positions', 'Pos'], ['book', 'Book', 'Book']] as const;
  const phone = new MediaQuery('max-width: 900px');
</script>

<div class="zen" data-testid="zen-strip">
  <div class="line">
    <span class="sock" data-testid="zen-socket" data-state={socket.state} title="socket {socket.state}"><i class:ok={socket.state === 'open'}></i>{socket.state === 'open' ? '' : socket.state}</span>
    <button class="coin" data-testid="zen-coin" onclick={tap(() => (ui.overlay = 'picker'))}><Coin coin={market.coin} quote={phone.current ? '' : quoteOf(market.coin)} /></button>
    <span class="metric">{#if !phone.current}<span class="dim">Mark</span>{/if}<span class="num" data-testid="zen-mark">{ctx ? fmtPx(ctx.markPx, dec, spot) : '—'}</span></span>
    <span class="metric">{#if !phone.current}<span class="dim">24h</span>{/if}<span class="num" data-testid="zen-change" class:buy={change >= 0} class:sell={change < 0}>{fmtPct(change)}</span></span>
    <div class="market-stats">
      {#if !spot}
        <span class="metric"><span class="dim">Oracle</span><span class="num" data-testid="zen-oracle">{ctx?.oraclePx != null ? fmtPx(ctx.oraclePx, dec) : '—'}</span></span>
        <span class="metric"><span class="dim">Funding</span><FundingRate rate={ctx?.funding ?? null} prefix="zen-" /></span>
        <span class="metric"><span class="dim">OI</span><span class="num" data-testid="zen-open-interest">{ctx?.openInterest != null ? fmtUsd(ctx.openInterest * ctx.markPx) : '—'}</span></span>
      {/if}
      <span class="metric"><span class="dim">24h Vol</span><span class="num" data-testid="zen-day-volume">{ctx ? fmtIn(ctx.dayNtlVlm, quote) : '—'}</span></span>
    </div>
    {#if !spot && pos && pos.szi !== 0}
      <span class="num" data-testid="zen-pos" class:buy={pos.szi > 0} class:sell={pos.szi < 0}>{pos.szi > 0 ? 'Long' : 'Short'} {fmtSz(Math.abs(pos.szi), dec)}</span>
      <span class="num" data-testid="zen-upnl" class:buy={pos.uPnl >= 0} class:sell={pos.uPnl < 0}>{fmtUsd(pos.uPnl)}</span>
      {#if pos.liqPx}<span class="num warn" data-testid="zen-liq">liq {liqDist(pos)}</span>{/if}
    {:else if !spot}
      <span class="dim" data-testid="zen-pos">flat</span>
    {/if}
    {#if session.readOnlyReason}<span class="warn" data-testid="zen-readonly">{session.readOnlyReason}</span>{/if}
    <span class="push"></span>
    {#each PARTS as [id, label, short] (id)}
      {@const on = settings.display.zenOpen[id]}
      <button class:on aria-pressed={on} data-testid="zen-{id}" aria-label={label} onclick={tap(() => toggleZenPart(id))}>{phone.current ? short : label}</button>
    {/each}
    <button class="arm" class:armed={armed.on} data-testid="zen-arm" title="Arm / disarm the execution keys" onclick={tap(() => setArmed(!armed.on))}>{armed.on ? 'ARMED' : 'disarmed'}</button>
    {#if !phone.current && !ui.chartFull}<ZenToggle />{/if}
  </div>
</div>

<style>
  .zen { border-bottom: 1px solid var(--line); padding-top: env(safe-area-inset-top); font: max(8px, calc(var(--fs) * 0.917)) var(--mono); font-variant-ligatures: none; }
  .line { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; padding: 2px 10px; white-space: nowrap; }
  .metric { display: inline-flex; align-items: baseline; gap: 5px; }
  .market-stats { display: contents; }
  button { background: none; padding: 2px 6px; color: var(--dim); }
  .coin { color: var(--bright); font-weight: 600; padding-left: 0; }
  .push { margin-left: auto; }
  .on { background: var(--surface); color: var(--bright); }
  .armed { background: var(--warn); color: var(--bg); font-weight: 700; }
  .warn { color: var(--warn); }
  .sock { color: var(--warn); }
  i { display: inline-block; width: 7px; height: 7px; border-radius: var(--radius); background: var(--sell); margin-right: 5px; }
  i.ok { background: var(--buy); }
  @media (max-width: 900px) {
    .line { gap: 2px 4px; padding: 2px 8px; }
    .market-stats { order: 1; flex: 0 0 100%; display: flex; flex-wrap: wrap; gap: 2px 8px; padding-bottom: 2px; }
    button { padding: 2px 4px; }
  }
</style>
