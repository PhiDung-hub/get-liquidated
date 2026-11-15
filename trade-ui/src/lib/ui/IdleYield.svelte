<script lang="ts">
  import { inventory } from '$lib/account/inventory.svelte';
  import { meta } from '$lib/market/meta.svelte';
  import { viewAddress } from '$lib/session/session.svelte';
  import { info } from '$lib/transport/info';
  import { fmtNum } from '$lib/util/format';

  const REFRESH = 60_000;
  const DETAILS = 'Hyperliquid native lending. Variable simple APR, not APY. Estimates use the reported supplied balance, not total spot balances or perp withdrawable margin.';
  let root = $state<HTMLElement>();
  let rates = $state<Map<number, number> | null>(null);
  let supplied = $state<Map<number, number> | null>(null);
  let rateAt = $state(0);
  let supplyAt = $state(0);
  let now = $state(0);
  let loading = $state(true);
  let rateError = $state('');
  let supplyError = $state('');

  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid yield response');
    return value as Record<string, unknown>;
  }
  function nonnegative(value: unknown): number {
    if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) throw new Error('Invalid yield number');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error('Invalid yield number');
    return n;
  }
  function entries(value: unknown): [number, Record<string, unknown>][] {
    if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid yield asset list');
    const seen = new Set<number>();
    return value.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] < 0 || seen.has(entry[0])) throw new Error('Invalid yield asset');
      seen.add(entry[0]);
      return [entry[0], record(entry[1])];
    });
  }
  const parseRates = (value: unknown) => new Map(entries(value).map(([token, state]) => [token, nonnegative(state.supplyYearlyRate)]));
  const parseSupply = (value: unknown) => new Map(entries(record(value).tokenToState).map(([token, state]) => {
    if (state.supply === undefined) return [token, 0];
    const supply = record(state.supply);
    nonnegative(supply.basis);
    return [token, nonnegative(supply.value)];
  }));
  const nameOf = (token: number) => token === 0 ? 'USDC' : meta.spotTokens[token] ?? `Token ${token}`;
  const rows = $derived.by(() => {
    const tokens = new Set([0]);
    for (const [token] of rates ?? []) {
      if (inventory.balances.some((b) => b.coin === nameOf(token) && (b.total > 0 || b.supplied > 0))) tokens.add(token);
    }
    for (const [token, value] of supplied ?? []) if (value > 0) tokens.add(token);
    return [...tokens].sort((a, b) => a - b).map((token) => {
      const apr = rates?.get(token);
      const amount = supplied ? supplied.get(token) ?? 0 : null;
      const daily = apr !== undefined && amount !== null ? amount * apr / 365 : null;
      return { token, name: nameOf(token), apr, amount, daily: daily !== null && Number.isFinite(daily) ? daily : null };
    });
  });
  const stale = $derived((rateAt > 0 && now - rateAt >= REFRESH * 1.5) || (supplyAt > 0 && now - supplyAt >= REFRESH * 1.5) || (!!rateAt && !!rateError) || (!!supplyAt && !!supplyError));

  $effect(() => {
    const address = viewAddress();
    const element = root;
    rates = null;
    supplied = null;
    rateAt = supplyAt = 0;
    rateError = supplyError = '';
    loading = true;
    if (!address || !element) return;
    let cancelled = false;
    let pending = false;
    let inView = false;
    let lastAttempt = 0;
    async function refresh() {
      now = Date.now();
      if (cancelled || pending || document.hidden || !inView || Date.now() - lastAttempt < REFRESH) return;
      pending = true;
      lastAttempt = Date.now();
      const results = await Promise.allSettled([
        info<unknown>({ type: 'allBorrowLendReserveStates' }).then(parseRates),
        info<unknown>({ type: 'borrowLendUserState', user: address }).then(parseSupply)
      ]);
      if (!cancelled) {
        const [reserve, user] = results;
        now = Date.now();
        if (reserve.status === 'fulfilled') { rates = reserve.value; rateAt = now; rateError = ''; }
        else rateError = 'Supply APR unavailable. ' + (reserve.reason instanceof Error ? reserve.reason.message : 'Yield request failed.');
        if (user.status === 'fulfilled') { supplied = user.value; supplyAt = now; supplyError = ''; }
        else supplyError = 'Supplied balance unavailable. ' + (user.reason instanceof Error ? user.reason.message : 'Yield request failed.');
        loading = false;
      }
      pending = false;
    }
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; void refresh(); });
    observer.observe(element);
    const wake = () => void refresh();
    document.addEventListener('visibilitychange', wake);
    const timer = setInterval(wake, REFRESH);
    return () => {
      cancelled = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', wake);
      clearInterval(timer);
    };
  });
</script>

<section bind:this={root} data-testid="idle-yield" aria-label="Idle-asset yield">
  <h4>Idle-asset yield</h4>
  {#if rateAt}<p class="dim note" data-testid="idle-yield-updated" title="Hyperliquid native lending supply rates">Updated <time datetime={new Date(rateAt).toISOString()}>{new Date(rateAt).toLocaleTimeString()}</time></p>{/if}
  {#if loading}<p class="dim" data-testid="idle-yield-loading">Loading current supply rates…</p>{/if}
  {#if stale}<p class="warn" data-testid="idle-yield-stale">Stale · showing last available values</p>{/if}
  {#if rateError || supplyError}<p class="warn" data-testid="idle-yield-error" role="status">{rateError} {supplyError} Retries while visible every 60s.</p>{/if}
  <table>
    <thead><tr><th>Asset</th><th><abbr title={DETAILS}>Supply APR</abbr></th><th>Supplied</th></tr></thead>
    <tbody>
      {#each rows as row (row.token)}
        <tr data-testid="idle-yield-row" data-token={row.token}>
          <td>{row.name}</td>
          <td data-testid="idle-yield-apr">{row.apr === undefined ? '—' : `${fmtNum(row.apr * 100, 2)}%`}</td>
          <td data-testid="idle-yield-supplied">{row.amount === null ? '—' : fmtNum(row.amount, 4)}</td>
        </tr>
        {#if row.amount !== null && row.amount > 0 && row.daily !== null}
          <tr><td class="estimate" colspan="3" data-testid="idle-yield-daily" data-help title={DETAILS}><span class="dim">Est.</span> <strong class="num buy">{fmtNum(row.daily, 6)}</strong> <span class="dim">{row.name}/day</span></td></tr>
        {/if}
      {/each}
    </tbody>
  </table>
</section>

<style>
  section { margin-top: 8px; }
  h4 { margin: 0 0 4px; font-size: var(--fs); font-weight: 500; color: var(--bright); }
  p { margin: 3px 0; line-height: 1.4; }
  table { width: 100%; font-size: max(8px, calc(var(--fs) * 0.917)); font-variant-numeric: tabular-nums; }
  th, td { padding: 3px 0; text-align: right; }
  th:first-child, td:first-child { text-align: left; min-width: 5ch; }
  td.estimate { text-align: right; white-space: normal; overflow-wrap: anywhere; }
  .estimate strong { font-weight: 600; }
  abbr { cursor: help; text-decoration: underline dotted var(--dim); text-underline-offset: 3px; }
  .note { font-size: max(8px, calc(var(--fs) * 0.917)); }
  .warn { color: var(--warn); overflow-wrap: anywhere; }
</style>
