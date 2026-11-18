<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { inventory, summary, usdValue } from '$lib/account/inventory.svelte';
  import { openOrders, type OpenOrder } from '$lib/account/orders.svelte';
  import { session, viewAddress } from '$lib/session/session.svelte';
  import { meta } from '$lib/market/meta.svelte';
  import { fees } from '$lib/account/fees.svelte';
  import { fmtNum, fmtUsd } from '$lib/util/format';
  import Coin from './Coin.svelte';
  import IdleYield from './IdleYield.svelte';

  const DAY = 86_400_000;
  const phone = new MediaQuery('max-width: 900px');
  const loaded = $derived(inventory.loaded);
  const s = $derived(summary());
  const pct = (n: number) => (loaded && Number.isFinite(n) ? `${fmtNum(n * 100, 2)}%` : '—');
  const lev = (n: number) => (loaded && Number.isFinite(n) ? `${fmtNum(n, 2)}×` : '—');
  const usdOf = (n: number) => (loaded ? fmtUsd(n) : '—');
  type Row = { id: string; label: string; value: string; title?: string; pnl?: boolean };
  const upnl = $derived<Row>({ id: 'inv-upnl', label: 'Unrealized PnL', value: usdOf(s.uPnl), title: 'excl. funding & fees', pnl: true });
  const notionals = $derived.by(() => {
    if (!loaded || inventory.broken.length) return { gross: NaN, delta: NaN };
    let gross = 0, delta = 0;
    for (const p of inventory.positions) {
      if (!p.szi) continue;
      const value = Math.abs(p.positionValue);
      gross += value;
      delta += Math.sign(p.szi) * value;
    }
    return { gross, delta };
  });
  // HL's account panel rows and labels: one set for portfolio-margin and unified accounts, Spot, Perps and Perps Overview for the rest.
  const rows = $derived.by((): Row[] => {
    if (s.mode === 'portfolioMargin' || s.mode === 'unifiedAccount') {
      const pm = s.mode === 'portfolioMargin';
      return [
        { id: 'inv-equity', label: 'Portfolio Value', value: usdOf(s.equity) },
        upnl,
        { id: 'inv-ratio', label: pm ? 'Portfolio Margin Ratio' : 'Unified Account Ratio', value: pct(s.ratio) },
        ...(pm ? [{ id: 'inv-borrow', label: 'Borrow Cap Used', value: pct(s.borrow) }] : []),
        { id: 'inv-mm', label: 'Perps Maintenance Margin', value: usdOf(s.mm) },
        { id: 'inv-leverage', label: pm ? 'Portfolio Account Leverage' : 'Unified Account Leverage', value: lev(s.leverage) },
        { id: 'inv-available', label: 'Available', value: usdOf(s.available), title: 'free USDC: total − spot hold' }
      ];
    }
    return [
      { id: 'inv-equity', label: 'Account Equity', value: usdOf(s.equity), title: 'Spot + Perps' },
      { id: 'inv-spot', label: 'Spot', value: fmtUsd(s.spot) },
      { id: 'inv-perps', label: 'Perps', value: usdOf(s.perps) },
      upnl,
      { id: 'inv-ratio', label: 'Cross Margin Ratio', value: pct(s.ratio) },
      { id: 'inv-mm', label: 'Maintenance Margin', value: usdOf(s.mm) },
      { id: 'inv-leverage', label: 'Cross Account Leverage', value: lev(s.leverage) },
      { id: 'inv-available', label: 'Available', value: usdOf(s.available), title: 'free USDC plus perp withdrawable' }
    ];
  });
  const groups = $derived([
    { title: 'Balance', rows: rows.slice(0, rows.findIndex((r) => r.id === 'inv-ratio')) },
    { title: 'Margin', rows: rows.slice(rows.findIndex((r) => r.id === 'inv-ratio')) },
    { title: 'Perp exposure', rows: [
      { id: 'inv-gross-exposure', label: 'Gross exposure', value: usdOf(notionals.gross), title: 'Sum of absolute open perp position values' },
      { id: 'inv-net-delta', label: 'Net delta', value: usdOf(notionals.delta), title: 'Long minus short perp exposure, in dollars' },
      { id: 'inv-effective-leverage', label: 'Account Leverage', value: lev(s.equity > 0 ? notionals.gross / s.equity : NaN), title: 'Effective account leverage: gross perp exposure divided by total account equity' }
    ] }
  ]);
  const whole = (n: number) => `$${fmtNum(n, 0)}`;
  const rate = (r: number) => `${(r * 100).toFixed(4)}%`;
  const feeTier = $derived(fees.tier === null ? '—' : `Tier ${fees.tier} · ${rate(fees.taker)} / ${rate(fees.maker)}`);
  const feeTitle = $derived(
    `14D volume: ${fees.tier === null ? '—' : whole(fees.vol)}\nNext: ${fees.tier === null ? '—' : fees.next === null ? 'Top volume tier' : `Tier ${fees.tier + 1} above ${whole(fees.next)}`}\n\nStaked HYPE: ${fees.stakedHype === null ? '—' : fmtNum(fees.stakedHype, 4)}${fees.stakingDiscount === null ? '' : ` · ${fmtNum(fees.stakingDiscount * 100, 2)}% discount`}\nNext: ${fees.nextStaking === null ? 'No next threshold reported' : `Above ${fmtNum(fees.nextStaking, 4)} HYPE${fees.nextStakingDiscount === null ? '' : ` · ${fmtNum(fees.nextStakingDiscount * 100, 2)}% discount`}`}`
  );
  function tone(r: Row) {
    if (!loaded) return '';
    if (r.id === 'inv-net-delta') return notionals.delta > 0 ? 'buy' : notionals.delta < 0 ? 'sell' : '';
    if (r.pnl) return Number.isFinite(s.uPnl) ? s.uPnl < 0 ? 'sell' : 'buy' : '';
    if (r.id === 'inv-available' && Number.isFinite(s.available)) return s.available > 0 ? 'buy' : s.available < 0 ? 'sell' : 'warn';
    const ratio = r.id === 'inv-ratio' ? s.ratio : r.id === 'inv-borrow' ? s.borrow : NaN;
    return Number.isFinite(ratio) ? ratio >= 1 ? 'sell' : ratio >= 0.8 ? 'warn' : ratio > 0 ? 'accent' : '' : '';
  }
  const agentDays = $derived(session.agent?.validUntil ? (session.agent.validUntil - Date.now()) / DAY : null);
  const balances = $derived(inventory.balances.filter((b) => b.total !== 0));

  const opening = (o: OpenOrder) => !o.reduceOnly && !o.isTrigger;
  const notional = (list: OpenOrder[]) => list.reduce((s, o) => s + o.limitPx * o.sz, 0);
  const size = (list: OpenOrder[]) => list.reduce((s, o) => s + o.sz, 0);

  const exposure = $derived.by(() => {
    const coins = new Set([...inventory.positions.filter((p) => p.szi !== 0).map((p) => p.coin), ...openOrders.list.map((o) => o.coin)]);
    return [...coins].sort().map((coin) => {
      const pos = inventory.positions.find((p) => p.coin === coin);
      const resting = openOrders.list.filter((o) => o.coin === coin && opening(o));
      const buys = resting.filter((o) => o.side === 'B');
      const sells = resting.filter((o) => o.side === 'A');
      const szi = pos?.szi ?? 0;
      const mark = pos && szi ? pos.positionValue / Math.abs(szi) : (meta.ctxs.get(coin)?.markPx ?? NaN);
      const [long, short] = [szi + size(buys), szi - size(sells)];
      const worst = Math.abs(long) >= Math.abs(short) ? long : short;
      return { coin, szi, posNtl: szi * mark, buyNtl: notional(buys), sellNtl: notional(sells), worstNtl: worst * mark };
    });
  });

  // Three significant figures, so both tables fit the 320px desktop column at 18px text and a 360px phone.
  const short = (n: number) => n !== 0 && Math.abs(n) < .001 ? Number(n.toPrecision(3)).toExponential() : n.toLocaleString('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
  const usd = (n: number) => (Number.isFinite(n) ? `${n < 0 ? '-' : ''}$${short(Math.abs(n))}` : fmtUsd(n));
  const amt = (n: number) => (Number.isFinite(n) ? short(n) : fmtNum(n, 4));
</script>

<div class="account-block" data-testid="account-block">
  <h4>Account</h4>
  {#if !viewAddress()}
    <p class="dim" data-testid="account-block-empty">Connect a wallet, or open with ?user=0x… to view an account read-only.</p>
  {:else}
    <div class="rows">
      {#each groups as group (group.title)}
        <section class="wide group" aria-label={group.title}>
          {#each group.rows as r (r.id)}
            {#if r.title}<abbr class="dim" title={r.title}>{r.label}</abbr>{:else}<span class="dim">{r.label}</span>{/if}
            <span class="v {tone(r)}" data-testid={r.id} class:key={group.title === 'Margin'}>{r.value}</span>
          {/each}
          {#if group.title === 'Margin'}<span class="dim">Margin Used</span><span class="v key" class:warn={loaded && inventory.marginUsed > 0} data-testid="inv-used">{loaded ? fmtUsd(inventory.marginUsed) : '—'}</span>{/if}
        </section>
      {/each}
      <section class="wide group" aria-label="Trading">
        <span class="dim">Agent</span>
        <span class="v" class:warn={agentDays !== null && agentDays < 7}>{agentDays === null ? '—' : `${Math.floor(agentDays)}d left`}</span>
        <span class="dim">Mode</span><span class="v">{inventory.abstraction || '—'}</span>
        <span class="dim">Orders</span><span class="v" class:warn={openOrders.list.length >= 900}>{openOrders.list.length} / 1000</span>
        <abbr class="dim" title={feeTitle}>Fees</abbr><span class="v" data-testid="inv-fees" data-help title="Perps taker / maker after staking and referral discounts. Staked HYPE is the fee-attributed amount, including confirmed staking links.">{feeTier}</span>
      </section>
    </div>

    <IdleYield />

    {#snippet fold(title: string, n: number, body: Snippet)}
      {#if phone.current}
        <details data-testid="fold-{title.toLowerCase()}"><summary>{title} ({n})</summary>{@render body()}</details>
      {:else}
        <div><h4>{title}</h4>{@render body()}</div>
      {/if}
    {/snippet}
    {#snippet exposureTable()}
      <table>
        <thead><tr><th>Coin</th><th>Position</th><th class="buy">Buys</th><th class="sell">Sells</th><th><abbr title="position if every resting order fills">Worst</abbr></th></tr></thead>
        <tbody>
          {#each exposure as x (x.coin)}
            <tr data-testid="exposure-row">
              <td><Coin coin={x.coin} /></td>
              <td class:buy={x.szi > 0} class:sell={x.szi < 0}>{usd(x.posNtl)}</td>
              <td class="buy">{usd(x.buyNtl)}</td>
              <td class="sell">{usd(x.sellNtl)}</td>
              <td class:buy={x.worstNtl > 0} class:sell={x.worstNtl < 0}>{usd(Math.abs(x.worstNtl))}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/snippet}
    {#snippet balanceTable()}
      <table class="balances">
        <thead><tr><th>Coin</th><th>Total</th><th>Hold</th><th>Free</th><th>USD Value</th></tr></thead>
        <tbody>
          {#each balances as b (b.coin)}
            <tr data-testid="balance-row">
              <td title={b.coin}>{b.coin}</td>
              <td data-help title={`Total: ${fmtNum(b.total, 8)} ${b.coin}`}>{amt(b.total)}</td>
              <td data-help title={`Hold: ${fmtNum(b.spotHold ?? b.hold, 8)} ${b.coin}`}>{amt(b.spotHold ?? b.hold)}</td>
              <td data-help title={`Free: ${fmtNum(b.total - (b.spotHold ?? b.hold), 8)} ${b.coin}`}>{amt(b.total - (b.spotHold ?? b.hold))}</td>
              <td data-help title={`USD value: ${Number.isFinite(usdValue(b)) ? `${usdValue(b) < 0 ? '-' : ''}$${fmtNum(Math.abs(usdValue(b)), 8)}` : '—'}`}>{usd(usdValue(b))}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/snippet}
    {#if exposure.length}{@render fold('Exposure', exposure.length, exposureTable)}{/if}
    {#if balances.length}{@render fold('Balances', balances.length, balanceTable)}{/if}
  {/if}
</div>

<style>
  .account-block {
    padding: 6px 8px; border-top: 1px solid var(--line);
    font-size: var(--fs); font-variant-numeric: tabular-nums; color: var(--text);
  }
  h4 { margin: 8px 0 4px; font-size: var(--fs); font-weight: 500; color: var(--bright); }
  .account-block > h4:first-child { margin-top: 0; }
  summary { margin: 8px 0 4px; color: var(--bright); cursor: pointer; }
  p { margin: 0; }
  .rows { display: grid; grid-column: 1 / -1; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 8px 12px; line-height: calc(var(--fs) * 1.25); }
  .group { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-content: start; gap: 3px 8px; }
  .group::before { content: attr(aria-label); grid-column: 1 / -1; padding-bottom: 3px; margin-bottom: 2px; border-bottom: 1px solid var(--line); color: var(--bright); font-weight: 500; }
  .v { text-align: right; white-space: nowrap; }
  .key { color: var(--bright); font-weight: 600; }
  .key.buy { color: var(--buy-text); }
  .key.sell { color: var(--sell-text); }
  .key.accent { color: var(--accent); }
  .key.warn { color: var(--warn); }
  abbr { cursor: default; text-decoration: underline dashed var(--faint); text-underline-offset: 3px; }
  .warn { color: var(--warn); }
  table { width: 100%; font-size: max(8px, calc(var(--fs) * 0.917)); }
  th, td { padding: 3px 2px; white-space: nowrap; }
  th:first-child, td:first-child { width: 100%; min-width: 5ch; max-width: 0; padding-left: 0; overflow: hidden; text-overflow: ellipsis; }
  th:not(:first-child), td:not(:first-child) { text-align: right; }
  .balances th:not(:first-child), .balances td:not(:first-child) { padding-left: 12px; }
  @media (max-width: 900px) { summary { margin: 6px 0 0; padding: 8px 0; } }
</style>
