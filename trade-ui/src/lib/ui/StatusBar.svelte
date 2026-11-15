<script lang="ts">
  import { socket } from '$lib/transport/ws.svelte';
  import { net } from '$lib/transport/network';
  import { session } from '$lib/session/session.svelte';
  import { inventory } from '$lib/account/inventory.svelte';
  import { openOrders } from '$lib/account/orders.svelte';
  import { ticket } from '$lib/orders/ticket.svelte';
  import { armed } from '$lib/hotkeys/armed.svelte';
  import { scaleFromTicket } from '$lib/hotkeys/actions';
  import { market } from '$lib/market/market.svelte';
  import { symOf } from '$lib/market/meta.svelte';
  import { HOTKEY_TYPES, settings, type HotkeyType, type Sizing } from '$lib/settings/settings.svelte';
  import { fmtCompact } from '$lib/util/format';
  import { version } from '$app/environment';
  import { sideOf } from './toast.svelte';

  const DAY = 86_400_000;
  const agentDays = $derived(session.agent?.validUntil ? (session.agent.validUntil - Date.now()) / DAY : null);
  const remaining = $derived(inventory.rate ? inventory.rate.cap - inventory.rate.used : NaN);
  const budget = $derived(Number.isFinite(remaining) ? remaining : null);

  const SHORT: Record<HotkeyType, string> = { market: 'mkt', alo: 'alo', chase: 'chase', scale: 'scale' };
  /** A coin size names its coin only when that is not the market shown. */
  const short = (s: Sizing) =>
    s.unit === 'usd' ? `$${fmtCompact(s.value).toLowerCase()}` : s.unit === 'coin' ? `${s.value}${s.coin && s.coin !== market.coin ? ' ' + symOf(s.coin) : ''}` : `${s.value}%${s.basis === 'position' ? ' pos' : ''}`;
  // Scale is the last type, so its ticket side closes the armed line.
  const side = $derived(scaleFromTicket(ticket.isBuy) ? sideOf(ticket.isBuy) : undefined);
  const sizes = $derived(HOTKEY_TYPES.map((t) => (t === 'scale' && side ? 'ticket' : short(settings.hotkeySizes[t]))));
  const labelled = $derived(sizes.every((v) => v === sizes[0]) ? [`all ${sizes[0]}`] : HOTKEY_TYPES.map((t, i) => `${SHORT[t]} ${sizes[i]}`));
  const armedText = $derived(['ARMED', symOf(market.coin), ...labelled].join(' · '));

  /** Shrinks the armed line's font until it fits one line of the footer. */
  function fitLine(el: HTMLElement) {
    void [armedText, side, settings.display.fs, settings.display.theme];
    const parent = el.parentElement!;
    const range = document.createRange();
    const fit = () => {
      el.style.fontSize = '';
      el.style.whiteSpace = '';
      const f = getComputedStyle(parent), e = getComputedStyle(el);
      const pad = parseFloat(e.paddingLeft) + parseFloat(e.paddingRight);
      const room = parent.clientWidth - parseFloat(f.paddingLeft) - parseFloat(f.paddingRight) - pad;
      if (room <= 0) return;
      range.selectNodeContents(el);
      const width = range.getBoundingClientRect().width;
      const base = parseFloat(e.fontSize);
      if (width > room) {
        el.style.fontSize = `${Math.max(8, Math.floor(base * room * 10 / width) / 10)}px`;
        if (width * 8 / base > room) el.style.whiteSpace = 'normal';
      }
    };
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    document.fonts.addEventListener('loadingdone', fit);
    return () => { ro.disconnect(); document.fonts.removeEventListener('loadingdone', fit); };
  }
</script>

<footer data-testid="status">
  {#if armed.on}
    <span class="armed" data-testid="status-armed" {@attach fitLine}>{armedText}{#if side}{' '}(<span class={side}>{side}</span>){/if}</span>
  {:else}
    <span class="seg" title="Order hotkeys are disarmed. The arm/disarm shortcut is configurable in Settings."><span class="label">Keys</span>{' '}<b data-testid="status-disarmed">disarmed</b></span>
  {/if}
  <span class="seg" title="Hyperliquid WebSocket connection"><span class="label">WS</span>{' '}<span data-testid="status-socket"><i class:ok={socket.state === 'open'}></i><b>{socket.state}</b></span></span>
  {#if socket.state === 'open'}<span class="seg" title="WebSocket ping round-trip time; not order execution latency"><span class="label">Ping</span>{' '}<b>{socket.rtt}</b>{' '}<span class="unit">ms</span></span>{/if}
  <span class="seg"><span class="label">Network</span>{' '}<b>{net.current}</b></span>
  {#if socket.limited}<span class="seg warn" data-testid="status-limited" title="Hyperliquid is rate limiting this IP (429): data loads slower and fills in by itself">HL rate limit · loading slower</span>{/if}
  {#if session.readOnlyReason}<span class="seg warn" data-testid="status-readonly">{session.readOnlyReason}</span>{/if}
  {#if ticket.reduceOnly}<span class="seg warn" data-testid="status-reduce">reduce-only</span>{/if}
  {#if budget !== null}<span class="seg" class:warn={budget < 500} data-testid="status-budget" title="{budget.toLocaleString()} address-based action requests remaining. This allowance grows with traded volume; it is separate from IP rate limits."><span class="label">Requests</span>{' '}<b>{fmtCompact(budget)}</b>{' '}<span class="unit">left</span></span>{/if}
  <span class="seg" class:warn={openOrders.list.length >= 900} data-testid="status-orders" title="Open orders / base limit. Hyperliquid can allow more orders as traded volume grows."><span class="label">Orders</span>{' '}<b>{openOrders.list.length}</b>{' '}<span class="unit">/ 1,000</span></span>
  {#if agentDays !== null}<span class="seg" data-testid="status-agent" class:warn={agentDays < 7} title="Trading agent authorization expires in {Math.floor(agentDays)} days"><span class="label">agent</span>{' '}<span><b>{Math.floor(agentDays)}</b><span class="unit">d</span></span></span>{/if}
  <span class="seg dim version" data-testid="status-version" title={version}>v{version.split(' · ')[0]}</span>
</footer>

<style>
  footer { display: flex; align-items: center; min-width: 0; max-width: 100%; contain: inline-size; padding: 3px 12px; border-top: 1px solid var(--line); font: max(8px, calc(var(--fs) * 0.917)) var(--mono); font-variant-ligatures: none; color: var(--dim); overflow-x: auto; white-space: nowrap; }
  .seg { display: inline-flex; flex: none; align-items: center; gap: 4px; padding: 0 6px; }
  .seg:not(:first-child) { border-left: 1px solid var(--line); }
  .seg:first-child { padding-left: 0; }
  b { color: var(--bright); font-weight: 500; font-variant-numeric: tabular-nums; }
  .label, .unit { color: var(--dim); }
  .unit { font-size: max(8px, 0.92em); }
  i { display: inline-block; width: 7px; height: 7px; border-radius: var(--radius); background: var(--sell); margin-right: 5px; }
  i.ok { background: var(--buy); }
  .warn, .warn b, .warn .label, .warn .unit { color: var(--warn); }
  .version { margin-left: auto; }
  @media (max-width: 900px) { footer { flex-wrap: wrap; row-gap: 4px; padding: 6px 0; } .seg:first-child { padding-left: 6px; } [data-testid='status-orders'], [data-testid='status-agent'] { display: none; } }
  .armed { flex-shrink: 0; min-width: 0; max-width: 100%; background: var(--warn); color: var(--bg); font-weight: 700; padding: 0 8px; white-space: nowrap; }
  .armed > :global(span) { padding: 0 3px; background: var(--bg); }
</style>
