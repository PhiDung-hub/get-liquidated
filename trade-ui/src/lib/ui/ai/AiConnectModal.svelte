<script lang="ts">
  import { agent } from '$lib/agent/agent.svelte';
  import { ui } from '$lib/ui/state.svelte';
  import ConnectAi from './ConnectAi.svelte';
  import Connection from './Connection.svelte';

  const close = () => (ui.overlay = null);
</script>

<div class="scrim" role="presentation" onclick={close}></div>
<div class="modal" role="dialog" aria-modal="true" aria-label="AI connection" data-testid="ai-connect-modal">
  <header>
    <h3>AI connection</h3>
    <button class="x" aria-label="Close" onclick={close}>✕</button>
  </header>
  {#if agent.address}<Connection />{/if}
  <ConnectAi />
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 20; background: #000b; }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21;
    width: min(640px, calc(100vw - 32px)); max-height: 86vh; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 12px;
    background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius); box-shadow: 0 20px 60px #0008;
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  h3 { margin: 0; color: var(--bright); font-size: calc(var(--fs) * 1.25); }
  .x { padding: 4px 6px; background: none; color: var(--dim); line-height: 1; }
  .x:hover { color: var(--bright); }
</style>
