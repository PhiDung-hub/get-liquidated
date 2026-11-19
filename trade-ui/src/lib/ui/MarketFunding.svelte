<script lang="ts">
  import { market } from '$lib/market/market.svelte';
  import { isSpot, meta } from '$lib/market/meta.svelte';
  import { fundingHistory, HOUR, publishedHour } from '$lib/market/fundingHistory';
  import { fmtNum, fmtTime } from '$lib/util/format';
  import FundingRate from './FundingRate.svelte';

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => now = Date.now(), 60_000);
    return () => clearInterval(timer);
  });
  const hour = $derived(publishedHour(now));
  const history = $derived(isSpot(market.coin) ? null : fundingHistory(market.coin, (hour - 24) * HOUR));
  const ctx = $derived(market.ctx ?? meta.ctxs.get(market.coin));
</script>

<div class="rates">
  {#if history}
    <div class="current"><span>Hourly funding</span><FundingRate rate={ctx?.funding ?? null} prefix="market-" /></div>
    {#await history}
      <p class="dim">Loading hourly history…</p>
    {:then data}
      {#if data.rows.length}
        <table aria-label="Recent hourly funding"><thead><tr><th>Time (UTC)</th><th>Funding</th><th>Premium</th></tr></thead><tbody>
          {#each data.rows.slice(-24).reverse() as row (row.time)}
            <tr><td>{fmtTime(row.time)}</td><td>{fmtNum(row.funding * 100, 4)}%</td><td>{fmtNum(row.premium * 100, 4)}%</td></tr>
          {/each}
        </tbody></table>
      {:else}<p class="dim">No published funding history.</p>{/if}
    {:catch}<p>Hourly funding history is unavailable.</p>{/await}
  {:else}<p class="dim">Spot markets have no funding payments.</p>{/if}
</div>

<style>
  .rates { overflow: auto; padding: 8px; font-variant-numeric: tabular-nums; }
  .current { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 8px; }
  table { width: 100%; }
  td, th { text-align: right; }
  td:first-child, th:first-child { text-align: left; }
</style>
