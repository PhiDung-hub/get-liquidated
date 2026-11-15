<script lang="ts">
  import { onMount } from 'svelte';
  import { ALL_INTERVALS, MS, ivLabel } from '$lib/market/candles';
  import { settings, persist } from '$lib/settings/settings.svelte';
  import { ui } from '../state.svelte';

  let input: HTMLInputElement;
  let value = $state(ui.intervalInput);
  let error = $state('');
  const units: Record<string, string> = { m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm', h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', d: 'd', day: 'd', days: 'd', w: 'w', week: 'w', weeks: 'w', mo: 'M', month: 'M', months: 'M' };
  const close = () => { ui.overlay = null; document.activeElement instanceof HTMLElement && document.activeElement.blur(); };
  const interval = $derived.by(() => {
    const match = /^(\d+)\s*([a-z]*)$/i.exec(value.trim());
    if (!match) return undefined;
    const n = Number(match[1]), unit = match[2] === 'M' ? 'M' : units[(match[2] || 'm').toLowerCase()];
    if (!unit) return undefined;
    const duration = n * ({ m: 6e4, h: 36e5, d: 864e5, w: 6048e5, M: 2592e6 }[unit] ?? 0);
    return ALL_INTERVALS.find((i) => MS[i] === duration);
  });
  const normalize = () => { if (interval) value = ivLabel(interval); };
  function confirm() {
    if (!interval) {
      error = `Choose a supported interval: ${ALL_INTERVALS.map(ivLabel).join(', ')}.`;
      input.focus();
      return;
    }
    settings.chart.interval = interval;
    persist();
    close();
  }
  onMount(() => { input.focus(); input.setSelectionRange(value.length, value.length); });
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Change interval" data-testid="interval-picker">
  <header><h3>Change interval</h3><button aria-label="Close interval picker" onclick={close}>✕</button></header>
  <label for="interval-input">Interval</label>
  <input id="interval-input" data-testid="interval-input" bind:this={input} bind:value oninput={() => error = ''} onblur={normalize} aria-invalid={!!error} aria-describedby="interval-help" maxlength="12" autocomplete="off" spellcheck="false" />
  <p id="interval-help"><span>Minutes: <code>15</code> → <code>15m</code>, <code>60</code> → <code>1h</code></span><span>Units: <code>2h</code>, <code>8h</code>, <code>1D</code>, <code>3D</code>, <code>1W</code>, <code>1M</code></span></p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button class="confirm" aria-keyshortcuts="Enter" data-testid="interval-confirm" onclick={confirm}>{interval ? `Change to ${ivLabel(interval)}` : 'Apply interval'}</button>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal { position: fixed; top: 25%; left: 50%; transform: translateX(-50%); z-index: 21; width: min(400px, calc(100vw - 32px)); padding: 20px; display: grid; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
  header { display: flex; justify-content: space-between; align-items: center; }
  h3, p { margin: 0; }
  p { color: var(--dim); line-height: 1.5; }
  #interval-help { display: grid; gap: 2px; }
  code { color: var(--accent); font: inherit; font-weight: 500; }
  header button { background: none; color: var(--dim); }
  .confirm { background: var(--accent); color: var(--bg); }
  .error { color: var(--sell); }
</style>
