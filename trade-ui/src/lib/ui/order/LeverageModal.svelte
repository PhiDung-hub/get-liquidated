<script lang="ts">
  import { market } from '$lib/market/market.svelte';
  import { asset, isolatedOnly } from '$lib/market/meta.svelte';
  import { cutDecimals } from '$lib/signing/wire';
  import { assetData } from '$lib/account/assetData.svelte';
  import { setLeverage } from '$lib/orders/execute';
  import { ui } from '$lib/ui/state.svelte';

  const coin = market.coin;
  const a = asset(coin);
  let value = $state(Math.min(10, a.maxLeverage));
  const locked = isolatedOnly(a);
  let cross = $state(!locked);
  let busy = $state(false);
  // Until the current leverage is known, the defaults could raise an existing position's leverage.
  const ready = $derived(assetData.coin === coin && !!assetData.leverage);
  let seeded = false;
  $effect(() => {
    if (seeded || !ready) return;
    seeded = true;
    const cur = assetData.leverage!;
    [value, cross] = [Math.min(cur.value, a.maxLeverage), !locked && cur.type === 'cross'];
  });
  const fill = $derived(a.maxLeverage > 1 ? ((value - 1) / (a.maxLeverage - 1)) * 100 : 100);

  const close = () => (ui.overlay = null);
  const blur = (e: Event) => (e.currentTarget as HTMLElement).blur();
  // A press on selected page text starts a native drag of it, which cancels the thumb's drag.
  const unselect = () => getSelection()?.removeAllRanges();
  function typed(e: Event & { currentTarget: HTMLInputElement }) {
    // Leverage is whole: the cut keeps the "." of a typed 2.5 and drops the 5, so it never reads as 25×.
    const digits = (e.currentTarget.value = cutDecimals(e.currentTarget.value, 0));
    if (!(Number(digits) > 0)) return;
    value = Math.min(Math.max(Number(digits), 1), a.maxLeverage);
    // An unchanged clamped value would not re-render, so the out-of-range text is replaced here.
    if (value !== Number(digits)) e.currentTarget.value = String(value);
  }

  async function confirm(e: MouseEvent) {
    blur(e);
    busy = true;
    try {
      await setLeverage(coin, cross, value);
      close();
    } catch {
      busy = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-label="Adjust Leverage" data-testid="leverage-modal">
  <button class="x" aria-label="Close" onclick={close}>✕</button>
  <h3>Adjust Leverage</h3>
  <p>Control the leverage used for {coin} positions. The maximum leverage is {a.maxLeverage}x.</p>
  <p>Max position size decreases the higher your leverage.</p>
  <div class="pick">
    <input type="range" min="1" max={a.maxLeverage} step="1" bind:value aria-label="leverage" data-testid="leverage-slider" style:--fill="{fill}%" onpointerdown={unselect} onpointerup={blur} />
    <label class="ui-field box">
      <input inputmode="numeric" aria-label="leverage value" data-testid="leverage-input" required pattern="[0-9]+" {value} oninput={typed} onchange={(e) => (e.currentTarget.value = String(value))} />
      <span>x</span>
    </label>
  </div>
  {#if !ready}<p class="dim">Current leverage not loaded yet.</p>{/if}
  <button class="confirm" data-testid="leverage-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : 'Current leverage is not loaded yet.'} disabled={busy || !ready} onclick={confirm}>{busy ? '…' : 'Confirm'}</button>
  <hr />
  <p class="risk" data-testid="leverage-note">Note that setting a higher leverage increases the risk of liquidation.</p>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(520px, calc(100vw - 32px)); padding: 24px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius); text-align: center;
  }
  .x { position: absolute; top: 14px; right: 14px; padding: 4px; background: none; color: var(--dim); font-size: var(--fs); line-height: 1; }
  .x:hover { color: var(--bright); }
  h3 { margin: 0 0 4px; font-size: calc(var(--fs) * 1.667); font-weight: 400; color: var(--bright); }
  p { margin: 0; }
  .pick { display: grid; grid-template-columns: 1fr 58px; gap: 20px; align-items: center; margin: 12px 0; }
  input[type='range'] {
    appearance: none; -webkit-appearance: none; height: 20px; padding: 0; border: 0; cursor: pointer; touch-action: none;
    background: linear-gradient(color-mix(in srgb, var(--accent) 35%, var(--surface)) 0 0) 0 50% / var(--fill) 4px no-repeat, linear-gradient(var(--surface) 0 0) 0 50% / 100% 4px no-repeat;
  }
  input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: var(--radius); background: var(--panel); border: 2px solid var(--accent); }
  input[type='range']::-moz-range-thumb { width: 14px; height: 14px; border-radius: var(--radius); background: var(--panel); border: 2px solid var(--accent); }
  .box { display: flex; align-items: center; gap: 4px; height: var(--ctl); padding: 0 10px; }
  .box input { width: 100%; min-width: 0; padding: 0; border: 0; outline: none; background: none; color: var(--bright); text-align: center; font-variant-numeric: tabular-nums; }
  .confirm { height: calc(var(--fs) * 3.333); border-radius: var(--radius); background: var(--accent); color: var(--bg); }
  hr { width: 100%; margin: 0; border: 0; border-top: 1px solid var(--surface); }
  .risk { padding: 12px; border: 1px solid var(--sell); border-radius: var(--radius); color: var(--sell); background: color-mix(in srgb, var(--sell) 12%, transparent); }
  @media (max-width: 900px) {
    input[type='range'] { height: 32px; }
  }
</style>
