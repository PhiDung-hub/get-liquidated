<script lang="ts">
  import { settings, persist } from '$lib/settings/settings.svelte';
  import OrderBook from './OrderBook.svelte';
  import Trades from './Trades.svelte';
  import { ui } from './state.svelte';

  /** flat: folded to a header bar across a wide column (tall portrait, book above the ticket) instead of a vertical strip. */
  let { flat = false }: { flat?: boolean } = $props();
</script>

<nav class="ui-tabs" class:folded={settings.display.minimized.book} class:flat>
  {#if !settings.display.minimized.book}
  <button class="ui-tab" class:on={ui.bookTab === 'book'} aria-pressed={ui.bookTab === 'book'} onclick={(e) => ((ui.bookTab = 'book'), e.detail && e.currentTarget.blur())}>Order Book</button>
  <button class="ui-tab" class:on={ui.bookTab === 'trades'} aria-pressed={ui.bookTab === 'trades'} onclick={(e) => ((ui.bookTab = 'trades'), e.detail && e.currentTarget.blur())}>Trades</button>
  {/if}
  <button class="ui-tab collapse" data-testid="minimize-book" aria-label={settings.display.minimized.book ? 'Expand order book and trades' : 'Minimize order book and trades'} aria-expanded={!settings.display.minimized.book} onclick={() => { settings.display.minimized.book = !settings.display.minimized.book; persist(); }}>{#if settings.display.minimized.book}<span>+</span><span class="label">{ui.bookTab === 'book' ? 'Order Book' : 'Trades'}</span>{:else}−{/if}</button>
</nav>
{#if !settings.display.minimized.book}{#if ui.bookTab === 'book'}<OrderBook />{:else}<Trades />{/if}{/if}

<style>
  .collapse { margin-left: auto; }
  nav.folded { position: relative; z-index: 6; flex: 1; min-height: 0; border-bottom: 0; }
  .folded .collapse { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; margin: 0; padding: 7px 2px; border-bottom: 0; }
  .label { writing-mode: vertical-rl; white-space: nowrap; }
  .flat .collapse { flex-direction: row; padding: 5px 8px; }
  .flat .label { writing-mode: horizontal-tb; }
  nav { display: flex; border-bottom: 1px solid var(--line); }
  nav button { padding: 5px 8px; }
</style>
