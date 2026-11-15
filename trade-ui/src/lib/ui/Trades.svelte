<script lang="ts">
  import { trades } from '$lib/market/trades.svelte';
  import { market } from '$lib/market/market.svelte';
  import { isSpot, meta } from '$lib/market/meta.svelte';
  import { fmtPx, fmtSz } from '$lib/util/format';

  const dec = $derived(meta.byName.get(market.coin)?.szDecimals);
</script>

<table>
  <thead><tr><th>Price</th><th>Size</th><th>Time</th></tr></thead>
  <tbody>
    {#each trades.list as t (t.tid)}
      <tr>
        <td class="num" class:buy={t.side === 'B'} class:sell={t.side === 'A'} title={t.side === 'B' ? 'Buy' : 'Sell'}>{fmtPx(t.px, dec, isSpot(market.coin))}</td>
        <td class="num">{fmtSz(t.sz, dec)}</td>
        <td class="num dim">{new Date(t.time).toISOString().slice(11, 19)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  th { position: sticky; top: 0; background: var(--panel); }
  th:not(:first-child), td:not(:first-child) { text-align: right; }
  @media (max-width: 900px) { table { font-size: max(8px, calc(var(--fs) * 0.833)); } }
</style>
