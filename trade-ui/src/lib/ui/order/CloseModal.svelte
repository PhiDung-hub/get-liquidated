<script lang="ts">
  import { isTouch } from '$lib/ui/touch';
  import { feeFor } from '$lib/account/fees.svelte';
  import { quoteOf } from '$lib/market/meta.svelte';
  import { untrack } from 'svelte';
  import { markOf, positionOf } from '$lib/account/inventory.svelte';
  import { asset, symOf } from '$lib/market/meta.svelte';
  import { bbo, watchBbo } from '$lib/market/book.svelte';
  import { market } from '$lib/market/market.svelte';
  import { closePart } from '$lib/orders/execute';
  import type { Tif } from '$lib/exchange/actions';
  import { MIN_NOTIONAL, cutPx, cutSz, roundPx, roundSz } from '$lib/signing/wire';
  import { fmtSz, fmtUsd } from '$lib/util/format';
  import { toast } from '$lib/ui/toast.svelte';
  import { ARMING, arming, ui } from '$lib/ui/state.svelte';
  import { closing } from '$lib/orders/ticket.svelte';
  import Coin from '../Coin.svelte';
  import Field from './Field.svelte';
  import SizeSlider from './SizeSlider.svelte';
  import Menu, { menus } from './Menu.svelte';

  const props: { coin: string; limit: boolean } = $props();
  const { coin, limit } = untrack(() => ({ ...props }));
  const t = asset(coin);
  const d = t.szDecimals;
  const p = $derived(positionOf(coin));
  const held = $derived(Math.abs(p?.szi ?? 0));
  const long = $derived((p?.szi ?? 0) > 0);
  let sizeText = $state(String(roundSz(Math.abs(positionOf(coin)?.szi ?? 0), d)));
  let pct = $state(100);
  const initialTop = untrack(() => coin === market.coin ? { bid: bbo.bid, ask: bbo.ask, at: bbo.seen } : { bid: 0, ask: 0, at: 0 });
  let pxText = $state(limit && initialTop.bid > 0 && initialTop.ask > 0 ? String(roundPx((initialTop.bid + initialTop.ask) / 2, t, (positionOf(coin)?.szi ?? 0) < 0)) : '');
  let tif = $state<Tif>('Gtc');
  const tifs = [
    { value: 'Gtc', label: 'GTC', testid: 'close-tif-gtc', description: 'Good till cancelled. Unfilled quantity stays open until filled or cancelled.' },
    { value: 'Alo', label: 'ALO', testid: 'close-tif-alo', description: 'Add liquidity only. Post-only: cancelled if it would execute immediately.' },
    { value: 'Ioc', label: 'IOC', testid: 'close-tif-ioc', description: 'Immediate or cancel. Cancels any quantity that cannot fill immediately.' }
  ];
  let top = $state(initialTop);
  let busy = $state(false);
  const arm = arming();

  const close = () => { if (!busy) ui.overlay = null; };
  $effect(() => {
    if (!p || p.szi === 0) close();
  });
  // A close buys back a short: the mid rounds toward the close's own side, so it never crosses.
  const mid = () => roundPx((top.bid + top.ask) / 2, t, !long);
  const best = () => (long ? top.ask : top.bid);
  $effect(() =>
    untrack(() =>
      watchBbo(coin, (b) => {
        const first = !(top.bid > 0 && top.ask > 0);
        top = { bid: b.bid, ask: b.ask, at: Date.now() };
        if (limit && first && !pxText && b.bid > 0 && b.ask > 0) pxText = String(mid());
      })
    )
  );
  // HL pushes a bbo only when it changes: a quiet book leaves the market close to an allMids read.
  const fresh = () => (top.bid > 0 && top.ask > 0 && Date.now() - top.at < 3000 ? (long ? top.bid : top.ask) : undefined);

  const typed = $derived(Number(sizeText));
  const sz = $derived(roundSz(typed || 0, d));
  const typedPx = $derived(Number(pxText));
  const px = $derived(limit ? (typedPx > 0 ? roundPx(typedPx, t, !long) : NaN) : p ? markOf(p) : NaN);
  const error = $derived(
    !(typed > 0) ? 'Enter a size.'
    : !(sz > 0) ? `Size rounds to 0 at ${d} decimals.`
    : typed > held + 1e-12 ? `More than the ${fmtSz(held, d)} position.`
    : !(px > 0) ? (limit ? 'Enter a price.' : 'No mark price yet.')
    : sz < held && sz * px < MIN_NOTIONAL ? `Below HL's $${MIN_NOTIONAL} minimum: ${fmtUsd(sz * px)}.`
    : ''
  );
  const pnl = $derived(p && px > 0 ? sz * (px - p.entryPx) * (long ? 1 : -1) : NaN);

  const makerOnly = $derived(limit && tif === 'Alo');
  const closeFee = $derived(sz > 0 && px > 0 ? sz * px * (makerOnly ? feeFor(coin).maker : feeFor(coin).taker) : NaN);
  const setPct = (v: number) => ((pct = v), (sizeText = String(roundSz((held * v) / 100, d))));
  const syncPct = (e: Event) => (e.target as HTMLElement).dataset.testid === 'close-size' && (pct = held ? Math.min(100, Math.round((typed / held) * 100)) : 0);
  const setPx = (f: () => number) => (e: MouseEvent) => {
    (e.currentTarget as HTMLElement).blur();
    if (top.bid > 0 && top.ask > 0) pxText = String(f());
    else toast.error(`no ${coin} book yet`);
  };

  async function confirm() {
    if (error || busy || !arm.on) return;
    busy = true;
    closing.n++;
    try {
      await closePart(coin, sz, limit ? px : undefined, limit ? undefined : fresh(), undefined, tif);
      ui.overlay = null;
    } catch (e) {
      toast.error((e as Error).message);
      busy = false;
    } finally {
      closing.n--;
    }
  }

  // Capture phase, ahead of the hotkey dispatcher: Enter confirms and Esc cancels from any field; a focused button keeps its own Enter.
  // A held Enter that opened the modal from a row's button auto-repeats into the size field, so repeats never confirm.
  function onKey(e: KeyboardEvent) {
    if (e.repeat || menus.open) return;
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
    if (e.code !== 'Escape' && !(enter && !(e.target instanceof HTMLButtonElement))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') close();
    else void confirm();
  }
  $effect(() => {
    // On touch, focusing would raise the keyboard over the confirm button.
    const el = isTouch() ? null : document.querySelector<HTMLInputElement>('[data-testid="close-size"]');
    el?.focus();
    el?.select();
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });
  const help = $derived(`Closed size × (${limit ? 'price' : 'mark'} − entry), before fees. Closing fee (${makerOnly ? 'maker' : 'taker estimate'}): ${Number.isFinite(closeFee) ? `${closeFee.toFixed(4)} ${quoteOf(coin)}` : '—'}. After the fee: ${fmtUsd(pnl - closeFee)}. Fees use current rates; funding and slippage are excluded.${makerOnly ? ' Maker only (ALO), reduce-only: HL refuses a price that would fill at once.' : limit ? ` ${tif.toUpperCase()}, reduce-only. ${tif === 'Gtc' ? 'Unfilled quantity stays open; an immediate fill pays taker fees.' : 'Unfilled quantity is cancelled.'}` : ''}`);
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-label="{limit ? 'Limit' : 'Market'} Close" data-testid="close-modal" data-kind={limit ? 'limit' : 'market'} oninput={syncPct}>
  <button class="x" aria-label="Close" disabled={busy} onclick={close}>✕</button>
  <h3 data-testid="close-title">{limit ? 'Limit' : 'Market'} Close · <Coin {coin} /> <span class:buy={long} class:sell={!long}>{long ? 'long' : 'short'}</span> {fmtSz(held, d)}</h3>
  {#if limit}
    <Field label="Price" bind:value={pxText} cut={(v) => cutPx(v, t)} testid="close-price" placeholder="0">
      {#snippet suffix()}
        <button class="pick" data-testid="close-mid" onclick={setPx(mid)}>Mid</button>
        {#if tif === 'Alo'}<button class="pick" data-testid="close-best" title="Best maker price: the {long ? 'ask' : 'bid'}" onclick={setPx(best)}>Best</button>{/if}
        <span class="tif" title="Time in force"><Menu testid="close-tif" ariaLabel="Close order time in force" value={tif} options={tifs} onpick={(v) => tif = v as Tif} dropdown /></span>
      {/snippet}
    </Field>
  {/if}
  <Field label="Size" bind:value={sizeText} cut={(v) => cutSz(v, d)} testid="close-size" placeholder="0">
    {#snippet suffix()}{symOf(coin)}{/snippet}
  </Field>
  <SizeSlider id="close" bind:pct onpct={setPct} />
  <div class="chips">
    {#each [25, 50, 75, 100] as v (v)}
      <button aria-pressed={pct === v} data-testid="close-chip-{v}" onclick={(e) => ((e.currentTarget as HTMLElement).blur(), setPct(v))}>{v}%</button>
    {/each}
  </div>
  <div class="rows">
    <p data-testid="close-summary">Close · <span class:buy={!long} class:sell={long}>{long ? 'Sell' : 'Buy'}</span> {sz} {symOf(coin)}{limit ? (px > 0 ? ` at ${px}` : '') : ' at market'}</p>
    <span class="est"><abbr class="dim" data-testid="close-help" title={help}>PnL</abbr> <span data-testid="close-pnl" class:buy={pnl > 0} class:sell={pnl < 0}>{fmtUsd(pnl)}</span></span>
  </div>
  {#if error}<p class="err" data-testid="close-error">{error}</p>{/if}
  <div class="actions">
    <button data-testid="close-cancel" disabled={busy} onclick={close}>Cancel</button>
    <button class="go" class:sell={long} data-testid="close-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : error || (arm.on ? '' : ARMING)} disabled={busy || !!error || !arm.on} onclick={(e) => ((e.currentTarget as HTMLElement).blur(), confirm())}>{busy ? 'Sending…' : 'Confirm'}</button>
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
  .pick { background: none; color: var(--accent); padding: 0 2px; }
  .tif { display: inline-flex; align-self: stretch; margin-left: 10px; color: var(--text); }
  .chips { display: grid; grid-template-columns: repeat(4, 1fr); }
  .chips button { min-height: 28px; padding: 0; background: none; color: var(--dim); }
  .chips button[aria-pressed='true'] { color: var(--accent); font-weight: 600; }
  .rows { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-variant-numeric: tabular-nums; }
  .est { white-space: nowrap; }
  @media (max-width: 900px), (pointer: coarse) and (max-height: 500px) {
    .modal[role='dialog'][data-sheet] { right: 0; bottom: var(--clear); left: 0; padding: 10px 0 8px; gap: 8px; border-width: 1px 0 0; border-radius: var(--radius) var(--radius) 0 0; }
    .modal > :global(:not(.ui-field, .x)) { padding-inline: 8px; }
    .modal > :global(.ui-field) { border-inline: 0; border-radius: 0; padding-inline: 8px; }
    .x { top: 6px; right: 4px; }
    h3 { margin: 0 40px 0 0; font-size: calc(var(--fs) * 1.143); line-height: 28px; }
    .chips button { min-height: 32px; }
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .actions button { height: var(--ctl); padding: 0 16px; border-radius: var(--radius); background: var(--surface); color: var(--bright); }
  .actions .go { background: var(--buy); color: var(--bg); }
  .actions .go.sell { background: var(--sell-action); }
  .actions .go:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
