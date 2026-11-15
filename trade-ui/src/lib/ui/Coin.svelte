<script lang="ts">
  import { dexOf, meta, symOf } from '$lib/market/meta.svelte';

  let { coin, quote = '', lev = 0 }: { coin: string; quote?: string; lev?: number } = $props();
  const dex = $derived(dexOf(coin));
  const a = $derived(meta.byName.get(coin));
</script>

<span title={coin}>{#if a?.spot}<span class="sym">{a.base}/{a.collateral}</span>{' '}<span class="pill" data-testid="spot-pill">spot</span>{:else}<span class="sym">{symOf(coin)}{quote ? `-${quote}` : ''}</span>{#if lev}{' '}<span class="lev">{lev}x</span>{/if}{#if dex}{' '}<span class="pill" data-testid="dex-pill">{dex}</span>{/if}{/if}</span>

<style>
  .sym, .lev, .pill { white-space: nowrap; }
  .lev, .pill { margin-left: 2px; padding: 0 4px; border-radius: var(--radius); background: var(--surface); font-size: max(8px, 0.85em); font-weight: 500; vertical-align: 1px; }
  .lev { color: var(--dim); }
  .pill { color: var(--accent); }
</style>
