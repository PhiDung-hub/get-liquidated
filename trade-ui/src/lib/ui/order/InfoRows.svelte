<script lang="ts">
  import { market } from '$lib/market/market.svelte';
  import { isSpot, meta, quoteOf } from '$lib/market/meta.svelte';
  import { bbo } from '$lib/market/book.svelte';
  import { assetData } from '$lib/account/assetData.svelte';
  import { positionOf } from '$lib/account/inventory.svelte';
  import { fees, feeFor } from '$lib/account/fees.svelte';
  import { settings } from '$lib/settings/settings.svelte';
  import { estFill } from '$lib/orders/size';
  import type { Draft } from '$lib/orders/market';
  import type { TicketKind } from '$lib/orders/ticket.svelte';
  import { fmtNum, fmtPx } from '$lib/util/format';

  let { kind, isBuy, sz, px, ladder }: { kind: TicketKind; isBuy: boolean; sz: number; px: number; ladder: Draft[] } = $props();

  type Row = { label: string; value: string; short?: string; testid?: string; struck?: string; note?: string };
  const coin = $derived(market.coin);
  const szDec = $derived(meta.byName.get(coin)?.szDecimals ?? 0);
  const spot = $derived(isSpot(coin));
  const lev = $derived(assetData.coin === coin ? assetData.leverage : null);
  const pos = $derived(positionOf(coin));
  const value = $derived(kind === 'scale' ? ladder.reduce((t, d) => t + d.px * d.sz, 0) : sz * px);
  const usdc = (n: number) => `${fmtNum(n, 2)} ${quoteOf(coin)}`;
  const pct = (r: number, d: number) => `${(r * 100).toFixed(d)}%`;
  const rates = (f: { taker: number; maker: number }) => `${pct(f.taker, 4)} / ${pct(f.maker, 4)}`;
  const fee = $derived(feeFor(coin));
  const na = (ok: boolean, f: () => string) => (sz > 0 && ok ? f() : 'N/A');

  const slippage = $derived.by(() => {
    const mid = (bbo.bid + bbo.ask) / 2;
    const est = kind === 'market' && sz > 0 ? estFill(isBuy, sz) : null;
    return [est && mid > 0 ? pct(Math.abs(est / mid - 1), 4) : '—', pct(settings.market.slippage, 2)];
  });

  const rows = $derived.by((): Row[] => [
    ...(kind === 'scale'
      ? [
          { label: 'Start', value: na(ladder.length > 0, () => fmtPx(ladder[0].px, szDec, spot)) },
          { label: 'End', value: na(ladder.length > 0, () => fmtPx(ladder[ladder.length - 1].px, szDec, spot)) }
        ]
      : spot ? [] : [{ label: 'Liquidation Price', value: na(!!(pos?.szi && pos.liqPx), () => fmtPx(pos!.liqPx!, szDec)) }]),
    { label: 'Order Value', value: na(value > 0, () => usdc(value)), testid: 'panel-value' },
    ...(spot ? [] : [{ label: 'Margin Required', value: na(value > 0 && !!lev, () => usdc(value / lev!.value)) }]),
    ...(kind === 'market' ? [{ label: 'Slippage', value: `Est: ${slippage[0]} / Max: ${slippage[1]}`, short: `${slippage[0]} / ${slippage[1]}` }] : []),
    // HL discounts some non-USDC spot quotes, and its pair discounts are not in userFees.
    { label: 'Fees', value: rates(fee), testid: 'panel-fees', ...(fee.scaled ? { struck: rates(fees), note: 'est.' } : spot && quoteOf(coin) !== 'USDC' ? { note: 'est.' } : {}) }
  ]);
</script>

<div class="info">
  {#each rows as r (r.label)}
    <div class="row"><span class="dim">{r.label}</span><span class="v" data-testid={r.testid} title={r.short && r.value}>{#if r.struck}<s class="dim" data-testid="panel-fees-base">{r.struck}</s>{' '}{/if}{#if r.short}<span class="full">{r.value}</span><span class="short">{r.short}</span>{:else}{r.value}{/if}{#if r.note}{' '}<span class="dim">{r.note}</span>{/if}</span></div>
  {/each}
</div>

<style>
  .info { display: grid; gap: 10px; font-size: var(--fs); font-variant-numeric: tabular-nums; }
  .row { display: flex; justify-content: space-between; gap: 8px; line-height: calc(var(--fs) * 1.25); }
  .dim { color: var(--dim); }
  .v { color: var(--bright); text-align: right; }
  .short { display: none; }
  @media (max-width: 900px) {
    .full { display: none; }
    .short { display: inline; white-space: nowrap; }
  }
</style>
