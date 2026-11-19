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
      {@const start = (hour - 23) * HOUR}
      {@const rows = data.rows.filter((r) => r.time >= start && r.time < (hour + 1) * HOUR)}
      {#if rows.length}
        {@const peak = Math.max(...rows.map((r) => Math.abs(r.funding)))}
        <figure>
          <figcaption>Hourly funding · 24h</figcaption>
          <div class="plot">
            <div class="scale"><span>{fmtNum(peak * 100, 4)}%</span><span>0%</span><span>{fmtNum(-peak * 100, 4)}%</span></div>
            <svg viewBox="0 0 240 100" preserveAspectRatio="none" role="img" aria-label="Hourly funding rates over the last 24 hours">
              <line x1="0" x2="240" y1="50" y2="50" stroke="var(--line)" />
              {#each rows as row (row.time)}
                {@const height = peak ? Math.abs(row.funding) / peak * 48 : 0}
                <rect x={Math.floor((row.time - start) / HOUR) * 10 + 1} y={row.funding > 0 ? 50 - height : 50} width="8" height={Math.max(1, height)} fill={row.funding === 0 ? 'var(--dim)' : row.funding > 0 ? 'var(--buy)' : 'var(--sell)'}>
                  <title>{fmtTime(row.time)} UTC · {fmtNum(row.funding * 100, 4)}%</title>
                </rect>
              {/each}
            </svg>
            <div class="times"><span>{fmtTime(start).slice(-8, -3)}</span><span>{fmtTime(hour * HOUR).slice(-8, -3)} UTC</span></div>
          </div>
        </figure>
        <details><summary>Hourly values</summary>
        <table aria-label="Recent hourly funding"><thead><tr><th>Time (UTC)</th><th>Funding</th><th>Premium</th></tr></thead><tbody>
          {#each rows.toReversed() as row (row.time)}
            <tr><td>{fmtTime(row.time)}</td><td>{fmtNum(row.funding * 100, 4)}%</td><td>{fmtNum(row.premium * 100, 4)}%</td></tr>
          {/each}
        </tbody></table></details>
      {:else}<p class="dim">No published funding history.</p>{/if}
    {:catch}<p>Hourly funding history is unavailable.</p>{/await}
  {:else}<p class="dim">Spot markets have no funding payments.</p>{/if}
</div>

<style>
  .rates { overflow: auto; padding: 8px; font-variant-numeric: tabular-nums; }
  .current { display: flex; align-items: baseline; justify-content: space-between; padding-bottom: 8px; }
  figure { margin: 6px 0 12px; }
  figcaption { color: var(--bright); margin-bottom: 8px; }
  .plot { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; }
  .scale, .times { display: flex; justify-content: space-between; color: var(--dim); }
  .scale { flex-direction: column; text-align: right; }
  .times { grid-column: 2; }
  svg { display: block; width: 100%; height: clamp(86px, 20dvh, 170px); }
  summary { cursor: pointer; color: var(--bright); }
  table { width: 100%; }
  td, th { text-align: right; }
  td:first-child, th:first-child { text-align: left; }
</style>
