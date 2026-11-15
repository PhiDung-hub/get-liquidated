<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import { session, connectWallet, disconnect, enableTrading, inFlight, viewAddress } from '$lib/session/session.svelte';
  import { toast } from './toast.svelte';
  import { ui } from './state.svelte';
  import AccountSwitch from './AccountSwitch.svelte';
  import Wallet, { who } from './Wallet.svelte';

  const phone = new MediaQuery('max-width: 900px');
  const run = (f: () => Promise<void>) => (e: MouseEvent) => {
    (e.currentTarget as HTMLElement).blur();
    f().catch((err) => toast.error(err.message));
  };
  function unlink(e: MouseEvent) {
    (e.currentTarget as HTMLElement).blur();
    if (inFlight()) return toast.error('wait for chases, queued keys and orders in flight before disconnecting');
    disconnect().catch((err) => toast.error(err.message));
  }
</script>

<div class="conn" data-testid="connection">
  {#if phone.current}
    <div class="addr" data-testid="conn-addr">{#if viewAddress()}<Wallet address={viewAddress()!} text>{@render who(viewAddress()!)}</Wallet>{:else}No account{/if}</div>
  {:else if !session.master && session.watch}
    <Wallet address={session.watch}>{@render who(session.watch)}</Wallet>
  {/if}
  {#if !session.master}
    <button onclick={run(connectWallet)}>Connect</button>
  {:else if !session.agent && session.holdsSigner && !session.linked}
    {#if !phone.current}<AccountSwitch />{/if}<button class="accent" title="Needs your wallet unlocked on this account" onclick={run(enableTrading)}>Enable trading</button>
  {:else if !phone.current}
    <AccountSwitch />
  {/if}
  {#if session.linked}
    <button data-testid="disconnect" onclick={unlink}>Disconnect</button>
  {:else if session.master || (session.watch && !phone.current)}
    <button data-testid="devices" title="Trading keys approved for this account; link a phone (QR + PIN)" onclick={(e) => (e.currentTarget.blur(), (ui.overlay = 'link'))}>Devices</button>
  {/if}
  {#if phone.current && (!session.master || session.linked)}
    <button data-testid="link-scan" aria-label="Scan link" title="Scan link: read the desktop's Link phone QR" onclick={(e) => (e.currentTarget.blur(), (ui.overlay = 'linkScan'))}>
      <svg viewBox="0 0 24 24" width="1.2em" height="1.2em" aria-hidden="true"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 12h10" fill="none" stroke="currentColor" stroke-width="2" /></svg>
    </button>
  {/if}
</div>

<style>
  .conn { display: contents; }
  .accent { background: var(--accent); color: var(--bg); font-weight: 600; }
  @media (max-width: 900px) {
    .conn { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px; border-bottom: 1px solid var(--line); }
    .addr { flex: 1 0 100%; color: var(--bright); }
    .addr > :global(.wallet) { display: flex; font-size: calc(var(--fs) * 1.167); }
    .addr :global(.who) { flex: 1; display: grid; grid-template: 'id addr addr' 'id name state' / auto minmax(0, max-content) 1fr; column-gap: 0; white-space: nowrap; }
    .addr :global(.who > *) { margin-right: 8px; }
    .addr :global(.id) { grid-area: id; width: 2em; height: 2em; }
    .addr :global(.who .addr) { grid-area: addr; font-size: var(--fs); }
    .addr :global(.name) { grid-area: name; min-width: 0; font-size: max(8px, calc(var(--fs) * 0.917)); }
    .addr :global(.state) { grid-area: state; font-size: max(8px, calc(var(--fs) * 0.917)); white-space: normal; }
  }
</style>
