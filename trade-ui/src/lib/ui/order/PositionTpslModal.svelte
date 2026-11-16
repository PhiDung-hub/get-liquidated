<script lang="ts">
  import { isTouch } from '$lib/ui/touch';
  import { untrack } from 'svelte';
  import { positionOf } from '$lib/account/inventory.svelte';
  import { feeFor } from '$lib/account/fees.svelte';
  import { isTrailing, openOrders } from '$lib/account/orders.svelte';
  import { asset, quoteOf, symOf } from '$lib/market/meta.svelte';
  import { addPositionExit, moveOrder } from '$lib/orders/execute';
  import { markOf } from '$lib/orders/size';
  import { fmtPx, fmtNum, fmtSz } from '$lib/util/format';
  import { net } from '$lib/transport/network';
  import { closing } from '$lib/orders/ticket.svelte';
  import { optPx } from '$lib/orders/tpsl';
  import { cutDecimals, cutPx, cutSz, roundPx, roundSz, tickSize } from '$lib/signing/wire';
  import { session, viewAddress } from '$lib/session/session.svelte';
  import { ui } from '../state.svelte';
  import Coin from '../Coin.svelte';
  import Field from './Field.svelte';
  import Menu, { menus } from './Menu.svelte';

  const props: { coin: string; focus: 'TP' | 'SL' } = $props();
  const { coin, focus } = untrack(() => ({ ...props }));
  const initial = untrack(() => positionOf(coin));
  const size = initial?.szi ?? 0;
  const entry = initial?.entryPx;
  const owner = untrack(() => viewAddress());
  const network = untrack(() => net.current);
  const long = size > 0;
  const t = asset(coin);
  const d = t.szDecimals;
  const exits = () => openOrders.list.filter((o) => o.coin === coin && o.isTrigger && !isTrailing(o) && o.side === (long ? 'A' : 'B'));
  const signature = () => JSON.stringify(exits().toSorted((a, b) => a.oid - b.oid));
  const original = untrack(() => signature());
  const existing = untrack(() => exits().filter((o) => o.reduceOnly));
  const kinds = ['TP', 'SL'] as const;
  const orders = kinds.map((kind) => existing.filter((o) => o.orderType.startsWith('Take') === (kind === 'TP')));
  let tp = $state(String(orders[0][0]?.triggerPx ?? ''));
  let sl = $state(String(orders[1][0]?.triggerPx ?? ''));
  type Unit = 'price' | 'percent' | 'amount';
  let units = $state<{ TP: Unit; SL: Unit }>({ TP: 'price', SL: 'price' });
  const inputModes = [{ value: 'price', label: 'Price' }, { value: 'percent', label: 'ROE %' }, { value: 'amount', label: 'PnL' }];
  const leverage = initial?.leverage.value ?? 0;
  const quantity = Math.abs(size);
  const quote = quoteOf(coin);
  let amount = $state('');
  /** A typed size places or resizes exits for that much of the position; blank keeps whole-position exits and each exit's own size. */
  function sizeOf(): number | null {
    if (!amount.trim()) return null;
    const v = roundSz(Number(amount), d);
    if (!(v > 0)) throw new Error('Invalid size.');
    if (v > quantity) throw new Error(`Size is more than the ${fmtSz(quantity, d)} position.`);
    return v;
  }
  const typedSize = () => { try { return sizeOf(); } catch { return null; } };
  const exitQuantity = (kind: 'TP' | 'SL') => Math.min(typedSize() ?? (orders[kind === 'TP' ? 0 : 1][0]?.sz || quantity), quantity);
  function trigger(kind: 'TP' | 'SL', text: string, unit = units[kind]): number | null {
    const value = unit === 'price' ? optPx(text, kind) : text.trim() ? Number(text) : null;
    if (value !== null && !Number.isFinite(value)) throw new Error(`Invalid ${kind} amount.`);
    if (value === null || unit === 'price') return value;
    if (!(entry && entry > 0 && quantity > 0 && leverage > 0)) throw new Error('Position basis unavailable.');
    const move = unit === 'percent' ? entry * value / (100 * leverage) : value / exitQuantity(kind);
    return entry + (long ? 1 : -1) * (kind === 'TP' ? 1 : -1) * move;
  }
  /** A trigger price follows the tick rule; ROE % and PnL keep 2 places and may be negative (a stop past entry). */
  const typed = (unit: Unit) => (v: string) => (unit === 'price' ? cutPx(v, t) : cutDecimals(v, 2, true));
  function changeUnit(kind: 'TP' | 'SL', unit: Unit) {
    const oldText = kind === 'TP' ? tp : sl;
    let text = oldText;
    try {
      const price = trigger(kind, oldText);
      if (price !== null && entry && entry > 0) {
        const move = (price - entry) * (long ? 1 : -1) * (kind === 'TP' ? 1 : -1);
        const value = unit === 'price' ? price : unit === 'percent' ? move / entry * leverage * 100 : move * exitQuantity(kind);
        text = unit === 'price' && !(value > 0) ? '' : typed(unit)(String(Number(value.toPrecision(12))));
      }
    } catch { text = ''; }
    units[kind] = unit;
    if (kind === 'TP') tp = text; else sl = text;
  }
  function estimate(kind: 'TP' | 'SL') {
    try {
      const price = trigger(kind, kind === 'TP' ? tp : sl);
      if (!(price && price > 0 && entry)) return null;
      const rounded = roundPx(price, t, !long);
      const order = orders[kind === 'TP' ? 0 : 1][0];
      const qty = typedSize() ?? (order?.sz || quantity);
      const rate = feeFor(coin).taker;
      const fee = Math.min(qty, quantity) * rounded * rate;
      const pnl = (rounded - entry) * (long ? 1 : -1) * Math.min(qty, quantity);
      return { price: rounded, fee, net: pnl - fee };
    } catch { return null; }
  }
  let busy = $state(false);
  let attempted = $state(false);
  let result = $state('');
  const p = $derived(positionOf(coin));
  const mark = $derived.by(() => { try { return markOf(coin); } catch { return NaN; } });
  const authorized = $derived(!!session.agent && session.holdsSigner && session.master === owner);
  const changed = () => !p || p.szi !== size || p.entryPx !== entry || viewAddress() !== owner || net.current !== network;

  function preview() {
    if (changed()) throw new Error('Position or account changed. Close and reopen to review it.');
    if (!openOrders.loaded) throw new Error('Waiting for open orders.');
    if (signature() !== original) throw new Error('Exit orders changed. Close and reopen to review them.');
    if (!(Number.isFinite(mark) && mark > 0)) throw new Error('No current mark price.');
    const size = sizeOf();
    return kinds.flatMap((kind, i) => {
      if (orders[i].length > 1) throw new Error(`Multiple ${kind} orders: manage them in Open orders.`);
      const typed = trigger(kind, i === 0 ? tp : sl);
      const order = orders[i][0];
      // A blank price leaves an exit as it is, unless a size is set for an exit that already has its own.
      if (typed === null && !(order?.sz && size !== null)) return [];
      if (order && !order.sz && size !== null) throw new Error(`${kind} covers the whole position: cancel it in Open orders to give it a size.`);
      const px = typed === null ? order!.triggerPx : roundPx(typed, t, !long);
      if (!(Number.isFinite(px) && px > 0)) throw new Error(`Invalid ${kind} price after rounding.`);
      const sz = size ?? order?.sz ?? 0;
      if (order && px === order.triggerPx && sz === order.sz) return [];
      const above = kind === 'TP' ? long : !long;
      if ((above ? px <= mark : px >= mark) || Math.abs(px - mark) < tickSize(mark, t))
        throw new Error(`${kind} must be ${above ? 'above' : 'below'} current mark (${mark}), by at least one tick.`);
      if (!order && exits().some((o) => o.orderType.startsWith('Take') === (kind === 'TP')))
        throw new Error(`An existing ${kind} order must be managed in Open orders.`);
      return [{ kind, px, order, sz }];
    });
  }
  const previewed = $derived.by(() => {
    try { return { changes: preview(), error: '' }; }
    catch (e) { return { changes: [], error: (e as Error).message }; }
  });

  const close = () => { if (!busy) ui.overlay = null; };
  async function confirm() {
    if (busy || attempted || !authorized) return;
    let changes;
    try { changes = preview(); }
    catch (e) { result = (e as Error).message; return; }
    if (!changes.length) return;
    busy = true;
    closing.n++;
    attempted = true;
    const outcomes: string[] = [];
    try {
      for (const change of changes) {
        if (changed() || !authorized) {
          outcomes.push(`${change.kind}: not sent because position or authorization changed.`);
          break;
        }
        // Recheck each targeted order after the preceding asynchronous exchange response.
        const current = exits().filter((o) => o.orderType.startsWith('Take') === (change.kind === 'TP'));
        if (change.order ? JSON.stringify(current) !== JSON.stringify([change.order]) : current.length > 0) {
          outcomes.push(`${change.kind}: not sent because exit orders changed.`);
          break;
        }
        const above = change.kind === 'TP' ? long : !long;
        if (!(Number.isFinite(mark) && mark > 0) || (above ? change.px <= mark : change.px >= mark) || Math.abs(change.px - mark) < tickSize(mark, t)) {
          outcomes.push(`${change.kind}: not sent because mark changed.`);
          break;
        }
        const ok = change.order ? await moveOrder(change.order, change.px, change.sz) : await addPositionExit(coin, change.px, change.sz || undefined);
        outcomes.push(`${change.kind}: ${ok ? 'accepted' : 'failed or unconfirmed; check Open orders'}.`);
        if (!ok) break;
      }
    } catch (e) {
      outcomes.push(`Stopped: ${(e as Error).message}. Check Open orders.`);
    } finally {
      result = `${outcomes.join(' ')} Review Open orders before reopening; any remaining changes were not sent.`;
      busy = false;
      closing.n--;
    }
  }
  $effect(() => {
    if (!isTouch()) document.querySelector<HTMLInputElement>(`[data-testid="position-${focus.toLowerCase()}"]`)?.focus();
    const key = (e: KeyboardEvent) => {
      if (menus.open) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  });
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" data-sheet aria-modal="true" aria-label="Position TP/SL" data-testid="position-tpsl-modal">
  <header><h3>Take Profit / Stop Loss</h3><span class="how" data-help data-testid="position-tpsl-how" title={`Exits are reduce-only trigger market orders. With Size blank a new exit covers the whole position and follows it as it changes; a size places it for that much only, and resizes an exit that already has its own size. Existing exits keep their order type. A blank price leaves an exit unchanged; remove exits in Open orders.\n\nPositive values mean profit for TP and loss for SL; negative values reverse that direction. ROE uses entry margin at ${leverage}× leverage. PnL targets are before fees; the preview subtracts closing fees. Funding and slippage are excluded.`}>How it works <span aria-hidden="true">ⓘ</span></span><button class="x" aria-label="Close TP/SL" disabled={busy} onclick={close}>✕</button></header>
  <div class="position"><Coin {coin} /><span class:buy={long} class:sell={!long}>{long ? 'Long' : 'Short'} {Math.abs(size)}</span></div>
  <div class="prices">
    <span class="dim">Entry price</span><span>{entry ? fmtPx(entry, d) : '—'}</span>
    <span class="dim">Mark price</span><span data-testid="position-tpsl-mark" data-price={Number.isFinite(mark) && mark > 0 ? mark : undefined}>{Number.isFinite(mark) && mark > 0 ? fmtPx(mark, d) : '—'}</span>
  </div>
  <Field label="Size" bind:value={amount} cut={(v) => cutSz(v, d)} testid="position-tpsl-size" placeholder="Whole position">
    {#snippet suffix()}{symOf(coin)}{/snippet}
  </Field>
  {#each kinds as kind, i}
    {@const est = estimate(kind)}
    <section class="leg">
      <div class="unit"><h4 class:buy={kind === 'TP'} class:sell={kind === 'SL'}>{kind === 'TP' ? 'Take Profit' : 'Stop Loss'}</h4>
        <Menu ariaLabel={`${kind} input mode`} testid={`position-${kind.toLowerCase()}-unit`} value={units[kind]} options={inputModes} onpick={(value) => changeUnit(kind, value as Unit)} />
      </div>
      <Field label={units[kind] === 'price' ? 'Trigger price' : units[kind] === 'percent' ? 'Return on margin' : kind === 'TP' ? 'Profit' : 'Loss'} short={units[kind] === 'price' ? 'Price' : units[kind] === 'percent' ? 'ROE' : undefined} bind:value={() => kind === 'TP' ? tp : sl, (v) => { if (kind === 'TP') tp = v; else sl = v; }} cut={typed(units[kind])} testid={`position-${kind.toLowerCase()}`} placeholder={orders[i].length ? 'Unchanged' : 'Not set'}>
        {#snippet suffix()}{units[kind] === 'percent' ? '%' : quote}{/snippet}
      </Field>
      {#if est}<div class="estimate" data-testid={`position-${kind.toLowerCase()}-estimate`}>
        {#if units[kind] !== 'price'}<span>Trigger price</span><span>{fmtPx(est.price, d)}</span>{/if}
        <span>Est. net PnL</span><span class:buy={est.net >= 0} class:sell={est.net < 0}>{fmtNum(est.net, 2)} {quote}</span>
        <span>Est. close fee</span><span>{fmtNum(est.fee, 4)} {quote}</span>
      </div>{/if}
    </section>
  {/each}
  {#if previewed.changes.length}<div class="changes">
    {#each previewed.changes as change}<div title={change.order ? `Modify order ${change.order.oid}` : 'Add trigger market'}><span>{change.kind} · {change.order ? 'Modify' : 'Market'} {long ? 'sell' : 'buy'}{change.sz ? ` ${fmtSz(change.sz, d)}` : ''}</span><span>{fmtPx(change.px, d)}</span></div>{/each}
  </div>{/if}
  {#if !authorized}<p class="dim">Enable trading to confirm. Preview is available read-only.</p>{/if}
  {#if !attempted && previewed.error}<p class="err" data-testid="position-tpsl-error">{previewed.error}</p>{/if}
  {#if result}<p role="status" data-testid="position-tpsl-result">{result}</p>{/if}
  <div class="actions">
    <button disabled={busy} onclick={close}>{attempted ? 'Close' : 'Cancel'}</button>
    <button class="go" data-testid="position-tpsl-confirm" aria-keyshortcuts="Enter" title="Enter to confirm" data-confirm-error={busy ? 'Submission in progress.' : attempted ? 'Already submitted. Review Open orders before reopening.' : !authorized ? 'Enable trading to confirm.' : previewed.error || 'Enter a take-profit or stop-loss price to confirm.'} disabled={busy || attempted || !authorized || !!previewed.error || !previewed.changes.length} onclick={confirm}>{busy ? 'Sending…' : 'Confirm TP/SL'}</button>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #0008; z-index: 20; }
  .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21; width: min(420px, calc(100vw - 32px)); padding: 20px; display: flex; flex-direction: column; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); max-height: 90dvh; overflow-y: auto; font-size: var(--fs); }
  header, .position, .unit, .changes > div { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  h3, h4, p { margin: 0; }
  h3 { font-size: max(8px, calc(var(--fs) * 1.286)); font-weight: 600; color: var(--bright); }
  h4 { font-size: inherit; font-weight: 500; }
  .x { background: none; color: var(--dim); padding: 4px; }
  .position { padding-bottom: 12px; border-bottom: 1px solid var(--line); font-weight: 500; }
  .prices { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; font-variant-numeric: tabular-nums; }
  .leg { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .estimate { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-size: max(8px, calc(var(--fs) * 0.917)); color: var(--dim); font-variant-numeric: tabular-nums; }
  .estimate > :nth-child(even) { text-align: right; }
  .dim, .how { color: var(--dim); }
  h3 { margin-right: auto; }
  .how { font-size: max(8px, calc(var(--fs) * 0.917)); cursor: help; white-space: nowrap; }
  .changes { display: grid; gap: 4px; padding-top: 10px; border-top: 1px solid var(--line); font-size: max(8px, calc(var(--fs) * 0.917)); }
  .err { color: var(--sell); }
  .actions { display: grid; grid-template-columns: 1fr 2fr; gap: 8px; }
  .actions button { padding: 11px 12px; border-radius: var(--radius); background: var(--surface); }
  .actions .go { background: var(--accent); color: var(--bg); font-weight: 600; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  @media (max-width: 900px) { .how { min-height: 32px; display: flex; align-items: center; } }
</style>
