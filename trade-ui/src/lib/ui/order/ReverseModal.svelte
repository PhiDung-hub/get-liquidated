<script lang="ts">
  import { untrack } from 'svelte';
  import { feeFor } from '$lib/account/fees.svelte';
  import { assetData } from '$lib/account/assetData.svelte';
  import { markOf, positionOf } from '$lib/account/inventory.svelte';
  import { openOrders } from '$lib/account/orders.svelte';
  import { asset, meta, quoteOf, symOf } from '$lib/market/meta.svelte';
  import { watchBbo } from '$lib/market/book.svelte';
  import { reversePosition } from '$lib/orders/execute';
  import { closing } from '$lib/orders/ticket.svelte';
  import { settings } from '$lib/settings/settings.svelte';
  import { viewAddress } from '$lib/session/session.svelte';
  import { MIN_NOTIONAL, roundSz } from '$lib/signing/wire';
  import { net } from '$lib/transport/network';
  import { fmtSz, fmtUsd } from '$lib/util/format';
  import { ARMING, arming, ui } from '$lib/ui/state.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import Coin from '../Coin.svelte';

  const props: { coin: string } = $props();
  const coin = untrack(() => props.coin);
  const d = asset(coin).szDecimals;
  const opened = untrack(() => positionOf(coin)?.szi ?? 0);
  const owner = untrack(() => viewAddress());
  const network = untrack(() => net.current);
  const p = $derived(positionOf(coin));
  const szi = $derived(p?.szi ?? 0);
  const long = $derived(szi > 0);
  const held = $derived(Math.abs(szi));
  const sz = $derived(roundSz(2 * held, d));
  const px = $derived(p ? markOf(p) : NaN);
  const orders = $derived(openOrders.list.filter((o) => o.coin === coin).length);
  const short = $derived(assetData.coin === coin && sz > assetData.maxTradeSzs[long ? 1 : 0]);
  const error = $derived(
    !(px > 0) ? 'No mark price yet.'
    : sz * px < MIN_NOTIONAL ? `Below HL's $${MIN_NOTIONAL} minimum: ${fmtUsd(sz * px)}.`
    : meta.capped.has(coin) ? `${coin} is at its open-interest cap: HL refuses a flip.`
    : ''
  );
  let top = $state({ bid: 0, ask: 0, at: 0 });
  let busy = $state(false);
  const arm = arming();

  const close = () => { if (!busy) ui.overlay = null; };
  $effect(() => {
    if (Math.sign(szi) !== Math.sign(opened) || viewAddress() !== owner || net.current !== network) close();
  });
  $effect(() => untrack(() => watchBbo(coin, (b) => (top = { bid: b.bid, ask: b.ask, at: Date.now() }))));
  const fresh = () => (top.bid > 0 && top.ask > 0 && Date.now() - top.at < 3000 ? (long ? top.bid : top.ask) : undefined);

  async function confirm() {
    if (error || busy || !arm.on) return;
    busy = true;
    closing.n++;
    try {
      await reversePosition(coin, szi, fresh());
      ui.overlay = null;
    } catch (e) {
      toast.error((e as Error).message);
      busy = false;
    } finally {
      closing.n--;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.repeat) return;
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
    if (e.code !== 'Escape' && !(enter && !(e.target instanceof HTMLButtonElement))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') close();
    else void confirm();
  }
  $effect(() => {
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });
  const help = $derived(`Close your position and open a position with the same size in the opposite direction. Max slippage ${(settings.market.slippage * 100).toFixed(2)}%. Est. taker fee: ${sz * px > 0 ? `${(sz * px * feeFor(coin).taker).toFixed(4)} ${quoteOf(coin)}` : '—'}.`);
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-label="Reverse Position" data-testid="reverse-modal">
  <button class="x" aria-label="Close" disabled={busy} onclick={close}>✕</button>
  <h3 data-testid="reverse-title">Reverse Position · <Coin {coin} /> <span class:buy={long} class:sell={!long}>{long ? 'long' : 'short'}</span> {fmtSz(held, d)}</h3>
  <div class="rows">
    <div><abbr class="dim" data-testid="reverse-help" title={help}>Ending position</abbr><span class:buy={!long} class:sell={long}>{long ? 'short' : 'long'} {fmtSz(sz - held, d)}</span></div>
  </div>
  {#if orders}<p class="warn" data-testid="reverse-exits">{orders} open {orders === 1 ? 'order stays' : 'orders stay'} after the flip: set your exits again.</p>{/if}
  {#if short}<p class="warn" data-testid="reverse-margin">{sz} {symOf(coin)} is more than the margin may allow: HL can refuse it.</p>{/if}
  {#if error}<p class="err" data-testid="reverse-error">{error}</p>{/if}
  <p data-testid="reverse-summary">Reverse · <span class:buy={!long} class:sell={long}>{long ? 'Sell' : 'Buy'}</span> {sz} {symOf(coin)} at market</p>
  <div class="actions">
    <button data-testid="reverse-cancel" disabled={busy} onclick={close}>Cancel</button>
    <button class="go" class:sell={long} data-testid="reverse-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : error || (arm.on ? '' : ARMING)} disabled={busy || !!error || !arm.on} onclick={(e) => ((e.currentTarget as HTMLElement).blur(), confirm())}>{busy ? 'Sending…' : 'Confirm'}</button>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #0008; z-index: 20; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(440px, calc(100vw - 32px)); padding: 24px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius);
  }
  .x { position: absolute; top: 14px; right: 14px; padding: 4px; background: none; color: var(--dim); font-size: var(--fs); line-height: 1; }
  .x:hover { color: var(--bright); }
  h3 { margin: 0 24px 4px 0; font-size: calc(var(--fs) * 1.333); font-weight: 400; color: var(--bright); }
  p { margin: 0; }
  .dim { color: var(--dim); }
  .err { color: var(--sell); }
  .warn { color: var(--warn); }
  .rows { display: flex; flex-direction: column; gap: 6px; }
  .rows div { display: flex; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .actions button { height: var(--ctl); padding: 0 16px; border-radius: var(--radius); background: var(--surface); color: var(--bright); }
  .actions .go { background: var(--buy); color: var(--bg); }
  .actions .go.sell { background: var(--sell); }
  .actions .go:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
