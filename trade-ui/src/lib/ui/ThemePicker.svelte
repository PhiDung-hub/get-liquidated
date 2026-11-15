<script lang="ts">
  import { THEMES, type ThemeId } from '$lib/settings/themes';
  let { value, onchange }: { value: string; onchange: (value: ThemeId) => void } = $props();
  let open = $state(false), top = $state(48), root: HTMLDetailsElement;
  const current = $derived(THEMES.find(theme => theme.id === value) ?? THEMES[0]);
  function place() { if (root?.open) top = root.querySelector('summary')!.getBoundingClientRect().bottom + 6; }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); open = false; root.querySelector('summary')?.focus(); }
  }
  function choose(id: ThemeId) { onchange(id); open = false; root.querySelector('summary')?.focus(); }
</script>

<svelte:window onkeydown={key} onresize={place} onpointerdown={e => { if (open && e.target instanceof Node && !root.contains(e.target)) open = false; }} />
<details class="theme" bind:this={root} bind:open ontoggle={place} style:--theme-top="{top}px">
  <summary aria-label={`Theme: ${current.name}`} title={`Theme: ${current.name}`} data-testid="navbar-theme">
    <span class="swatches" aria-hidden="true">{#each current.colors as color}<i style:background={color}></i>{/each}</span>
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </summary>
  {#if open}<div class="ui-menu theme-menu" role="group" aria-label="Theme choices">
    {#each THEMES as theme}<button class="ui-tab" aria-pressed={value === theme.id} onclick={() => choose(theme.id)}>
      <span class="swatches" aria-hidden="true">{#each theme.colors as color}<i style:background={color}></i>{/each}</span>
      <span>{theme.name}</span><span class="check" aria-hidden="true">{value === theme.id ? '✓' : ''}</span>
    </button>{/each}
  </div>{/if}
</details>

<style>
  summary { display: flex; align-items: center; gap: 7px; padding: 6px; cursor: pointer; list-style: none; border: 1px solid var(--line); border-radius: var(--radius); }
  summary::-webkit-details-marker { display: none; }
  .swatches { display: flex; flex: none; }
  .swatches i { display: block; width: 12px; height: 16px; border: 1px solid var(--line); }
  .swatches i:first-child { border-radius: var(--radius) 0 0 var(--radius); }
  .swatches i:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
  .theme-menu { position: fixed; top: var(--theme-top); right: 12px; max-width: calc(100vw - 24px); max-height: calc(100dvh - var(--theme-top) - 12px); overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 5px; z-index: 50; }
  .theme-menu button { display: flex; align-items: center; gap: 10px; width: 100%; background: none; text-align: left; padding: 9px; }
  .theme-menu button:hover, .theme-menu button[aria-pressed='true'] { background: var(--surface); color: var(--selected-text); }
  .check { margin-left: auto; min-width: 1em; color: var(--accent); }
</style>
