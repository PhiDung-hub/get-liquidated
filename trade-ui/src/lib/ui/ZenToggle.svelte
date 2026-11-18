<script lang="ts">
  import { tick } from 'svelte';
  import { bindingsFor, keyLabel } from '$lib/hotkeys/keymap';
  import { session } from '$lib/session/session.svelte';
  import { inZen, setZen } from './zen';

  const shortcut = $derived(bindingsFor('zen').map(keyLabel).join(' / '));

  async function toggle(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
    const previous = event.currentTarget;
    if (event.detail) previous.blur();
    setZen(!inZen());
    if (event.detail) return;
    await tick();
    if (!previous.getClientRects().length) document.querySelector<HTMLButtonElement>('.zen-toggle')?.focus();
  }
</script>

<button class="ui-tab zen-toggle" aria-pressed={inZen()} disabled={!session.master} data-testid="zen-toggle" title={session.master ? `Chart-only view (${shortcut ? shortcut + ', ' : ''}Esc exits)` : 'Connect a wallet to use Zen Mode'} onclick={toggle}>Zen Mode</button>

<style>
  .zen-toggle { flex: none; padding: 4px 9px; font-weight: 600; color: var(--bright); background: color-mix(in srgb, var(--accent) 16%, var(--panel)); }
  .zen-toggle:is(:hover:enabled, [aria-pressed='true']) { color: var(--bright); background: color-mix(in srgb, var(--accent) 28%, var(--panel)); }
</style>
