<script lang="ts">
  import { inventory } from '$lib/account/inventory.svelte';
  import { openOrders } from '$lib/account/orders.svelte';
  import { meta } from '$lib/market/meta.svelte';
  import { chases } from '$lib/orders/chase.svelte';
  import { closeSweep, inSweepScope, runSweep, sweep } from '$lib/orders/sweep.svelte';
  import { fmtSz, fmtUsdShort } from '$lib/util/format';
  import Coin from './Coin.svelte';

  const flatten = $derived(sweep.kind === 'flatten');
  const rows = $derived(
    sweep.coins.map((coin) => ({
      coin, p: inventory.positions.find((x) => x.coin === coin && x.szi !== 0), n: openOrders.list.filter((o) => o.coin === coin).length
    }))
  );
  const scope = $derived(sweep.scope);
  const scoped = $derived(scope ? openOrders.list.filter((o) => inSweepScope(scope, o.coin, o.side === 'B')).length + chases.list.filter((c) => c.state === 'chasing' && inSweepScope(scope, c.coin, c.isBuy)).length : 0);
  const all = $derived(sweep.ticked.length === sweep.coins.length);
  const toggle = (coin: string) => (sweep.ticked = sweep.ticked.includes(coin) ? sweep.ticked.filter((c) => c !== coin) : [...sweep.ticked, coin]);
  const tap = (f: () => unknown) => (e: MouseEvent) => ((e.currentTarget as HTMLElement).blur(), f());

  let dialog: HTMLElement;
  // Capture phase, ahead of the hotkey dispatcher: Enter runs and Esc cancels whatever is focused, except a focused button keeps its own Enter.
  function onKey(e: KeyboardEvent) {
    const enter = e.code === 'Enter' || e.code === 'NumpadEnter';
    if (e.code !== 'Escape' && !(enter && !(e.target instanceof HTMLButtonElement))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') closeSweep();
    else void runSweep();
  }
  $effect(() => {
    dialog.focus();
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });
</script>

<div class="scrim" role="presentation" onclick={closeSweep}></div>
<div class="sheet" role="dialog" data-sheet aria-label={flatten ? 'Flatten' : 'Cancel all'} tabindex="-1" bind:this={dialog} data-testid="sweep" data-kind={sweep.kind}>
  {#if scope}
    <h3 data-testid="sweep-scope">Cancel {scoped} {scope.isBuy === undefined ? '' : scope.isBuy ? 'buy ' : 'sell '}order{scoped === 1 ? '' : 's'}{#if scope.coin}{' '}on <Coin coin={scope.coin} />{/if}, TP/SL included</h3>
  {:else}
  <h3>{flatten ? 'Flatten: close, then cancel orders where flat' : 'Cancel all orders, TP/SL included'}</h3>
  <table>
    <thead>
      <tr>
        <th><input type="checkbox" aria-label="tick all" data-testid="sweep-all" checked={all} indeterminate={!all && sweep.ticked.length > 0} onchange={() => (sweep.ticked = all ? [] : [...sweep.coins])} /></th>
        <th>Coin</th><th>Position</th><th>uPnL</th><th>Orders</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.coin)}
        <tr data-testid="sweep-row" data-coin={r.coin} class:off={!sweep.ticked.includes(r.coin)} onclick={(e) => e.target instanceof HTMLInputElement || toggle(r.coin)}>
          <td><input type="checkbox" aria-label="tick {r.coin}" checked={sweep.ticked.includes(r.coin)} onchange={() => toggle(r.coin)} /></td>
          <td><Coin coin={r.coin} /></td>
          <td class="num" class:buy={(r.p?.szi ?? 0) > 0} class:sell={(r.p?.szi ?? 0) < 0}>{r.p ? `${r.p.szi > 0 ? 'Long' : 'Short'} ${fmtSz(Math.abs(r.p.szi), meta.byName.get(r.coin)?.szDecimals)}` : '—'}</td>
          <td class="num" class:buy={(r.p?.uPnl ?? 0) > 0} class:sell={(r.p?.uPnl ?? 0) < 0}>{r.p ? fmtUsdShort(r.p.uPnl) : '—'}</td>
          <td class="num">{r.n}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {/if}
  <p class="dim">{#if sweep.stopped}<span class="stopped">Stopped {sweep.stopped} running chase(s). </span>{/if}<span class="hint">Enter confirms, Esc cancels{scope ? '' : ', Space or a click ticks a row'}.</span></p>
  <div class="actions">
    <button data-testid="sweep-cancel" disabled={sweep.busy} onclick={tap(closeSweep)}>Cancel</button>
    <button class="go" data-testid="sweep-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={sweep.busy ? 'Submission in progress.' : 'Select at least one market to confirm.'} disabled={sweep.busy || (!scope && !sweep.ticked.length)} onclick={tap(runSweep)}>
      {sweep.busy ? '…' : scope ? `Cancel ${scoped} order${scoped === 1 ? '' : 's'}` : `${flatten ? 'Flatten' : 'Cancel orders on'} ${sweep.ticked.length} of ${sweep.coins.length}`}
    </button>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 30; }
  .sheet {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 31; outline: none;
    width: min(560px, calc(100vw - 32px)); max-height: 76vh; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius);
  }
  h3 { margin: 0; font-size: calc(var(--fs) * 1.25); font-weight: 400; color: var(--bright); }
  table { width: 100%; border-collapse: collapse; font-size: max(8px, calc(var(--fs) * 0.917)); }
  th { text-align: left; color: var(--dim); font-weight: 400; padding: 4px 6px; }
  td { padding: 5px 6px; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--surface); }
  tr.off { opacity: 0.5; }
  input { margin: 0; accent-color: var(--accent); cursor: pointer; }
  p { margin: 0; }
  .dim { color: var(--dim); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .actions button { height: var(--ctl); padding: 0 16px; border-radius: var(--radius); background: var(--surface); color: var(--bright); }
  .actions .go { background: var(--sell-action); color: var(--bg); }
  @media (pointer: coarse) { .hint, p.dim:not(:has(.stopped)) { display: none; } }
  @media (max-width: 900px) {
    td { padding: 10px 6px; white-space: normal; }
    input { width: 18px; height: 18px; }
  }
</style>
