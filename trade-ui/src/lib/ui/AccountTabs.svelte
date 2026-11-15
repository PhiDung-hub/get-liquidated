<script lang="ts">
  import { settings, persist } from '$lib/settings/settings.svelte';
  import { inventory } from '$lib/account/inventory.svelte';
  import { fills } from '$lib/account/fills.svelte';
  import { funding } from '$lib/account/funding.svelte';
  import { isSpot, nameOf, spotName } from '$lib/market/meta.svelte';
  import { market } from '$lib/market/market.svelte';
  import { openOrders } from '$lib/account/orders.svelte';
  import { session, viewAddress } from '$lib/session/session.svelte';
  import { chases } from '$lib/orders/chase.svelte';
  import Positions from './Positions.svelte';
  import OpenOrders from './OpenOrders.svelte';
  import Fills from './Fills.svelte';
  import Funding from './Funding.svelte';
  import Balances from './Balances.svelte';
  import Menu from './order/Menu.svelte';
  import { ui, type BottomTab } from './state.svelte';
  import { accountView, cardFold, cardSort, cards, sweepOf, type AccountSide } from './tables.svelte';

  // A spot pair has no position: its first tab is the spot balances, and a perp brings Positions back.
  const spot = $derived(isSpot(market.coin));
  const shown = $derived<BottomTab>(spot && ui.bottomTab === 'positions' ? 'balances' : !spot && ui.bottomTab === 'balances' ? 'positions' : ui.bottomTab);
  const counts = $derived<Record<BottomTab, number | null>>({
    positions: inventory.positions.filter((p) => p.szi !== 0).length,
    balances: inventory.balances.filter((b) => b.total !== 0).length,
    orders: openOrders.list.length,
    fills: null,
    funding: null
  });
  const TABS = $derived<[BottomTab, string][]>([spot ? ['balances', 'Balances'] : ['positions', 'Positions'], ['orders', cards.current ? 'Orders' : 'Open Orders'], ['fills', 'Fills'], ['funding', 'Funding']]);
  const canTrade = $derived(!!session.agent && session.holdsSigner);
  const chasing = $derived(chases.list.filter((c) => c.state !== 'stopped'));
  const closeAll = $derived(cards.current && canTrade && shown === 'positions' && (!!counts.positions || openOrders.list.some((o) => !spotName(o.coin)) || chasing.some((c) => !spotName(c.coin))));
  const cancelAll = $derived(cards.current && canTrade && shown === 'orders' && (!!openOrders.list.length || !!chasing.length));
  const SIDES: [AccountSide, string][] = [['all', 'All'], ['long', 'Long'], ['short', 'Short']];
  const SORTS = [{ value: 'value', label: 'Value', testid: 'orders-sort-value' }, { value: 'coin', label: 'Coin', testid: 'orders-sort-coin' }, { value: 'time', label: 'Time', testid: 'orders-sort-time' }];
  const coins = $derived([...new Set(
    shown === 'positions' ? inventory.positions.filter((p) => p.szi !== 0).map((p) => p.coin)
    : shown === 'orders' ? [...openOrders.list.map((o) => o.coin), ...chases.list.map((c) => c.coin)]
    : shown === 'fills' ? fills.list.map((f) => f.coin)
    : shown === 'funding' ? funding.list.map((f) => f.coin) : []
  )].sort((a, b) => nameOf(a).localeCompare(nameOf(b))));
  $effect(() => {
    if (shown === 'balances' || !accountView.coin || accountView.coin === 'active') return;
    if (!coins.includes(accountView.coin)) accountView.coin = '';
  });
  const coinOptions = $derived([
    { value: '', label: 'All coins', testid: 'account-coin-all' },
    { value: 'active', label: 'Active', testid: 'account-filter-active' },
    ...coins.map((coin) => ({ value: coin, label: nameOf(coin), testid: `account-coin-${coin}` }))
  ]);
</script>

<div class="tabs">
  <div class="bar">
    <nav class="ui-tabs">
      {#each TABS as [id, label]}
        <button class="ui-tab" class:on={shown === id} aria-pressed={shown === id} data-testid="account-tab-{id}" onclick={(e) => { ui.bottomTab = id; settings.display.minimized.positions = false; persist(); if (e.detail) e.currentTarget.blur(); }}>
          {label}{counts[id] ? ` (${counts[id]})` : ''}
        </button>
      {/each}
    </nav>
    {#if viewAddress() && shown !== 'balances' && !settings.display.minimized.positions}
      <div class="tools">
        <div class="filter" role="group" aria-label="Filter">
          {#if cards.current && shown === 'orders'}<span class="coin-filter"><Menu value={cardSort.orders} text="⇅ {SORTS.find((s) => s.value === cardSort.orders)?.label}" options={SORTS} onpick={(k) => (cardSort.orders = k)} testid="orders-sort" ariaLabel="Sort orders by" align="left" dropdown /></span>{/if}
          <span class="coin-filter" class:on={!!accountView.coin}><Menu value={accountView.coin} options={coinOptions} onpick={(coin) => accountView.coin = coin} testid="account-coin-filter" ariaLabel="Filter by coin" dropdown /></span>
          {#each SIDES as [id, label] (id)}
            <button class="ui-tab" class:on={accountView.side === id} aria-label={id === 'all' ? 'All sides' : label} aria-pressed={accountView.side === id} data-testid="account-filter-{id}" onclick={(e) => ((accountView.side = id), e.detail && e.currentTarget.blur())}>{label}</button>
          {/each}
        </div>
        <span class="acts">
          {#if cardFold.run}<button class="fold" data-testid="cards-toggle-all" aria-expanded={cardFold.open} onclick={(e) => (cardFold.run?.(), e.currentTarget.blur())}>{cardFold.open ? 'Collapse All' : 'Expand All'}</button>{/if}
          {#if closeAll}<button class="sweep" data-testid="flatten-open" onclick={(e) => sweepOf(e, 'flatten')}>Close All</button>{/if}
          {#if cancelAll}<button class="sweep" data-testid="cancel-all-open" onclick={(e) => sweepOf(e, 'cancel')}>Cancel All</button>{/if}
        </span>
      </div>
    {/if}
    <button class="minimize" data-testid="minimize-positions" aria-label={settings.display.minimized.positions ? 'Expand positions panel' : 'Minimize positions panel'} aria-expanded={!settings.display.minimized.positions} onclick={() => { settings.display.minimized.positions = !settings.display.minimized.positions; persist(); }}>{settings.display.minimized.positions ? '+' : '−'}</button>
  </div>
  <div class="body" hidden={settings.display.minimized.positions}>
    {#if !viewAddress()}
      <p class="dim empty" data-testid="account-empty">Connect a wallet, or open with ?user=0x… to view an account read-only.</p>
    {:else}
      {#if shown === 'positions'}<Positions />
      {:else if shown === 'balances'}<Balances />
      {:else if shown === 'orders'}<OpenOrders />
      {:else if shown === 'fills'}<Fills />
      {:else}<Funding />{/if}
    {/if}
  </div>
</div>

<style>
  .tabs { display: flex; flex-direction: column; height: 100%; }
  .bar { display: flex; flex: none; align-items: center; border-bottom: 1px solid var(--line); }
  nav { display: flex; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  nav button { flex: none; padding: 8px 12px; }
  .body[hidden] { display: none; }
  .minimize { background: none; color: var(--dim); padding: 7px 12px; }
  .body { flex: 1; min-height: 0; overflow: auto; }
  .empty { padding: 12px; margin: 0; }
  :global(.account table) { width: 100%; font-size: max(8px, calc(var(--fs) * 0.917)); }
  :global(.account th) { padding: 5px 8px; white-space: nowrap; position: sticky; top: 0; background: var(--panel); }
  :global(.account tbody tr:hover) { background: var(--surface); }
  :global(.account td button) { background: none; color: var(--accent); padding: 0 4px; }
  :global(.account td button:hover) { text-decoration: underline; }
  .filter { display: flex; flex: 0 1 auto; gap: 4px; min-width: 0; padding: 0 8px; overflow-x: auto; scrollbar-width: none; font-size: max(8px, calc(var(--fs) * 0.917)); }
  .filter button { flex: none; padding: 2px 10px; }
  .coin-filter { display: inline-flex; flex: none; align-items: center; padding: 2px 10px; color: var(--dim); border-right: 1px solid var(--line); }
  .coin-filter.on { color: var(--accent); font-weight: 600; }
  .acts { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .acts:empty { display: none; }
  .tools { display: contents; }
  @media (max-width: 900px), (pointer: coarse) and (max-height: 500px) {
    .bar { flex-wrap: wrap; }
    nav { flex-wrap: wrap; overflow: visible; }
    nav button { padding: 8px 3px; }
    .filter .ui-tab.on { background: none; color: var(--accent); font-weight: 600; }
    .minimize { padding: 7px 8px; }
    .tools { order: 1; flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; padding: 4px 8px; border-top: 1px solid var(--line); }
    .filter { flex-wrap: wrap; padding: 0; overflow: visible; }
    .filter button { min-height: 32px; }
    .coin-filter :global(button) { min-height: 32px; }
  }
  .tools .sweep { min-height: 32px; }
  .tools .fold { min-height: 32px; padding: 0 4px; background: none; color: var(--dim); white-space: nowrap; }
  :is(.tools, .body) :global(.sweep) { background: none; color: var(--sell-text); padding: 0 4px; white-space: nowrap; font-weight: 600; }
  :is(.tools, .body) :global(.sweep:hover) { text-decoration: underline; }
  .body :global(.pin-last :is(th, td):last-child) { position: sticky; right: 0; background: var(--panel); }
  .body :global(.pin-last th:last-child) { z-index: 1; }
  .body :global(.pin-last tbody tr:hover > td:last-child) { background: var(--surface); }
  :where(.body) :global(.cards) { display: flex; flex-direction: column; gap: 4px; padding: 4px 8px; }
  .body :global(.cards .card) { gap: 4px; padding: 6px 10px; }
  :where(.body) :global(:where(.cards) .head) { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  :where(.body) :global(:where(.cards) .head b) { font-weight: 600; }
  :where(.body) :global(:where(.cards) .head > .num) { flex: none; white-space: nowrap; }
  :where(.body) :global(:where(.cards) .grid) { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5em), 1fr)); gap: 4px 10px; }
  :where(.body) :global(:where(.cards) .field) { display: flex; flex-direction: column; min-width: 0; }
  :where(.body) :global(:where(.cards) .label) { color: var(--dim); }
  :where(.body) :global(:where(.cards) .value) { overflow-wrap: anywhere; }
  :where(.body) :global(:where(.cards) .value.num) { overflow-wrap: normal; }
  :where(.body) :global(:where(.cards) .value:not(.buy, .sell)) { color: var(--bright); }
  :global(.account p) { margin: 0; }
  :global(.account abbr) { cursor: default; text-decoration: underline dashed var(--faint); text-underline-offset: 3px; }
</style>
