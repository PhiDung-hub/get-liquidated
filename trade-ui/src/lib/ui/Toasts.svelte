<script lang="ts">
  import { onMount } from 'svelte';
  import { entrySizeOf, liveFills, type Fill } from '$lib/account/fills.svelte';
  import { fillProgress } from '$lib/account/orders.svelte';
  import { isSpot, meta, nameOf } from '$lib/market/meta.svelte';
  import { session } from '$lib/session/session.svelte';
  import { fmtPx, fmtSz } from '$lib/util/format';
  import { toast, toasts } from './toast.svelte';
  import Sided from './Sided.svelte';

  onMount(() => liveFills.on((fills) => {
    if (!session.master || document.visibilityState !== 'visible') return;
    const entries = new Map<string, { fill: Fill; sz: number; value: number }>();
    for (const fill of fills) {
      const sz = entrySizeOf(fill);
      if (!(sz > 0 && fill.px > 0)) continue;
      const key = `${fill.coin}:${fill.oid}:${fill.side}`;
      const entry = entries.get(key) ?? { fill, sz: 0, value: 0 };
      entry.sz += sz;
      entry.value += sz * fill.px;
      entries.set(key, entry);
    }
    for (const { fill, sz, value } of entries.values()) {
      const side = fill.side === 'B' ? 'buy' : 'sell';
      const decimals = meta.byName.get(fill.coin)?.szDecimals;
      const progress = fillProgress(fill);
      const status = progress?.partial ? 'Partially filled' : 'Filled';
      const remaining = progress?.partial ? ` · ${fmtSz(progress.remaining, decimals)} ${progress.working ? 'remaining' : 'unfilled'}` : '';
      toast.info(`${status} ${side} ${fmtSz(sz, decimals)} ${nameOf(fill.coin)} @ ${fmtPx(value / sz, decimals, isSpot(fill.coin))}${remaining}`, side);
    }
  }));
</script>

<div class="toasts" aria-live="polite">
  {#each toasts.list as t (t.id)}
    <div class="toast {t.kind}" data-testid="toast">
      <span class="text" id="toast-message-{t.id}"><Sided text={t.text} side={t.side} />{#if t.action}{@const a = t.action}<button class="action" data-testid="toast-action" onclick={() => (toast.dismiss(t.id), a.run())}>{a.label}</button>{/if}</span>
      <button class="dismiss" data-testid="toast-dismiss" aria-label="Dismiss notification" aria-describedby="toast-message-{t.id}" onclick={(e) => (e.currentTarget.blur(), toast.dismiss(t.id))}><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; top: var(--toast-top, auto); right: 12px; bottom: var(--toast-bottom, 32px); display: flex; flex-direction: column; justify-content: flex-end; justify-content: safe flex-end; gap: 4px; z-index: 30; pointer-events: none; max-width: min(420px, calc(100vw - 24px)); }
  .toast { display: flex; align-items: flex-start; gap: 6px; background: var(--surface); color: var(--bright); font-weight: 600; border: 1px solid color-mix(in srgb, var(--dim) 30%, var(--line)); border-radius: var(--radius); box-shadow: 0 4px 16px #0003; padding: 6px 10px; font-size: var(--fs); font-family: var(--mono); font-variant-ligatures: none; overflow-wrap: anywhere; }
  .text { flex: 1; min-width: 0; }
  .toast button { pointer-events: auto; background: none; font-weight: 600; }
  .action { margin-left: 10px; padding: 1px 8px; border: 1px solid var(--line); color: var(--accent); }
  .dismiss { flex: none; display: grid; place-items: center; min-width: 24px; min-height: 24px; padding: 0; border: 0; color: var(--dim); }
  .dismiss:hover { color: var(--bright); }
  @media (max-width: 900px), (pointer: coarse) and (max-height: 500px) {
    .toasts { top: calc(8px + env(safe-area-inset-top)); right: calc(8px + env(safe-area-inset-right)); bottom: auto; justify-content: flex-start; max-width: min(360px, calc(100vw - 16px - env(safe-area-inset-left) - env(safe-area-inset-right))); max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); overflow-y: auto; overscroll-behavior: contain; }
    .dismiss { min-width: 32px; min-height: 32px; }
  }
  @media (pointer: coarse) and (max-height: 500px) {
    .toasts { max-width: calc(100vw - 16px - env(safe-area-inset-left) - env(safe-area-inset-right)); }
  }
  .error { border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
</style>
