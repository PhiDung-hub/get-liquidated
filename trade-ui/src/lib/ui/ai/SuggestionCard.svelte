<script lang="ts">
  import { tick } from 'svelte';
  import { act, type Suggestion } from '$lib/agent/agent.svelte';
  import { selectCoin } from '$lib/market/market.svelte';
  import { kindOf, listed, listState, meta, symOf } from '$lib/market/meta.svelte';
  import { persist, settings } from '$lib/settings/settings.svelte';
  import { ticket } from '$lib/orders/ticket.svelte';
  import { fmtSz } from '$lib/util/format';

  let { s, now }: { s: Suggestion; now: number } = $props();

  function unusable(coin: string): string {
    if (meta.byName.get(coin)?.isDelisted) return `${coin} is delisted`;
    if (listed(coin)) return '';
    if (!meta.loaded) return 'The market list has not loaded yet';
    const k = kindOf(coin), s = listState(k);
    if (k !== 'perp' && s !== 'on') return `${coin} needs ${k === 'hip3' ? 'HIP-3' : 'spot'} markets, which are ${s === 'off' ? 'off' : 'still loading'}`;
    return `${coin} is not a listed market`;
  }

  const text = (n: number | null) => (n === null ? '' : String(n));

  async function useSuggestion(s: Suggestion) {
    if (unusable(s.coin)) return;
    selectCoin(s.coin);
    // The order panel clears typed prices on a coin switch; that runs on this tick, so the ticket is filled after it.
    await tick();
    const tpsl = s.tp !== null || s.sl !== null;
    Object.assign(ticket, { kind: s.kind, isBuy: s.side === 'buy', px: text(s.px), size: s.size, unit: s.unit, reduceOnly: false, tpsl, tp: text(s.tp), sl: text(s.sl) });
    if (s.kind === 'limit') ticket.tif = 'Gtc';
    settings.panel.sizeUnit = s.unit;
    persist();
    await act(s.id, 'used');
  }

  const n = (x: number | null) => fmtSz(x ?? NaN);
  const terms = $derived(
    [
      s.kind === 'limit' ? `Limit ${n(s.px)}` : 'Market',
      s.unit === 'usd' ? `$${n(s.size)}` : `${n(s.size)} ${symOf(s.coin)}`,
      s.tp !== null && `TP ${n(s.tp)}`,
      s.sl !== null && `SL ${n(s.sl)}`
    ].filter(Boolean).join(' · ')
  );
  const blocked = $derived(unusable(s.coin));
  const age = $derived.by(() => {
    const m = Math.floor((now - s.created) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
  });

  let reason: HTMLElement;
  let open = $state(false);
  let long = $state(false);
  $effect(() => {
    void s.reason;
    const measure = () => (long = reason.scrollHeight > reason.clientHeight + 1);
    const watch = new ResizeObserver(measure);
    watch.observe(reason);
    return () => watch.disconnect();
  });
  const tap = (f: () => unknown) => (e: MouseEvent) => {
    (e.currentTarget as HTMLElement).blur();
    void f();
  };
</script>

<article class="card" data-testid="ai-card" data-id={s.id}>
  <p class="line" data-testid="ai-card-line">
    <b class:buy={s.side === 'buy'} class:sell={s.side === 'sell'}>{s.side.toUpperCase()} {s.coin}</b> · {terms}
  </p>
  <p class="reason" class:open bind:this={reason} data-testid="ai-reason">{s.reason}</p>
  {#if long || open}
    <button class="more" data-testid="ai-more" onclick={tap(() => (open = !open))}>{open ? 'less' : 'more'}</button>
  {/if}
  <p class="meta dim"><span data-testid="ai-confidence">{Math.round(s.confidence * 100)}%</span> · <span data-testid="ai-age">{age}</span></p>
  <div class="actions">
    <button class="use" data-testid="ai-use" disabled={!!blocked} title={blocked || 'Fill the order form with this; nothing is sent'} onclick={tap(() => useSuggestion(s))}>Use</button>
    <button data-testid="ai-dismiss" onclick={tap(() => act(s.id, 'dismissed'))}>Dismiss</button>
    <button data-testid="ai-later" onclick={tap(() => act(s.id, 'later'))}>Later</button>
  </div>
</article>

<style>
  .card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--surface); border-radius: var(--radius); }
  p { margin: 0; }
  .line { color: var(--bright); overflow-wrap: anywhere; }
  .line b { font-weight: 600; }
  .reason { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
  .reason.open { -webkit-line-clamp: unset; line-clamp: unset; }
  .more { align-self: flex-start; padding: 0; background: none; color: var(--accent); }
  .meta { font-size: max(8px, calc(var(--fs) * 0.917)); }
  .actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .actions button { height: calc(var(--fs) * 2.5); border-radius: var(--radius); color: var(--bright); }
  .actions .use { background: var(--accent); color: var(--bg); }
  .actions .use:disabled { background: var(--surface); color: var(--dim); }
  .dim { color: var(--dim); }
</style>
