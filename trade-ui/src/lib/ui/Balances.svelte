<script lang="ts">
  import { inventory, usdValue } from '$lib/account/inventory.svelte';
  import { meta, spotRoute } from '$lib/market/meta.svelte';
  import { market, selectCoin } from '$lib/market/market.svelte';
  import { fmtSz, fmtUsd } from '$lib/util/format';
  import { cards } from './tables.svelte';

  const rows = $derived(inventory.balances.filter((b) => b.total !== 0).sort((a, b) => usdValue(b) - usdValue(a)));
  const pairOf = (token: string) => {
    const coin = token === 'USDC' ? undefined : spotRoute(token)?.[0];
    return coin && meta.byName.has(coin) ? coin : undefined;
  };
</script>

{#if !inventory.spotLoaded}
  <p class="dim" data-testid="account-empty">Loading spot balances…</p>
{:else if !rows.length}
  <p class="dim" data-testid="account-empty">No spot balances.</p>
{:else if cards.current}
  <div class="cards">
    {#each rows as b (b.coin)}
      {@const pair = pairOf(b.coin)}
      <div class="card" data-testid="balance-tab-row" data-coin={b.coin} class:on={pair === market.coin}>
        <div class="head"><span>{#if pair}<button class="pair" data-testid="balance-pair" onclick={(e) => { selectCoin(pair); e.currentTarget.blur(); }}>{b.coin}</button>{:else}{b.coin}{/if}</span><span class="num">{fmtUsd(usdValue(b))}</span></div>
        <div class="grid">
          <div class="field"><span class="label">Total</span><span class="value num">{fmtSz(b.total)} {b.coin}</span></div>
          <div class="field"><span class="label">Available</span><span class="value num" data-testid="balance-free">{fmtSz(b.total - (b.spotHold ?? b.hold))} {b.coin}</span></div>
        </div>
      </div>
    {/each}
  </div>
{:else}
  <table>
    <thead><tr><th>Coin</th><th>Total Balance</th><th>Available Balance</th><th>USDC Value</th></tr></thead>
    <tbody>
      {#each rows as b (b.coin)}
        {@const pair = pairOf(b.coin)}
        <tr data-testid="balance-tab-row" data-coin={b.coin} class:on={pair === market.coin}>
          <td>{#if pair}<button data-testid="balance-pair" onclick={(e) => { selectCoin(pair); e.currentTarget.blur(); }}>{b.coin}</button>{:else}{b.coin}{/if}</td>
          <td class="num">{fmtSz(b.total)} {b.coin}</td>
          <td class="num" data-testid="balance-free">{fmtSz(b.total - (b.spotHold ?? b.hold))} {b.coin}</td>
          <td class="num">{fmtUsd(usdValue(b))}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  p { padding: 8px 12px; margin: 0; font-size: max(8px, calc(var(--fs) * 0.917)); }
  tr.on td:first-child, .card.on .head { color: var(--bright); }
  .pair { background: none; color: var(--accent); padding: 0; font-weight: 600; }
</style>
