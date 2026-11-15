<script lang="ts">
  import { funding } from '$lib/account/funding.svelte';
  import { meta } from '$lib/market/meta.svelte';
  import { fmtNum, fmtSz, fmtTime, fmtUsd } from '$lib/util/format';
  import Coin from './Coin.svelte';
  import { cards, inFilter } from './tables.svelte';

  const dec = (coin: string) => meta.byName.get(coin)?.szDecimals;
  const rows = $derived(funding.list.filter((f) => inFilter(f.coin, f.szi > 0)));
  const total = $derived(rows.reduce((s, f) => s + f.usdc, 0));
</script>

{#if !rows.length}
  <p class="dim" data-testid="account-empty">{funding.list.length ? 'No funding payments match the filter.' : 'No funding payments yet.'}</p>
{:else}
  <p class="num total" class:buy={total >= 0} class:sell={total < 0}>Total shown: {fmtUsd(total)}</p>
  {#if cards.current}
    <div class="cards">
      {#each rows as f (`${f.time}:${f.coin}`)}
        <div class="card" data-testid="funding-row">
          <div class="head"><Coin coin={f.coin} /><span class="num dim">{fmtTime(f.time)}</span></div>
          <div class="grid">
            <div class="field"><span class="label">Size</span><span class="value num">{fmtSz(f.szi, dec(f.coin))}</span></div>
            <div class="field"><span class="label">Rate</span><span class="value num">{fmtNum(f.rate * 100, 4)}%</span></div>
            <div class="field"><span class="label">Payment</span><span class="value num" class:buy={f.usdc >= 0} class:sell={f.usdc < 0}>{fmtUsd(f.usdc)}</span></div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <table>
      <thead><tr><th>Time (UTC)</th><th>Coin</th><th>Size</th><th>Rate</th><th>Payment</th></tr></thead>
      <tbody>
        {#each rows as f (`${f.time}:${f.coin}`)}
          <tr data-testid="funding-row">
            <td class="num dim">{fmtTime(f.time)}</td>
            <td><Coin coin={f.coin} /></td>
            <td class="num">{fmtSz(f.szi, dec(f.coin))}</td>
            <td class="num">{fmtNum(f.rate * 100, 4)}%</td>
            <td class="num" class:buy={f.usdc >= 0} class:sell={f.usdc < 0}>{fmtUsd(f.usdc)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/if}

<style>
  p { padding: 8px 12px; margin: 0; font-size: max(8px, calc(var(--fs) * 0.917)); }
  .total { padding: 6px 8px; }
  .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .field:last-child { align-items: flex-end; text-align: right; }
</style>
