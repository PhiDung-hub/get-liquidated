<script lang="ts">
  import { market } from '$lib/market/market.svelte';
  import { asset, dexOf, isolatedOnly, quoteOf } from '$lib/market/meta.svelte';
  import Coin from '../Coin.svelte';
  import { assetData } from '$lib/account/assetData.svelte';
  import { positionOf } from '$lib/account/inventory.svelte';
  import { setLeverage } from '$lib/orders/execute';
  import { ui } from '$lib/ui/state.svelte';

  const MODES = [
    {
      cross: true, id: 'margin-cross', label: 'Cross',
      text: 'All cross positions share the same cross margin as collateral. In the event of liquidation, your cross margin balance and any remaining open positions under this mode may be forfeited.'
    },
    {
      cross: false, id: 'margin-isolated', label: 'Isolated',
      text: 'Manage your risk on individual positions by restricting the amount of margin allocated to each. If the margin ratio of an isolated position reaches 100%, the position will be liquidated. Margin can be added or removed to individual positions in this mode.'
    }
  ];

  const coin = market.coin;
  const a = asset(coin);
  const locked = isolatedOnly(a);
  let cross = $state(!locked);
  let busy = $state(false);
  // A mode switch resends the current leverage, so it waits for the real value instead of a default.
  const cur = $derived(assetData.coin === coin ? assetData.leverage : null);
  // Hyperliquid refuses a mode change while the position is open.
  const open = $derived(!!positionOf(coin)?.szi);
  let seeded = false;
  $effect(() => {
    if (seeded || !cur) return;
    seeded = true;
    cross = !locked && cur.type === 'cross';
  });

  const close = () => (ui.overlay = null);
  function pick(e: MouseEvent, isCross: boolean) {
    (e.currentTarget as HTMLElement).blur();
    cross = isCross;
  }

  async function confirm(e: MouseEvent) {
    (e.currentTarget as HTMLElement).blur();
    if (!cur) return;
    busy = true;
    try {
      await setLeverage(coin, cross, Math.min(cur.value, a.maxLeverage));
      close();
    } catch {
      busy = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-label="Margin Mode" data-testid="margin-modal">
  <button class="x" aria-label="Close" onclick={close}>✕</button>
  <h3><Coin {coin} quote={dexOf(coin) ? quoteOf(coin) : 'USD'} /> Margin Mode</h3>
  {#each MODES as m (m.id)}
    <button class="card" aria-pressed={cross === m.cross} data-testid={m.id} disabled={m.cross && locked} onclick={(e) => pick(e, m.cross)}>
      <span class="label"><span class="check" class:on={cross === m.cross}></span>{!m.cross && a.marginMode === 'strictIsolated' ? 'Isolated (locked)' : m.label}</span>
      <span class="dim">{m.text}</span>
    </button>
  {/each}
  {#if !cur}<p class="dim">Current leverage not loaded yet.</p>{:else if open}<p class="dim" data-testid="margin-open">Close your {coin} position to change its margin mode.</p>{/if}
  <button class="confirm" data-testid="margin-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : !cur ? 'Current leverage is not loaded yet.' : open ? 'Close your position before changing margin mode.' : 'Choose a different margin mode to confirm.'} disabled={busy || !cur || open || cross === (cur.type === 'cross')} onclick={confirm}>{busy ? '…' : 'Confirm'}</button>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(520px, calc(100vw - 32px)); padding: 24px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius);
  }
  .x { position: absolute; top: 14px; right: 14px; padding: 4px; background: none; color: var(--dim); font-size: var(--fs); line-height: 1; }
  .x:hover { color: var(--bright); }
  h3 { margin: 0 28px 12px; overflow-wrap: anywhere; font-size: calc(var(--fs) * 1.667); font-weight: 400; color: var(--bright); text-align: center; }
  p { margin: 0; text-align: center; }
  .card { display: flex; flex-direction: column; gap: 8px; padding: 12px; text-align: left; background: none; border: 1px solid var(--surface); border-radius: var(--radius); line-height: 1.25; }
  .label { display: flex; align-items: center; gap: 8px; font-size: calc(var(--fs) * 1.167); color: var(--bright); }
  .check { display: inline-grid; place-items: center; width: 16px; height: 16px; border: 1px solid var(--faint); border-radius: var(--radius); }
  .check.on { border-color: var(--accent); }
  .check.on::after { content: ''; width: 8px; height: 8px; border-radius: var(--radius); background: var(--accent); }
  .confirm { height: calc(var(--fs) * 3.333); margin-top: 4px; border-radius: var(--radius); background: var(--accent); color: var(--bg); }
</style>
