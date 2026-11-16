<script lang="ts">
  import { untrack } from 'svelte';
  import { isTouch } from '$lib/ui/touch';
  import { positionOf } from '$lib/account/inventory.svelte';
  import type { Retracement } from '$lib/exchange/actions';
  import { asset, quoteOf, symOf } from '$lib/market/meta.svelte';
  import { placeTrailing } from '$lib/orders/execute';
  import { markOf } from '$lib/orders/size';
  import { closing } from '$lib/orders/ticket.svelte';
  import { viewAddress } from '$lib/session/session.svelte';
  import { MIN_NOTIONAL, cutDecimals, cutPx, maxDecimals, priceDecimals, roundPx, roundSz } from '$lib/signing/wire';
  import { net } from '$lib/transport/network';
  import { fmtPx, fmtSz, fmtUsd } from '$lib/util/format';
  import { ARMING, arming, ui } from '$lib/ui/state.svelte';
  import { toast } from '$lib/ui/toast.svelte';
  import Coin from '../Coin.svelte';
  import Field from './Field.svelte';

  const props: { coin: string } = $props();
  const coin = untrack(() => props.coin);
  const t = asset(coin);
  const d = t.szDecimals;
  const quote = quoteOf(coin);
  const opened = untrack(() => positionOf(coin)?.szi ?? 0);
  const owner = untrack(() => viewAddress());
  const network = untrack(() => net.current);
  const long = opened > 0;
  const p = $derived(positionOf(coin));
  const szi = $derived(p?.szi ?? 0);
  const held = $derived(Math.abs(szi));
  const mark = $derived.by(() => { try { return markOf(coin); } catch { return NaN; } });
  let unit = $state<'pct' | 'px'>('pct');
  let retraceText = $state('');
  let activationText = $state('');
  let pct = $state(100);
  let busy = $state(false);
  const arm = arming();

  const close = () => { if (!busy) ui.overlay = null; };
  $effect(() => {
    if (Math.sign(szi) !== Math.sign(opened) || viewAddress() !== owner || net.current !== network) close();
  });

  const finite = (text: string) => ((v) => (Number.isFinite(v) ? v : NaN))(Number(text));
  const sz = $derived(pct === 100 ? held : roundSz((held * pct) / 100, d));
  const amount = $derived(!(mark > 0) ? NaN : Number(finite(retraceText).toFixed(unit === 'pct' ? 2 : priceDecimals(mark, t))));
  const retracement = $derived<Retracement>(unit === 'pct' ? { pct: amount } : { px: amount });
  const typedActivation = $derived(finite(activationText));
  const activation = $derived(!activationText.trim() ? null : typedActivation > 0 ? roundPx(typedActivation, t, !long) : NaN);
  const distance = $derived(unit === 'pct' ? `${amount}%` : `${amount} ${quote}`);
  const error = $derived(
    !(mark > 0) ? 'No mark price yet.'
    : !(amount > 0) ? 'Enter a retracement above 0.'
    : unit === 'pct' && amount >= 100 ? 'Retracement must be under 100%.'
    : unit === 'px' && long && amount >= mark ? `Retracement must be under the ${fmtPx(mark, d)} mark.`
    : activation !== null && !(activation > 0) ? 'Enter a valid activation price, or leave it empty.'
    : activation !== null && (long ? activation <= mark : activation >= mark) ? `Activation must be ${long ? 'above' : 'below'} the ${fmtPx(mark, d)} mark.`
    : !(sz > 0) ? `Size rounds to 0 at ${d} decimals.`
    : sz < held && sz * mark < MIN_NOTIONAL ? `Below HL's $${MIN_NOTIONAL} minimum: ${fmtUsd(sz * mark)}.`
    : ''
  );

  function setUnit(e: MouseEvent, u: 'pct' | 'px') {
    (e.currentTarget as HTMLElement).blur();
    if (u !== unit) (unit = u), (retraceText = '');
  }

  async function confirm() {
    if (error || busy || !arm.on) return;
    busy = true;
    closing.n++;
    try {
      await placeTrailing(coin, szi, sz, retracement, activation);
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
    if (!isTouch()) document.querySelector<HTMLInputElement>('[data-testid="trailing-retracement"]')?.focus();
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });
  const help = $derived(`${activation !== null ? `When the mark price reaches ${activation}, the Trailing Stop order will be activated, and once it retraces by ${distance} from the best price recorded since activation, a Stop Market Order will be placed.` : `When the mark price retraces by ${distance} from the best price recorded since activation, a Stop Market Order will be placed.`} Reduce-only. Size added later is not covered. Liq. price: ${p?.liqPx ? fmtPx(p.liqPx, d) : '—'}.`);
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-label="Trailing Stop" data-testid="trailing-modal">
  <button class="x" aria-label="Close" disabled={busy} onclick={close}>✕</button>
  <h3 data-testid="trailing-title">Trailing Stop · <Coin {coin} /> <span class:buy={long} class:sell={!long}>{long ? 'long' : 'short'}</span> {fmtSz(held, d)}</h3>
  <Field label="Retracement" bind:value={retraceText} cut={(v) => cutDecimals(v, unit === 'pct' ? 2 : mark > 0 ? priceDecimals(mark, t) : maxDecimals(t))} testid="trailing-retracement" placeholder="0">
    {#snippet suffix()}
      <button class="pick" aria-pressed={unit === 'pct'} data-testid="trailing-unit-pct" onclick={(e) => setUnit(e, 'pct')}>%</button>
      <button class="pick" aria-pressed={unit === 'px'} data-testid="trailing-unit-px" onclick={(e) => setUnit(e, 'px')}>{quote}</button>
    {/snippet}
  </Field>
  {#if unit === 'pct'}
    <div class="chips two">
      {#each [5, 10] as v (v)}
        <button aria-pressed={amount === v} data-testid="trailing-chip-{v}" onclick={(e) => ((e.currentTarget as HTMLElement).blur(), (retraceText = String(v)))}>{v}%</button>
      {/each}
    </div>
  {/if}
  <Field label="Activation price (optional)" short="Activation" bind:value={activationText} cut={(v) => cutPx(v, t)} testid="trailing-activation" placeholder="At once" />
  <div class="chips">
    {#each [25, 50, 75, 100] as v (v)}
      <button aria-pressed={pct === v} data-testid="trailing-size-{v}" onclick={(e) => ((e.currentTarget as HTMLElement).blur(), (pct = v))}>{v}%</button>
    {/each}
  </div>
  <div class="rows">
    <div><abbr class="dim" data-testid="trailing-help" title={help}>Covers</abbr><span data-testid="trailing-covers">{fmtSz(sz, d)} of {fmtSz(held, d)} {symOf(coin)}</span></div>
    {#if activation !== null}<p class="warn" data-testid="trailing-pending"><abbr title="Price can move away and never reach it, and this order will not protect you.">No stop until activation</abbr></p>{/if}
  </div>
  {#if error}<p class="err" data-testid="trailing-error">{error}</p>{/if}
  <p data-testid="trailing-summary">Trailing Stop · <span class:buy={!long} class:sell={long}>{long ? 'Sell' : 'Buy'}</span> {sz} {symOf(coin)} reduce-only</p>
  <div class="actions">
    <button data-testid="trailing-cancel" disabled={busy} onclick={close}>Cancel</button>
    <button class="go" class:sell={long} data-testid="trailing-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : error || (arm.on ? '' : ARMING)} disabled={busy || !!error || !arm.on} onclick={(e) => ((e.currentTarget as HTMLElement).blur(), confirm())}>{busy ? 'Sending…' : 'Confirm'}</button>
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
  .pick { background: none; color: var(--dim); padding: 0 4px; }
  .pick[aria-pressed='true'] { color: var(--accent); }
  .chips { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .chips.two { grid-template-columns: repeat(2, 1fr); }
  .chips button { padding: 4px 0; border: 1px solid var(--surface); border-radius: var(--radius); background: none; color: var(--dim); }
  .chips button[aria-pressed='true'] { background: var(--surface); color: var(--bright); }
  .rows { display: flex; flex-direction: column; gap: 6px; }
  .rows div { display: flex; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .actions button { height: var(--ctl); padding: 0 16px; border-radius: var(--radius); background: var(--surface); color: var(--bright); }
  .actions .go { background: var(--buy); color: var(--bg); }
  .actions .go.sell { background: var(--sell); }
  .actions .go:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
