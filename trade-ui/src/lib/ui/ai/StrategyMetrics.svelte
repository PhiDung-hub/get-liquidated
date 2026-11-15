<script lang="ts">
  import type { Bar, Interval } from '$lib/market/candles';
  import { MS } from '$lib/market/candles';
  import { market } from '$lib/market/market.svelte';
  import { SETUPS } from './setups.svelte';
  import { METHODS, strategyMetrics, type Correlation } from './strategyMetrics';
  import Menu from '../order/Menu.svelte';

  let { bars, interval }: { bars: Bar[]; interval: Interval } = $props();
  let horizon = $state(5);
  let now = $state(Date.now());
  $effect(() => { const timer = setInterval(() => now = Date.now(), 30_000); return () => clearInterval(timer); });
  let cached: { coin: string; interval: Interval; horizon: number; first: Bar | undefined; last: Bar | undefined; count: number; result: ReturnType<typeof strategyMetrics> } | undefined;
  const result = $derived.by(() => {
    const closed = bars.filter((b) => b.time + MS[interval] <= now);
    const first = closed[0], last = closed.at(-1);
    if (cached && cached.coin === market.coin && cached.interval === interval && cached.horizon === horizon && cached.count === closed.length && cached.first === first && cached.last === last) return cached.result;
    const value = strategyMetrics(closed, MS[interval], horizon);
    cached = { coin: market.coin, interval, horizon, first, last, count: closed.length, result: value };
    return value;
  });
  const r = (value: Correlation) => value.r === null ? '—' : `${value.r >= 0 ? '+' : ''}${value.r.toFixed(2)}`;
  const short = ['VWAP', 'ORB', 'Sweep', 'EMA', 'MA3'];
  const stamp = (time: number | null) => time === null ? '—' : new Date(time).toISOString().slice(0, 16).replace('T', ' ');
</script>

<section data-testid="strategy-metrics">
  <strong>Historical rule metrics · {interval}</strong>
  {#if result.error}<p role="status">{result.error}</p>{/if}
  <p class="dim">Up to 500 completed chart candles. Scores are +1 long, −1 short or 0 neutral.</p>
  <div class="horizon"><span>Forward return</span><Menu value={String(horizon)} options={[1, 5, 15].map((n) => ({ value: String(n), label: `Next ${n} bar${n === 1 ? '' : 's'}` }))} onpick={(n) => horizon = Number(n)} testid="metrics-horizon" ariaLabel="Return horizon" align="left" dropdown /></div>
  <div class="scroll"><table>
    <thead><tr><th>Strategy</th><th>Signal ↔ return</th><th>Pairs</th><th>Signals</th></tr></thead>
    <tbody>{#each result.strategies as item, i}<tr data-testid="strategy-metric-{item.id}"><th title={METHODS[item.id]}>{SETUPS[i].name}</th><td title={item.forward.reason || 'Pearson correlation'}>{r(item.forward)}</td><td>{item.forward.n}</td><td>{item.signals}</td></tr>{/each}</tbody>
  </table></div>
  {#if result.strategies.some((s) => s.forward.r === null)}<p class="dim" data-testid="metrics-unavailable">— means fewer than 30 pairs, insufficient indicator history or no variation.</p>{/if}
  <strong>Strategy overlap</strong>
  <p class="dim">Pearson correlation between simultaneous rule scores. A value near +1 indicates similar signals; near −1 indicates opposing signals.</p>
  <div class="scroll"><table data-testid="strategy-overlap"><thead><tr><th></th>{#each short as name}<th>{name}</th>{/each}</tr></thead><tbody>{#each result.overlap as row, i}<tr><th>{short[i]}</th>{#each row as value}<td title={value.reason || `${value.n} paired bars`}>{r(value)}</td>{/each}</tr>{/each}</tbody></table></div>
  <p class="dim" data-testid="metrics-range">{result.bars} closed bars · {stamp(result.from)} → {stamp(result.to)} UTC</p>
  <details><summary>Definitions and limits</summary><p>These fixed rule proxies use only this chart’s interval, not the full multi-timeframe demo checklist. Forward returns use later closed candles and skip missing time intervals. Neutral scores are included; Signals counts non-neutral bars.</p>{#each SETUPS as setup}<p><b>{setup.name}:</b> {METHODS[setup.id]}</p>{/each}<p>Descriptive, in-sample correlations are not win rates or a backtest. Fees, slippage and funding are excluded; overlapping return horizons and serial dependence can affect interpretation.</p></details>
</section>

<style>
  section { display: grid; gap: 10px; min-width: 0; }
  p { margin: 0; line-height: 1.4; }
  .dim { color: var(--dim); }
  .horizon { display: flex; justify-content: space-between; gap: 8px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: max(8px, calc(var(--fs) * 0.85)); font-variant-numeric: tabular-nums; }
  th, td { padding: 6px 4px; border-bottom: 1px solid var(--line); text-align: right; }
  th:first-child { text-align: left; }
  thead th { color: var(--dim); font-weight: 400; }
  tbody th { font-weight: 400; }
  summary { cursor: pointer; color: var(--dim); }
  details p { margin-top: 8px; }
</style>
