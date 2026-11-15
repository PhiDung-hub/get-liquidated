<script lang="ts">
  import { market, selectCoin } from '$lib/market/market.svelte';
  import { isSpot, meta, parseCtx, parseSpotCtx, type Ctx } from '$lib/market/meta.svelte';
  import { safe } from '$lib/market/watch.svelte';
  import { socket } from '$lib/transport/ws.svelte';
  import { fmtPct, fmtPx } from '$lib/util/format';
  import { ui } from './state.svelte';
  import Coin from './Coin.svelte';

  let { coins }: { coins: string[] } = $props();
  const live = $state<Record<string, Ctx>>({});
  const key = $derived(coins.join(','));
  $effect(() => {
    const offs = (key ? key.split(',') : []).map((coin) => socket.subscribe({ type: 'activeAssetCtx', coin }, safe('quick market ctx', (d) => (live[coin] = isSpot(coin) ? parseSpotCtx(d.ctx) : parseCtx(d.ctx)))));
    return () => offs.forEach((off) => off());
  });
</script>

<nav data-testid="trade-markets" aria-label="Quick-switch markets above trading">
  <button class="edit" data-testid="trade-markets-edit" aria-label="Edit quick-switch markets" onclick={(e) => (e.currentTarget.blur(), (ui.overlay = 'quick'))}>★★</button>
  {#each coins as coin (coin)}
    {@const ctx = live[coin] ?? meta.ctxs.get(coin)}
    {@const change = ctx ? (ctx.markPx - ctx.prevDayPx) / ctx.prevDayPx : NaN}
    <button class="market" data-testid="trade-market" data-coin={coin} aria-current={coin === market.coin} onclick={(e) => (e.currentTarget.blur(), selectCoin(coin))}>
      <Coin {coin} />
      <span class="num price">{ctx ? fmtPx(ctx.markPx, meta.byName.get(coin)?.szDecimals, isSpot(coin)) : '—'}</span>
      <span class="num" class:buy={change >= 0} class:sell={change < 0}>{fmtPct(change)}</span>
    </button>
  {/each}
</nav>

<style>
  nav { display: flex; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: thin; white-space: nowrap; padding: 2px 4px; font-size: max(8px, calc(var(--fs) * 0.917)); }
  button { flex-shrink: 0; background: none; color: var(--dim); padding: 3px 5px; }
  .market { display: flex; align-items: baseline; gap: 6px; }
  .market[aria-current='true'] { background: var(--surface); color: var(--bright); }
  .price { color: var(--text); }
  .edit { color: var(--faint); }
  .edit:hover { color: var(--warn); }
</style>
