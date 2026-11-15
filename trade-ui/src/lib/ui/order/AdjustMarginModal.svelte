<script lang="ts">
  import { untrack } from 'svelte';
  import { positionOf } from '$lib/account/inventory.svelte';
  import { assetData } from '$lib/account/assetData.svelte';
  import { asset, dexOf, maintenance, quoteOf } from '$lib/market/meta.svelte';
  import { market } from '$lib/market/market.svelte';
  import { socket } from '$lib/transport/ws.svelte';
  import { viewAddress } from '$lib/session/session.svelte';
  import { adjustMargin } from '$lib/orders/execute';
  import { fmtPx, fmtUsd } from '$lib/util/format';
  import { ui } from '$lib/ui/state.svelte';
  import Coin from '../Coin.svelte';

  const STRICT = 'Strict isolated: margin cannot be removed, it is released as the position closes.';
  const props: { coin: string } = $props();
  const coin = untrack(() => props.coin);
  const a = asset(coin);
  const strict = a.marginMode === 'strictIsolated';
  const p = $derived(positionOf(coin));
  let tab = $state<'add' | 'remove'>('add');
  let amount = $state('');
  let busy = $state(false);
  let own = $state<number[] | null>(null);

  const close = () => (ui.overlay = null);
  $effect(() => {
    if (!p || p.szi === 0 || p.leverage.type !== 'isolated') close();
  });
  // The page's own activeAssetData feed covers only the selected coin.
  $effect(() => {
    const user = viewAddress();
    if (!user || coin === market.coin) return;
    return socket.subscribe({ type: 'activeAssetData', user, coin }, (d) => void (Array.isArray(d?.availableToTrade) && (own = d.availableToTrade.map(Number))));
  });

  const cents = (x: number) => Math.max(0, Math.floor(x * 100 + 1e-6) / 100);
  const side = $derived(p && p.szi > 0 ? 0 : 1);
  const avail = $derived(coin === assetData.coin ? assetData.availableToTrade[side] : (own?.[side] ?? null));
  // HL's transfer requirement: the position keeps max(initial margin, 10% of its value).
  const keep = $derived(p ? Math.max(p.positionValue / p.leverage.value, 0.1 * p.positionValue) : 0);
  const max = $derived(tab === 'add' ? (avail === null ? null : cents(avail)) : cents((p?.marginUsed ?? 0) - keep));
  const n = $derived(Number(amount));
  const next = $derived(n > 0 && p ? p.marginUsed + (tab === 'add' ? n : -n) : null);
  const error = $derived(
    tab === 'remove' && strict ? STRICT : max === null ? 'Available to trade not loaded yet.' : n > max ? `More than the max ${fmtUsd(max)}.` : ''
  );
  const liq = $derived.by(() => {
    if (!p?.liqPx) return null;
    const delta = n > 0 ? (tab === 'add' ? n : -n) : 0;
    const r = maintenance(a, p.positionValue).rate;
    // Isolated liq: margin + szi × (px − mark) = |szi| × px × rate − deduction, so each $ moves it by 1 / (|szi| × (side − rate)).
    return p.liqPx - delta / (Math.abs(p.szi) * (Math.sign(p.szi) - r));
  });
  const px = (x: number | null) => (x && x > 0 ? fmtPx(x, a.szDecimals) : '—');

  function pick(e: MouseEvent, t: 'add' | 'remove') {
    (e.currentTarget as HTMLElement).blur();
    tab = t;
    amount = '';
  }
  async function confirm(e: MouseEvent) {
    (e.currentTarget as HTMLElement).blur();
    if (!p) return;
    busy = true;
    try {
      await adjustMargin(coin, p.szi > 0, tab === 'add' ? n : -n);
      close();
    } catch {
      busy = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-label="Adjust Margin" data-testid="margin-adjust-modal">
  <button class="x" aria-label="Close" onclick={close}>✕</button>
  <h3>Adjust Margin</h3>
  <p class="dim">Decrease the chance of liquidation by adding margin, or remove excess margin to use elsewhere.</p>
  <div class="tabs">
    <button aria-pressed={tab === 'add'} data-testid="margin-tab-add" onclick={(e) => pick(e, 'add')}>Add</button>
    <button aria-pressed={tab === 'remove'} data-testid="margin-tab-remove" disabled={strict} title={strict ? STRICT : undefined} onclick={(e) => pick(e, 'remove')}>Remove</button>
  </div>
  {#if strict}<p class="dim" data-testid="margin-strict-note">{STRICT}</p>{/if}
  <div class="hero">
    <span class="dim">Margin</span>
    <div class="big"><span data-testid="margin-current">{fmtUsd(p?.marginUsed ?? NaN)}</span>{#if next !== null}<span class="arrow">→</span><span class:up={tab === 'add'} class:down={tab === 'remove'} data-testid="margin-next">{fmtUsd(next)}</span>{/if}</div>
    <div class="liq"><span class="dim">Est. liq. price</span> <span data-testid="margin-liq">{px(p?.liqPx ?? null)} → {px(liq)}</span></div>
  </div>
  <label class="ui-field box">
    <input inputmode="decimal" placeholder="Amount" aria-label="amount" data-testid="margin-amount" bind:value={amount} />
    <span class="dim">USDC</span>
    <button class="max" data-testid="margin-max" disabled={max === null} onclick={() => (amount = max!.toFixed(2))}>Max</button>
  </label>
  <div class="rows">
    <div><span>Position</span><span><Coin {coin} quote={dexOf(coin) ? quoteOf(coin) : 'USD'} /></span></div>
    <div>
      <span title={tab === 'add' ? 'Available to trade on this side' : 'Margin less max(value ÷ leverage, 10% of value), which HL keeps in the position'}>
        Max {tab === 'add' ? 'to add' : 'to remove'}
      </span>
      <span data-testid="margin-max-value">{max === null ? '—' : fmtUsd(max)}</span>
    </div>
  </div>
  {#if error}<p class="err" data-testid="margin-adjust-error">{error}</p>{/if}
  <button class="confirm" data-testid="margin-adjust-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : error || 'Enter a positive margin amount to confirm.'} disabled={busy || !!error || !(Math.round(n * 1e6) > 0)} onclick={confirm}>{busy ? '…' : 'Confirm'}</button>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(440px, calc(100vw - 32px)); padding: 24px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius);
  }
  .x { position: absolute; top: 14px; right: 14px; padding: 4px; background: none; color: var(--dim); font-size: var(--fs); line-height: 1; }
  .x:hover { color: var(--bright); }
  h3 { margin: 0 0 4px; font-size: calc(var(--fs) * 1.667); font-weight: 400; color: var(--bright); text-align: center; }
  p { margin: 0; text-align: center; }
  .err { color: var(--sell); }
  .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 3px; border-radius: var(--radius); background: var(--surface); }
  .tabs button { background: none; color: var(--dim); border-radius: var(--radius); padding: 6px; }
  .tabs button[aria-pressed='true'] { background: var(--panel); color: var(--bright); }
  .tabs button:disabled { opacity: 0.45; cursor: not-allowed; }
  .box { display: flex; align-items: center; gap: 8px; height: var(--ctl); padding: 0 10px; }
  .box input { flex: 1; min-width: 0; padding: 0; border: 0; outline: none; background: none; color: var(--bright); font-variant-numeric: tabular-nums; }
  .max { background: none; color: var(--accent); padding: 0 2px; }
  .hero { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px 12px; border-radius: var(--radius); background: var(--surface); font-variant-numeric: tabular-nums; }
  .hero > .dim { font-size: max(8px, calc(var(--fs) * 0.917)); }
  .big { display: flex; align-items: baseline; gap: 10px; font-size: calc(var(--fs) * 1.833); color: var(--bright); }
  .arrow { color: var(--dim); font-size: calc(var(--fs) * 1.25); }
  .up { color: var(--buy); }
  .down { color: var(--sell); }
  .liq { color: var(--text); }
  .rows { display: flex; flex-direction: column; gap: 4px; font-size: max(8px, calc(var(--fs) * 0.917)); color: var(--dim); }
  .rows div { display: flex; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
  .confirm { height: calc(var(--fs) * 3.333); border-radius: var(--radius); background: var(--accent); color: var(--bg); }
</style>
