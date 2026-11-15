<script lang="ts">
  import { persist, settings } from '$lib/settings/settings.svelte';
  import type { TicketKind } from '$lib/orders/ticket.svelte';
  import Menu from './Menu.svelte';

  let { kind = $bindable(), onchange, spot = false }: { kind: TicketKind; onchange?: (k: TicketKind) => void; spot?: boolean } = $props();

  const ALL = (
    [['chase', 'Chase'], ['scale', 'Scale'], ['stopLimit', 'Stop Limit'], ['stopMarket', 'Stop Market'], ['takeLimit', 'Take Limit'], ['takeMarket', 'Take Market']] as const
  ).map(([value, label]) => ({ value, label, testid: `panel-kind-${value}`, group: value.startsWith('stop') ? 'Stop loss' : value.startsWith('take') ? 'Take profit' : 'Execution' }));
  // Spot has no Stop/Take orders here.
  const PRO = $derived(spot ? ALL.filter((o) => o.value === 'chase' || o.value === 'scale') : ALL);

  const pro = $derived(PRO.find((o) => o.value === kind));

  function set(k: TicketKind) {
    kind = k;
    settings.panel.kind = k;
    persist();
    onchange?.(k);
  }

  function tab(e: MouseEvent, k: TicketKind) {
    if (e.detail) (e.currentTarget as HTMLElement).blur();
    set(k);
  }
</script>

<nav class="tabs ui-tabs">
  <button type="button" class="ui-tab" class:on={kind === 'market'} aria-pressed={kind === 'market'} data-testid="panel-tab-market" onclick={(e) => tab(e, 'market')}>Market</button>
  <button type="button" class="ui-tab" class:on={kind === 'limit'} aria-pressed={kind === 'limit'} data-testid="panel-tab-limit" onclick={(e) => tab(e, 'limit')}>Limit</button>
  <div class="ui-tab pro" class:on={!!pro}>
    <Menu value={kind} options={PRO} onpick={(v) => set(v as TicketKind)} testid="panel-tab-pro" text={pro?.label ?? 'Pro'} ariaLabel="Pro order types" />
  </div>
</nav>

<style>
  .tabs { display: grid; grid-template-columns: repeat(3, 1fr); }
  button, .pro { height: calc(var(--fs) * 2.917); line-height: calc(var(--fs) * 2.917 - 1px); padding: 0; font: inherit; text-align: center; cursor: pointer; }
  .pro { display: flex; }
  .pro :global(.menu), .pro :global(.menu > button) { width: 100%; height: 100%; justify-content: center; }
  .pro :global(.menu > button) { gap: 12px; }
</style>
