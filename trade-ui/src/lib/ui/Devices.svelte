<script lang="ts">
  import { untrack } from 'svelte';
  import { info } from '$lib/transport/info';
  import { AGENT_NAME, PHONE_AGENT_NAME, revokeDevice, session, viewAddress, type ExtraAgent } from '$lib/session/session.svelte';
  import { fmtAddr } from '$lib/util/format';
  import { toast } from './toast.svelte';

  const DAY = 86_400_000;
  const ZERO = /^0x0{40}$/;
  let agents = $state<ExtraAgent[]>([]);
  let error = $state('');
  let confirming = $state('');
  let revoking = $state(false);

  async function refresh() {
    const user = viewAddress();
    if (!user) return;
    try {
      const list = await info<ExtraAgent[]>({ type: 'extraAgents', user });
      if (!Array.isArray(list)) throw new Error('Hyperliquid sent no device list');
      if (user === viewAddress()) [agents, error] = [list.filter((d) => typeof d?.address === 'string'), ''];
    } catch (e) {
      if (user === viewAddress()) error = `devices failed to load: ${(e as Error).message}`;
    }
  }
  $effect(() => {
    void viewAddress();
    agents = [];
    confirming = '';
    untrack(refresh);
  });

  const rows = $derived(
    agents.filter((d) => (d.name === AGENT_NAME || d.name === PHONE_AGENT_NAME) && /^0x[0-9a-f]{40}$/i.test(d.address) && !ZERO.test(d.address.toLowerCase()))
  );
  const mine = (d: ExtraAgent) => d.address.toLowerCase() === session.agent?.address;
  const own = $derived(rows.find(mine));
  const source = $derived(!!session.master && !session.linked && session.holdsSigner);
  const daysLeft = (d: ExtraAgent) => (d.validUntil === null ? null : (d.validUntil - Date.now()) / DAY);

  async function revoke(e: MouseEvent, device: ExtraAgent) {
    (e.currentTarget as HTMLElement).blur();
    revoking = true;
    try {
      await revokeDevice(device);
      confirming = '';
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      revoking = false;
    }
  }
</script>

<svelte:document onvisibilitychange={() => document.visibilityState === 'visible' && refresh()} />

<div class="devices" data-testid="devices-list">
  <h4>Devices</h4>
  {#if error}<p class="sell" data-testid="devices-error">{error}</p>{/if}
  {#if !rows.length && !error}<p class="dim" data-testid="devices-empty">No devices from this app are approved for this account.</p>{/if}
  <ul>
    {#each rows as d (d.address)}
      {@const days = daysLeft(d)}
      <li data-testid="device-row" data-name={d.name} data-mine={mine(d)}>
        <span class="name">{d.name}{#if mine(d)}<b class="me" data-testid="device-mine">· this {session.linked ? 'phone' : 'device'}</b>{/if}</span>
        <span class="num" data-testid="device-days" class:warn={days !== null && days < 7}>{days === null ? 'no expiry' : `${Math.max(0, Math.floor(days))}d left`}</span>
        <span class="num dim">{fmtAddr(d.address)}</span>
        {#if source && !mine(d)}
          <span class="act">
            {#if confirming === d.address}
              <button class="danger" data-testid="device-revoke-confirm" disabled={revoking} onclick={(e) => revoke(e, d)}>{revoking ? 'Revoking…' : 'Revoke trading key'}</button>
              <button data-testid="device-revoke-cancel" disabled={revoking} onclick={(e) => (e.currentTarget.blur(), (confirming = ''))}>Cancel</button>
            {:else}
              <button class="danger" data-testid="device-revoke" disabled={revoking} onclick={(e) => (e.currentTarget.blur(), (confirming = d.address))}>Remove</button>
            {/if}
          </span>
          {#if confirming === d.address}<p class="dim wide" data-testid="device-revoke-ask">Revoke the trading key for {d.name} ({fmtAddr(d.address)})? Hyperliquid revokes this agent by name. Your wallet will show ApproveAgent with agentAddress set to 0x000…000; that zero address removes this approval. This does not cancel existing orders or close positions.</p>{/if}
        {/if}
      </li>
    {/each}
  </ul>
  {#if session.linked && own?.validUntil}
    <p class="dim" data-testid="device-hint">The key stays approved until {new Date(own.validUntil).toISOString().slice(0, 10)}. Revoke it on the desktop under Devices.</p>
  {/if}
</div>

<style>
  .devices { display: flex; flex-direction: column; gap: 8px; font-variant-numeric: tabular-nums; }
  h4 { margin: 0; font-size: var(--fs); font-weight: 500; color: var(--bright); }
  p { margin: 0; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
  li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; align-items: center; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bright); }
  .me { margin-left: 0.5ch; font-weight: 400; color: var(--accent); }
  .num:not(.dim) { text-align: right; }
  .act { display: flex; gap: 6px; justify-content: flex-end; }
  .act button { padding: 2px 8px; }
  .danger { color: var(--sell); }
  .wide { grid-column: 1 / -1; }
  .warn { color: var(--warn); }
</style>
