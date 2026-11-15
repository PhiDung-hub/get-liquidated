<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Bar, Interval } from '$lib/market/candles';
  import StrategyMetrics from './StrategyMetrics.svelte';
  import { agent, annotationChat } from '$lib/agent/agent.svelte';
  import { market } from '$lib/market/market.svelte';
  import { meta } from '$lib/market/meta.svelte';
  import { ui } from '$lib/ui/state.svelte';
  import { fmtPx } from '$lib/util/format';
  import { coach, loadDemo, SETUPS, showCoach, type SetupId } from './setups.svelte';
  import Menu, { menus } from '../order/Menu.svelte';
  import SuggestionCard from './SuggestionCard.svelte';

  let { bars, interval }: { bars: Bar[]; interval: Interval } = $props();
  const advice = $derived(agent.advice.filter((entry) => !entry.coin || entry.coin === market.coin));
  const suggestions = $derived(agent.suggestions.filter((s) => s.coin === market.coin));
  const count = $derived(advice.length + suggestions.length);
  const demo = $derived(coach.demo?.coin === market.coin ? coach.demo : null);
  const setup = $derived(SETUPS.find((s) => s.id === demo?.setup) ?? SETUPS[0]);
  const price = (n: number) => fmtPx(n, meta.byName.get(market.coin)?.szDecimals);
  let now = $state(Date.now());
  $effect(() => { const timer = setInterval(() => now = Date.now(), 15_000); return () => clearInterval(timer); });
  $effect(() => {
    const coin = market.coin;
    untrack(() => { if (coach.demo && coach.demo.coin !== coin) { coach.demo = null; coach.error = ''; } });
  });
  function mode(value: 'live' | 'demo' | 'metrics') {
    showCoach(value);
    if (value === 'demo' && !demo) loadDemo('vwap');
  }
  function key(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); coach.open = false; }
  }
  onMount(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || ui.overlay || annotationChat.markId || annotationChat.pending || menus.open) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      coach.open = false;
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  });
</script>

{#if coach.open && !ui.overlay && !annotationChat.markId && !annotationChat.pending}
  <div class="coach" class:minimized={coach.collapsed} role="dialog" aria-modal="false" aria-label="AI chart coach" tabindex="-1" onkeydown={key} data-testid="chart-coach">
    <header><strong>{coach.collapsed && coach.mode === 'demo' ? 'DEMO' : 'Chart coach'} <span class="dim">· {market.coin}</span></strong><button aria-label={coach.collapsed ? 'Expand chart coach' : 'Minimize chart coach'} aria-expanded={!coach.collapsed} onclick={() => coach.collapsed = !coach.collapsed}>{coach.collapsed ? '+' : '−'}</button><button aria-label="Close chart coach" onclick={() => coach.open = false}>✕</button></header>
    <nav aria-label="Coach views" hidden={coach.collapsed}>
      <button class="ui-tab" class:on={coach.mode === 'live'} aria-pressed={coach.mode === 'live'} data-testid="coach-live" onclick={() => mode('live')}>Live guidance{count ? ` · ${count}` : ''}</button>
      <button class="ui-tab" class:on={coach.mode === 'demo'} aria-pressed={coach.mode === 'demo'} data-testid="coach-demo" onclick={() => mode('demo')}>Setup demos</button>
      <button class="ui-tab" class:on={coach.mode === 'metrics'} aria-pressed={coach.mode === 'metrics'} data-testid="coach-metrics" onclick={() => mode('metrics')}>Metrics</button>
    </nav>
    <div class="body" hidden={coach.collapsed}>
      {#if coach.mode === 'metrics'}
        <StrategyMetrics {bars} {interval} />
      {:else if coach.mode === 'demo'}
        <p class="demo-label">DEMO · illustrative scenarios, not live signals</p>
        <div class="picker"><Menu value={setup.id} options={SETUPS.map((s) => ({ value: s.id, label: s.name }))} onpick={(id) => loadDemo(id as SetupId)} testid="coach-setup" ariaLabel="Trading setup" align="left" dropdown /><span class="dim">{setup.style}</span></div>
        <p class="dim">{setup.timeframe}</p>
        <div class="sides" aria-label="Example direction">
          <button class="ui-tab" class:on={demo?.side === 'buy'} aria-pressed={demo?.side === 'buy'} data-testid="coach-long" onclick={() => loadDemo(setup.id, 'buy')}>Long example</button>
          <button class="ui-tab" class:on={demo?.side === 'sell'} aria-pressed={demo?.side === 'sell'} data-testid="coach-short" disabled={!!meta.byName.get(market.coin)?.spot} onclick={() => loadDemo(setup.id, 'sell')}>Short example</button>
        </div>
        {#if demo}
          <p>{demo.side === 'buy' ? setup.long : setup.short}</p>
          <div class="levels" data-testid="coach-levels"><span>Entry</span><b>{price(demo.entry)}</b><span>Invalidation / stop</span><b class="sell">{price(demo.stop)}</b><span>Target</span><b class="buy">{price(demo.target)}</b><span>Reward / risk</span><b>{(Math.abs(demo.target - demo.entry) / Math.abs(demo.entry - demo.stop)).toFixed(1)}R</b></div>
          <div class="phases" aria-label="Demo state">
            {#each ['watching', 'triggered', 'invalidated'] as phase}<button class="ui-tab" class:on={coach.phase === phase} aria-pressed={coach.phase === phase} data-testid="coach-phase-{phase}" onclick={() => coach.phase = phase as typeof coach.phase}>{phase}</button>{/each}
          </div>
          <p class="phase" data-testid="coach-scenario">{coach.phase === 'watching' ? 'Example: wait for confirmation before considering an entry.' : coach.phase === 'triggered' ? 'Example: confirmation met. Review the entry, stop and target together.' : 'Example: invalidation reached. Stand aside and reassess.'}</p>
          <details><summary>Setup checklist</summary><p>{setup.checks}</p><p>{setup.invalidation}</p><p class="dim">Example levels use a fixed distance from the mark when loaded. Indicators and market conditions have not been evaluated. Fees and slippage are excluded from R.</p></details>
          <button class="rebase" data-testid="coach-rebase" onclick={() => loadDemo(setup.id)}>Refresh example prices</button>
        {:else}<p class="dim">Load an example for this market.</p><button onclick={() => loadDemo(setup.id)}>Load example</button>{/if}
        {#if coach.error}<p role="status" class="error">{coach.error}</p>{/if}
      {:else}
        <p class="dim" data-testid="coach-status">{agent.status === 'live' ? 'MCP workspace connected' : agent.address ? 'Reconnecting to MCP workspace' : 'Connect your local AI for live guidance'}</p>
        {#each advice as entry (entry.id)}<article data-testid="coach-advice"><strong>{entry.skill}</strong><p>{entry.advice}</p><p class="dim">Next: {entry.nextStep}</p><details><summary>Evidence</summary><p>{entry.evidence}</p></details></article>{/each}
        {#each suggestions as s (s.id)}<SuggestionCard {s} {now} />{/each}
        {#if !count}<p class="dim">No guidance published for {market.coin} yet. Explore a setup demo while you wait.</p>{/if}
        {#if !agent.address}<button class="connect" data-testid="coach-connect" onclick={() => ui.overlay = 'aiConnect'}>Connect local AI</button>{/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .coach { position: absolute; right: 68px; bottom: 42px; z-index: 8; width: min(350px, calc(100% - 116px)); max-height: min(560px, calc(100% - 112px)); display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 8px 24px #0005; color: var(--text); font-size: var(--fs); text-align: left; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 12px; }
  header strong { margin-right: auto; }
  header button { background: none; color: var(--dim); }
  nav, .sides, .phases { display: flex; gap: 4px; }
  nav { padding: 0 10px; border-bottom: 1px solid var(--line); }
  nav button { flex: 1; min-width: 0; padding: 5px 4px; }
  .body { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px; overscroll-behavior: contain; }
  .body[hidden], nav[hidden] { display: none; }
  p { margin: 0; line-height: 1.4; overflow-wrap: anywhere; white-space: normal; }
  .demo-label { color: var(--warn); font-size: max(8px, calc(var(--fs) * 0.85)); }
  .picker { flex-wrap: wrap; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .sides button, .phases button { flex: 1; min-width: 0; }
  .phases button { text-transform: capitalize; padding: 6px 2px; font-size: max(8px, calc(var(--fs) * 0.85)); }
  .levels { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding: 10px; background: var(--bg); border-radius: var(--radius); color: var(--dim); }
  .levels b { text-align: right; font-weight: 500; font-variant-numeric: tabular-nums; }
  .levels b.buy { color: var(--buy-text); }
  .levels b.sell { color: var(--sell-text); }
  .phase { padding: 8px; background: var(--surface); border-radius: var(--radius); }
  details p { margin-top: 8px; }
  summary { cursor: pointer; color: var(--dim); }
  .rebase { align-self: flex-start; color: var(--dim); background: none; padding: 0; }
  .connect { background: var(--accent); color: var(--bg); }
  article { display: grid; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .dim { color: var(--dim); font-weight: 400; }
  .error { color: var(--sell); }
  @media (max-width: 900px) { .coach { left: 44px; right: 12px; bottom: 44px; width: auto; max-height: min(420px, calc(100% - 104px)); } .sides button, .phases button, nav button, header button { min-height: 44px; } }
</style>
