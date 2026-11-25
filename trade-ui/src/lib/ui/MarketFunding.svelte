<script lang="ts">
  import { market } from '$lib/market/market.svelte';
  import { isSpot, meta } from '$lib/market/meta.svelte';
  import { fundingHistory, HOUR, publishedHour, type FundingRow } from '$lib/market/fundingHistory';
  import { fmtNum, fmtTime } from '$lib/util/format';
  import FundingRate from './FundingRate.svelte';

  const ranges = [{ label: '24h', hours: 24 }, { label: '7d', hours: 168 }, { label: '30d', hours: 720 }];
  let hours = $state(24);
  let selectedTime = $state<number>();
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => now = Date.now(), 60_000);
    return () => clearInterval(timer);
  });
  const hour = $derived(publishedHour(now));
  const start = $derived((hour - hours + 1) * HOUR);
  const end = $derived(hour * HOUR);
  const history = $derived(isSpot(market.coin) ? null : fundingHistory(market.coin, start));
  const ctx = $derived(market.ctx ?? meta.ctxs.get(market.coin));
  const pct = (rate: number) => `${fmtNum(rate * 100, 4)}%`;
  type Point = FundingRow & { hour: number; cumulative: number; x: number };
  const hourOf = (time: number) => Math.floor(time / HOUR) * HOUR;

  function plot(rows: FundingRow[], from: number, to: number) {
    let cumulative = 0;
    const points = rows.filter((r) => r.time >= from && r.time < to + HOUR).map((row) => {
      const hour = hourOf(row.time);
      cumulative += row.funding;
      return { ...row, hour, cumulative, x: 4 + ((hour - from) / (to - from)) * 232 };
    });
    const extent = (key: 'funding' | 'cumulative') => Math.max(0.000001, ...points.map((p) => Math.abs(p[key]))) * 1.08;
    const rate = extent('funding');
    const total = extent('cumulative');
    const y = (value: number, max: number) => 50 - (value / max) * 50;
    const path = (key: 'funding' | 'cumulative', max: number) => points.map((p, i) =>
      `${i && p.hour - points[i - 1].hour === HOUR ? 'L' : 'M'}${p.x},${y(p[key], max)}`
    ).join(' ');
    return { points, rate, total, y, hourlyPath: path('funding', rate), cumulativePath: path('cumulative', total) };
  }

  function selectPoint(event: PointerEvent, points: Point[]) {
    if (event.type === 'pointermove' && event.pointerType === 'touch') return;
    const { left, width } = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - left) / width * 240;
    selectedTime = points.reduce((best, p) => Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best).time;
  }

  function stepPoint(event: KeyboardEvent, points: Point[], index: number) {
    const targets: Partial<Record<string, number>> = { ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: points.length - 1 };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectedTime = points[Math.min(points.length - 1, Math.max(0, next))].time;
  }
</script>

<div class="rates">
  {#if history}
    <div class="current"><span>Hourly funding</span><FundingRate rate={ctx?.funding ?? null} prefix="market-" /></div>
    <nav aria-label="Funding history range">
      {#each ranges as range (range.hours)}
        <button class="ui-tab" aria-pressed={hours === range.hours} onclick={() => { selectedTime = undefined; hours = range.hours; }}>{range.label}</button>
      {/each}
    </nav>
    {#await history}
      <p class="dim">Loading funding history…</p>
    {:then data}
      {@const graph = plot(data.rows, start, end)}
      {#if graph.points.length}
        {@const index = graph.points.findIndex((p) => p.time === selectedTime)}
        {@const selected = index === -1 ? graph.points.length - 1 : index}
        {@const point = graph.points[selected]}
        <figure>
          <figcaption>
            <span class="hourly">Hourly <b>{pct(point.funding)}</b></span>
            <span class="cumulative">Cumulative <b>{pct(point.cumulative)}</b></span>
          </figcaption>
          <time class="dim" datetime={new Date(point.time).toISOString()}>{fmtTime(point.time).slice(0, -3)} UTC</time>
          <div class="plot">
            <div class="scale hourly" aria-hidden="true"><span>{pct(graph.rate)}</span><span>0%</span><span>{pct(-graph.rate)}</span></div>
            <div class="graph" role="slider" tabindex="0" aria-label="Funding chart time" aria-valuemin={1} aria-valuemax={graph.points.length} aria-valuenow={selected + 1}
                 aria-valuetext={`${fmtTime(point.time)} UTC. Hourly ${pct(point.funding)}. Cumulative ${pct(point.cumulative)}.`}
                 onpointerdown={(e) => selectPoint(e, graph.points)} onpointermove={(e) => selectPoint(e, graph.points)} onkeydown={(e) => stepPoint(e, graph.points, selected)}>
              <svg viewBox="0 0 240 100" preserveAspectRatio="none" aria-hidden="true">
                <path class="gridlines" d="M0 25H240 M0 75H240 M60 0V100 M120 0V100 M180 0V100" />
                <path class="zero" d="M0 50H240" />
                <path class="rate-line" d={graph.hourlyPath} />
                <path class="sum-line" d={graph.cumulativePath} />
                <path class="cursor" d={`M${point.x} 0V100`} />
                <line class="rate-line dot" x1={point.x} x2={point.x} y1={graph.y(point.funding, graph.rate)} y2={graph.y(point.funding, graph.rate)} />
                <line class="sum-line dot" x1={point.x} x2={point.x} y1={graph.y(point.cumulative, graph.total)} y2={graph.y(point.cumulative, graph.total)} />
              </svg>
            </div>
            <div class="scale cumulative" aria-hidden="true"><span>{pct(graph.total)}</span><span>0%</span><span>{pct(-graph.total)}</span></div>
            <div class="times dim" aria-hidden="true"><span>{fmtTime(start).slice(0, -3)}</span><span>{fmtTime(end).slice(0, -3)}</span></div>
          </div>
        </figure>
        <details><summary>Hourly values</summary>
          <table aria-label="Recent hourly funding"><thead><tr><th>Time (UTC)</th><th>Funding</th><th>Premium</th></tr></thead><tbody>
            {#each graph.points.slice(-24).reverse() as row (row.time)}
              <tr><td>{fmtTime(row.time)}</td><td>{pct(row.funding)}</td><td>{pct(row.premium)}</td></tr>
            {/each}
          </tbody></table>
        </details>
      {:else}<p class="dim">No published funding history.</p>{/if}
    {:catch}<p>Funding history is unavailable.</p>{/await}
  {:else}<p class="dim">Spot markets have no funding payments.</p>{/if}
</div>

<style>
  .rates { overflow: auto; padding: 8px; font-variant-numeric: tabular-nums; }
  .current, figcaption { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 8px; }
  nav { display: flex; justify-content: flex-end; gap: 4px; margin: 4px 0; }
  nav button { padding: 2px 8px; }
  figure { margin: 6px 0 12px; }
  time { display: block; margin: 2px 0 6px; }
  .plot { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 6px; font-size: max(9px, 0.8em); }
  .scale, .times { display: flex; justify-content: space-between; white-space: nowrap; }
  .scale { flex-direction: column; }
  .scale:first-child { text-align: right; }
  .times { grid-column: 2; gap: 4px; }
  .hourly { color: var(--buy-text); }
  .cumulative { color: var(--warn-text); }
  .graph { min-width: 0; cursor: crosshair; touch-action: pan-y; }
  svg { display: block; width: 100%; height: clamp(96px, 22dvh, 290px); }
  svg :is(path, line) { fill: none; vector-effect: non-scaling-stroke; }
  .gridlines { stroke: var(--gutter); }
  .zero { stroke: var(--dim); stroke-dasharray: 2 4; }
  .cursor { stroke: var(--line); }
  .rate-line { stroke: var(--buy); stroke-width: 1.75; }
  .sum-line { stroke: var(--warn); stroke-width: 1.75; }
  .dot { stroke-linecap: round; stroke-width: 5; }
  summary { cursor: pointer; color: var(--bright); }
  table { width: 100%; }
  td, th { text-align: right; }
  td:first-child, th:first-child { text-align: left; }
</style>
