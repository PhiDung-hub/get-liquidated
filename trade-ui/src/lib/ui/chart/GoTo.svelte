<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { isTouch, tabNavigation } from '../touch';
  import { ui } from '../state.svelte';
  import { RANGES, today, zoned } from './ranges';

  let { timezone, presets, pickRange, goToTime, goToRange }: {
    timezone: string; presets: boolean; pickRange: (days: number) => void; goToTime: (t: number) => void; goToRange: (from: number, to: number) => void;
  } = $props();

  const day = (ms: number) => today(untrack(() => timezone), ms);
  let tab = $state<'date' | 'range'>('date');
  let date = $state(day(Date.now()));
  let time = $state('00:00');
  let from = $state(day(Date.now() - 7 * 864e5));
  let to = $state(day(Date.now()));
  let error = $state('');
  const close = () => { ui.overlay = null; document.activeElement instanceof HTMLElement && document.activeElement.blur(); };
  const pick = (days: number) => { close(); pickRange(days); };
  const formId = $props.id();
  let first = $state<HTMLInputElement>();
  onMount(() => { if (!isTouch()) first?.focus(); });

  function go(e: SubmitEvent) {
    e.preventDefault();
    const now = Date.now();
    const start = tab === 'date' ? zoned(date, time, timezone) : zoned(from, '00:00', timezone);
    const end = tab === 'date' ? start : Math.min(zoned(to, '23:59', timezone), now);
    if (!(start < now && start >= 0)) return void (error = 'Choose a date in the past.');
    if (!(start <= end)) return void (error = 'Choose a start before the end.');
    close();
    if (tab === 'date') goToTime(start);
    else goToRange(start, end);
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />
<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="Go to" data-sheet data-testid="goto">
  <header><h3>Go to</h3><button type="button" aria-label="Close go to" onclick={close}>✕</button></header>
  {#if presets}
    <div class="presets">{#each RANGES as [label, days]}<button type="button" data-testid="range-{label}" onclick={() => pick(days)}>{label}</button>{/each}</div>
  {/if}
  <form id={formId} onsubmit={go}>
  <div class="tabs" role="tablist" aria-label="Go to options" tabindex="-1" onkeydown={tabNavigation}>
    <button type="button" class="ui-tab" role="tab" aria-selected={tab === 'date'} tabindex={tab === 'date' ? 0 : -1} class:on={tab === 'date'} data-testid="goto-date-tab" onclick={() => ((tab = 'date'), (error = ''))}>Date</button>
    <button type="button" class="ui-tab" role="tab" aria-selected={tab === 'range'} tabindex={tab === 'range' ? 0 : -1} class:on={tab === 'range'} data-testid="goto-range-tab" onclick={() => ((tab = 'range'), (error = ''))}>Custom range</button>
  </div>
  <div class="fields">
    {#if tab === 'date'}
      <label>Date<input type="date" data-testid="goto-date" bind:this={first} bind:value={date} oninput={() => (error = '')} /></label>
      <label>Time<input type="time" data-testid="goto-time" bind:value={time} oninput={() => (error = '')} /></label>
    {:else}
      <label>From<input type="date" data-testid="goto-from" bind:value={from} oninput={() => (error = '')} /></label>
      <label>To<input type="date" data-testid="goto-to" bind:value={to} oninput={() => (error = '')} /></label>
    {/if}
  </div>
  <p>In the chart's timezone: {timezone.replaceAll('_', ' ')}.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  </form>
  <button class="confirm" form={formId} data-testid="goto-confirm">Go to</button>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal { position: fixed; top: 20%; left: 50%; transform: translateX(-50%); z-index: 21; width: min(400px, calc(100vw - 32px)); padding: 20px; display: grid; gap: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); }
  form { display: grid; gap: 10px; }
  header { display: flex; justify-content: space-between; align-items: center; }
  h3, p { margin: 0; }
  p { color: var(--dim); line-height: 1.5; }
  header button { background: none; color: var(--dim); }
  .presets { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
  .presets button { min-height: 36px; background: var(--surface); color: var(--text); }
  .tabs { display: flex; gap: 4px; }
  .tabs button { padding: 6px 10px; }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  label { display: grid; gap: 4px; color: var(--dim); min-width: 0; }
  input { width: 100%; min-width: 0; box-sizing: border-box; }
  .confirm { background: var(--accent); color: var(--bg); }
  .error { color: var(--sell); }
</style>
