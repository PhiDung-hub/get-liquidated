<script lang="ts">
  import { openLink } from '$lib/session/link';
  import { adoptLinked } from '$lib/session/session.svelte';
  import { ui } from './state.svelte';

  let { blob }: { blob: string } = $props();
  let pin = $state('');
  let error = $state('');
  let busy = $state(false);

  async function go(e: SubmitEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    busy = true;
    error = '';
    try {
      await adoptLinked(await openLink(blob, pin));
    } catch (err) {
      error = (err as Error).message;
      busy = false;
    }
  }
</script>

<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<form class="modal" role="dialog" aria-label="Link this phone" data-testid="link-import" onsubmit={go}>
  <button type="button" class="x" aria-label="Close" onclick={() => (ui.overlay = null)}>✕</button>
  <h3>Link this phone</h3>
  <p class="dim">Type the 6-digit PIN set on the desktop.</p>
  <input type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN" placeholder="6-digit PIN" data-testid="link-import-pin" bind:value={pin} />
  {#if error}<p class="sell" data-testid="link-import-error">{error}</p>{/if}
  <button class="confirm" data-testid="link-import-go" disabled={busy || !/^\d{6}$/.test(pin)}>{busy ? '…' : 'Link'}</button>
</form>

<style>
  .scrim { position: fixed; inset: 0; background: #000b; z-index: 20; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(400px, calc(100vw - 32px)); padding: 24px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius);
  }
  .x { position: absolute; top: 14px; right: 14px; padding: 4px; background: none; color: var(--dim); line-height: 1; }
  .x:hover { color: var(--bright); }
  h3 { margin: 0; font-size: calc(var(--fs) * 1.667); font-weight: 400; color: var(--bright); text-align: center; }
  p { margin: 0; text-align: center; }
  input { height: var(--ctl); padding: 0 12px; font-size: calc(var(--fs) * 1.333); letter-spacing: 0.3em; text-align: center; }
  .confirm { height: calc(var(--fs) * 3.333); border-radius: var(--radius); background: var(--accent); color: var(--bg); }
  @media (max-width: 900px) {
    .modal { inset: auto 0 0; transform: none; width: 100%; max-height: 92vh; overflow-y: auto; border-radius: var(--radius) var(--radius) 0 0; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
    input { font-size: max(16px, calc(var(--fs) * 1.333)); }
  }
</style>
