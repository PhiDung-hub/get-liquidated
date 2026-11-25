<script lang="ts">
  let { isBuy = $bindable(), spot = false }: { isBuy: boolean; spot?: boolean } = $props();
  const buy = $derived(spot ? 'Buy' : 'Buy / Long');
  const sell = $derived(spot ? 'Sell' : 'Sell / Short');

  function pick(e: MouseEvent, buy: boolean) {
    if (e.detail) (e.currentTarget as HTMLElement).blur();
    isBuy = buy;
  }
</script>

<div class="side" class:sell={!isBuy}>
  <span class="pill" aria-hidden="true"></span>
  <button type="button" class:on={isBuy} aria-pressed={isBuy} data-testid="panel-side-buy" onclick={(e) => pick(e, true)}>{buy}</button>
  <button type="button" class:on={!isBuy} aria-pressed={!isBuy} data-testid="panel-side-sell" onclick={(e) => pick(e, false)}>{sell}</button>
</div>

<style>
  .side { position: relative; display: grid; grid-template-columns: 1fr 1fr; height: var(--ctl); margin: 8px 0; padding: 2px; background: var(--surface); border-radius: var(--radius); }
  .pill { position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc(50% - 2px); border-radius: var(--radius); background: var(--buy); transition: transform 0.1s ease-in-out, background-color 0.1s; }
  .sell .pill { transform: translateX(100%); background: var(--sell-action); }
  button { position: relative; padding: 0; background: none; border: 0; border-radius: var(--radius); color: var(--buy-text); font: inherit; cursor: pointer; transition: color 0.1s; }
  button:last-child { color: var(--sell-text); }
  button.on { color: var(--bg); }
</style>
