<script lang="ts">
  import { renderSVG } from 'uqr';
  import { approvePhone, session } from '$lib/session/session.svelte';
  import { linkUrl, sealLink } from '$lib/session/link';
  import { ui } from './state.svelte';
  import Devices from './Devices.svelte';

  const SHOW_MS = 60_000;
  let pin = $state('');
  let pin2 = $state('');
  let error = $state('');
  let busy = $state(false);
  let qr = $state<{ url: string; svg: string } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(timer));

  const close = () => (ui.overlay = null);

  async function make(e: SubmitEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    error = !/^\d{6}$/.test(pin) ? 'PIN must be 6 digits' : pin !== pin2 ? 'PINs do not match' : '';
    if (error) return;
    busy = true;
    try {
      const url = linkUrl(await sealLink(await approvePhone(), pin));
      qr = { url, svg: renderSVG(url, { border: 4 }) };
      clearTimeout(timer);
      timer = setTimeout(() => (qr = null), SHOW_MS);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" aria-label="Devices" data-testid="link-modal">
  <button class="x" aria-label="Close" onclick={close}>✕</button>
  <Devices />
  {#if session.master && !session.linked}
    <h4>Link a new phone (replaces the current one)</h4>
    {#if qr}
      <p data-testid="link-signin">Open {location.origin} on your phone and sign in first, then scan.</p>
      <div class="qr" data-testid="link-qr" data-link={qr.url}>{@html qr.svg}</div>
      <p class="dim">Then type the PIN on the phone. The QR hides in 60 s and the link expires 10 minutes after it was made.</p>
      <button class="confirm" onclick={(e) => (e.currentTarget.blur(), (qr = null))}>Hide</button>
    {:else}
      <form onsubmit={make}>
        <p class="dim">Your wallet approves a new trading key for the phone. It can trade but never withdraw, Hyperliquid expires it in 90 days, and the next link replaces it.</p>
        {#if session.readOnlyReason}<p class="warn">{session.readOnlyReason}</p>{/if}
        <input type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="6-digit PIN" aria-label="PIN" data-testid="link-pin" bind:value={pin} />
        <input type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="PIN again" aria-label="PIN again" data-testid="link-pin2" bind:value={pin2} />
        {#if error}<p class="sell" data-testid="link-error">{error}</p>{/if}
        <button class="confirm" data-testid="link-make" disabled={busy || !session.holdsSigner}>{busy ? '…' : 'Show QR'}</button>
      </form>
    {/if}
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(440px, calc(100vw - 32px)); max-height: 80vh; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius);
  }
  form { display: flex; flex-direction: column; gap: 12px; }
  .x { position: absolute; top: 14px; right: 14px; padding: 4px; background: none; color: var(--dim); line-height: 1; }
  .x:hover { color: var(--bright); }
  h4 { margin: 8px 0 0; padding-top: 12px; border-top: 1px solid var(--line); font-size: var(--fs); font-weight: 500; color: var(--bright); }
  p { margin: 0; text-align: center; }
  .warn { color: var(--warn); }
  input { height: var(--ctl); padding: 0 12px; font-size: calc(var(--fs) * 1.333); letter-spacing: 0.3em; text-align: center; }
  .qr { width: min(320px, 100%); margin: 0 auto; }
  .qr :global(svg) { display: block; width: 100%; height: auto; }
  .confirm { height: calc(var(--fs) * 3.333); border-radius: var(--radius); background: var(--accent); color: var(--bg); }
  @media (max-width: 900px) {
    .modal { inset: auto 0 0; transform: none; width: 100%; max-height: 92vh; border-radius: var(--radius) var(--radius) 0 0; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
    input { font-size: max(16px, calc(var(--fs) * 1.333)); }
  }
</style>
