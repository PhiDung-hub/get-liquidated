<script module lang="ts">
  import { chaseOwning } from '$lib/orders/chase.svelte';
  import { isTrailing, openOrders, type OpenOrder } from '$lib/account/orders.svelte';
  import { ui } from '$lib/ui/state.svelte';

  /** A resting GTC or ALO limit that no running chase owns. */
  export const editable = (o: OpenOrder) => !o.isTrigger && !isTrailing(o) && (o.tif === 'Gtc' || o.tif === 'Alo') && !(o.cloid && chaseOwning(o.coin, o.side === 'B', o.cloid));
  export function editOrder(o: OpenOrder) {
    ui.overlay = { kind: 'editOrder', oid: o.oid };
  }
</script>

<script lang="ts">
  import { isTouch } from '$lib/ui/touch';
  import { untrack } from 'svelte';
  import { positionOf } from '$lib/account/inventory.svelte';
  import { asset, symOf } from '$lib/market/meta.svelte';
  import { watchBbo } from '$lib/market/book.svelte';
  import { minLabel, moveOrder, quoteIn, spotGrowth } from '$lib/orders/execute';
  import { MIN_NOTIONAL, cutPx, cutSz, roundPx, roundSz } from '$lib/signing/wire';
  import { fmtIn, fmtPx, fmtSz } from '$lib/util/format';
  import { toast } from '$lib/ui/toast.svelte';
  import Coin from '../Coin.svelte';
  import Field from './Field.svelte';

  const props: { order: OpenOrder } = $props();
  const first = untrack(() => props.order);
  const { coin } = first;
  const isBuy = first.side === 'B';
  const t = asset(coin);
  const d = t.szDecimals;
  const order = $derived(openOrders.list.find((o) => o.oid === first.oid));
  let pxText = $state(String(first.limitPx));
  let sizeText = $state(String(first.sz));
  let top = $state({ bid: 0, ask: 0 });
  let busy = $state(false);

  const close = () => (ui.overlay = null);
  $effect(() => {
    if (!order && !busy) close();
  });
  $effect(() => untrack(() => watchBbo(coin, (b) => (top = { bid: b.bid, ask: b.ask }))));

  const px = $derived(Number(pxText) > 0 ? roundPx(Number(pxText), t, isBuy) : NaN);
  const sz = $derived(roundSz(Number(sizeText) || 0, d));
  const held = $derived(Math.abs(positionOf(coin)?.szi ?? 0));
  const short = $derived(order ? spotGrowth(order, px, sz) : '');
  const error = $derived(
    !order ? 'The order has left the book.'
    : !(px > 0) ? 'Enter a price.'
    : !(Number(sizeText) > 0) ? 'Enter a size.'
    : !(sz > 0) ? `Size rounds to 0 at ${d} decimals.`
    : !(top.bid > 0 && top.ask > 0) ? `No ${coin} book yet.`
    : isBuy && px >= top.ask ? `A buy at or above the ask (${fmtPx(top.ask, d, t.spot)}) would fill.`
    : !isBuy && px <= top.bid ? `A sell at or below the bid (${fmtPx(top.bid, d, t.spot)}) would fill.`
    : order.reduceOnly && sz > held + 1e-12 ? `Reduce-only: more than the ${fmtSz(held, d)} position.`
    : !order.reduceOnly && sz * px < MIN_NOTIONAL ? `Below HL's ${minLabel(coin)} minimum: ${fmtIn(sz * px, quoteIn(coin))}.`
    : short ? short
    : px === order.limitPx && sz === order.sz ? 'No change.'
    : ''
  );

  async function confirm() {
    if (error || busy || !order) return;
    busy = true;
    try {
      if (await moveOrder(order, px, sz, top)) return close();
    } catch (e) {
      toast.error((e as Error).message);
    }
    busy = false;
  }

  // As in the close modal: capture phase, Enter confirms and Esc cancels from any field, a focused button keeps its Enter, and a held Enter never confirms.
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
    // On touch, focusing would raise the keyboard over the confirm button.
    const el = isTouch() ? null : document.querySelector<HTMLInputElement>('[data-testid="edit-price"]');
    el?.focus();
    el?.select();
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-label="Edit order" data-testid="edit-modal">
  <button class="x" aria-label="Close" onclick={close}>✕</button>
  <h3>Edit · <Coin {coin} /> <span class:buy={isBuy} class:sell={!isBuy}>{isBuy ? 'Buy' : 'Sell'}</span> <span class="dim">{first.tif}{first.reduceOnly ? ' · reduce-only' : ''}</span></h3>
  <Field label="Price" bind:value={pxText} cut={(v) => cutPx(v, t)} testid="edit-price" placeholder="0" />
  <Field label="Size" bind:value={sizeText} cut={(v) => cutSz(v, d)} testid="edit-size" placeholder="0">
    {#snippet suffix()}{symOf(coin)}{/snippet}
  </Field>
  <p class="dim">Was {fmtSz(first.sz, d)} at {fmtPx(first.limitPx, d, t.spot)}. Same side, TIF and reduce-only; one modify, nothing sent before Confirm.</p>
  {#if error}<p class="err" data-testid="edit-error">{error}</p>{/if}
  <p data-testid="edit-summary"><span class:buy={isBuy} class:sell={!isBuy}>{isBuy ? 'Buy' : 'Sell'}</span> {sz} {symOf(coin)}{px > 0 ? ` at ${px} · ${fmtIn(sz * px, quoteIn(coin))}` : ''}</p>
  <div class="actions">
    <button data-testid="edit-cancel" onclick={close}>Cancel</button>
    <button class="go" class:sell={!isBuy} data-testid="edit-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : error} disabled={busy || !!error} onclick={(e) => ((e.currentTarget as HTMLElement).blur(), confirm())}>{busy ? 'Sending…' : 'Confirm'}</button>
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
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .actions button { height: var(--ctl); padding: 0 16px; border-radius: var(--radius); background: var(--surface); color: var(--bright); }
  .actions .go { background: var(--buy); color: var(--bg); }
  .actions .go.sell { background: var(--sell); }
  .actions .go:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
