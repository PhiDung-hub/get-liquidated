<script lang="ts">
  import { fmtNum } from '$lib/util/format';

  let { rate, prefix = '', running = true, separate = false }: { rate: number | null; prefix?: string; running?: boolean; separate?: boolean } = $props();
  let now = $state(0);
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });
  const seconds = $derived(Math.ceil((3_600_000 - now % 3_600_000) / 1000));
  const countdown = $derived(`${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
</script>

<span class="funding-values" class:separate title={separate ? undefined : 'Estimated hourly funding. Positive rates are paid by longs to shorts. Settlement is at the next UTC hour.'}>
  <span class="num" data-testid={prefix + 'funding'} data-help-detail={separate && rate !== null ? `Annualized at the current rate: ${fmtNum(rate * 24 * 365 * 100, 2)}%` : undefined} class:buy={(rate ?? 0) >= 0} class:sell={(rate ?? 0) < 0}>{rate === null ? '—' : `${fmtNum(rate * 100, 4)}%`}</span>
  {#if !separate}<span class="dim">in</span>{/if}
  <time class="num" data-testid={prefix + 'funding-countdown'} datetime={now ? `PT${seconds}S` : null} aria-label={now ? `${countdown} until next funding settlement` : null}>{now ? countdown : '—'}</time>
</span>

<style>
  .funding-values { display: inline-flex; align-items: baseline; gap: 5px; white-space: nowrap; }
  .separate { gap: 10px; }
  time { color: var(--bright); font-variant-numeric: tabular-nums; }
</style>
