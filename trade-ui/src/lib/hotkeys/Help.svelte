<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ACTIONS, GROUPS, SIDE, bindingsFor, keyLabel, type ActionDef, type Group } from './keymap';
  import Sided from '$lib/ui/Sided.svelte';
  import { armed } from './armed.svelte';
  import { openSettings, ui } from '$lib/ui/state.svelte';

  const GATE = { A: 'always', R: 'works disarmed', X: 'armed only' } as const;
  let { activate }: { activate: (a: ActionDef) => boolean } = $props();
  // Handled by the chart itself, not the keymap: the dispatcher drops Ctrl, and mouse gestures have no binding.
  const FIXED = [['Shift+drag', 'Measure (also 📏)'], ['Del / Backspace', 'Delete selected drawing'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo drawing']];
  let query = $state('');
  let group = $state<Group>('Navigation');
  let selected = $state(0);
  let input: HTMLInputElement;
  const search = $derived.by(() => {
    try {
      return { pattern: new RegExp(query, 'i'), error: '' };
    } catch {
      return { pattern: null, error: 'Invalid regular expression. Check brackets and parentheses.' };
    }
  });
  const matches = (text: string) => search.pattern?.test(text) ?? false;
  const migrationMatch = $derived(matches('Move from Hyperliquid migration import preferences'));
  const groups = $derived(GROUPS.map((name) => ({
    name,
    actions: ACTIONS.filter((a) => a.group === name && matches(`${a.label} ${a.id} ${name} ${bindingsFor(a.id).map(keyLabel).join(' / ')} ${GATE[a.gate]}`)),
    fixed: (name === 'Chart' ? FIXED : name === 'Navigation' ? [[';r', 'App function regex search']] : []).filter((row) => matches(row.join(' ') + ' ' + name))
  })).filter((g) => g.actions.length || g.fixed.length));
  const visibleGroups = $derived(query.trim() ? groups : groups.filter((g) => g.name === group));
  const choices = $derived(visibleGroups.flatMap((g) => g.actions));
  function selectGroup(next: Group) {
    group = next;
    document.getElementById('help-group-panel')?.scrollTo(0, 0);
  }
  function groupKey(e: KeyboardEvent) {
    const index = GROUPS.indexOf(group);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? GROUPS.length - 1 : e.key === 'ArrowRight' ? (index + 1) % GROUPS.length : e.key === 'ArrowLeft' ? (index + GROUPS.length - 1) % GROUPS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    selectGroup(GROUPS[next]);
    document.getElementById(`help-group-${group}`)?.focus();
  }
  const active = $derived(choices[selected]);
  $effect(() => { query; selected = 0; });
  function choose(a: ActionDef) {
    input.blur();
    ui.overlay = null;
    if (!activate(a)) {
      ui.overlay = 'help';
      input.focus();
    }
  }
  async function navigate(e: KeyboardEvent) {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || !query.trim()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      selected = choices.length ? (selected + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length : 0;
      await tick();
      document.getElementById(`command-${active?.id}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const pick = active;
      if (pick) choose(pick);
    }
  }
  onMount(() => input?.focus());
</script>

<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<div class="help" role="dialog" aria-label="Hotkeys" data-testid="help">
  <header>
    <h3>Hotkeys</h3>
    <span class:armed={armed.on}>{armed.on ? 'ARMED' : 'disarmed'}</span>
    <button class="push" onclick={() => openSettings('hotkeys')}>Settings</button>
    <button data-testid="help-close" onclick={() => (ui.overlay = null)}>Close</button>
  </header>
  <label class="search" for="function-search">Search app functions · regex · ;r</label>
  <input id="function-search" data-testid="function-search" bind:this={input} bind:value={query} onkeydown={navigate} maxlength="160" placeholder="e.g. market.*(buy|sell)" role="combobox" aria-expanded="true" aria-controls="function-results" aria-activedescendant={query.trim() && active ? `command-${active.id}` : undefined} aria-invalid={!!search.error} aria-describedby="function-search-status" spellcheck="false" />
  <p id="function-search-status" class="dim" role="status">{search.error || (groups.length || migrationMatch ? query.trim() ? 'Searching all groups · ↑/↓ select · Enter runs · Esc closes' : 'Choose a group, or search all functions' : 'No matching functions.')}</p>
  {#if !query.trim()}
    <div class="group-tabs" role="tablist" aria-label="Hotkey groups">
      {#each GROUPS as name}<button id="help-group-{name}" role="tab" aria-selected={group === name} aria-controls="help-group-panel" tabindex={group === name ? 0 : -1} data-testid="help-group-{name}" onclick={() => selectGroup(name)} onkeydown={groupKey}>{name}</button>{/each}
    </div>
  {/if}
  <div class="results" id="help-group-panel" data-testid="help-group-panel" role={query.trim() ? undefined : 'tabpanel'} aria-labelledby={query.trim() ? undefined : `help-group-${group}`}>
    <div class="cols" id="function-results" role="listbox" aria-label="App functions">
      {#each visibleGroups as g}
        <section>
          <h4>{g.name}</h4>
          {#each g.actions as a (a.id)}
            <button class="row" class:selected={!!query.trim() && active?.id === a.id} id="command-{a.id}" role="option" aria-selected={!!query.trim() && active?.id === a.id} data-testid="help-row" onclick={() => choose(a)}>
              <span class="keys {SIDE[a.id] ?? ''}">{bindingsFor(a.id).map(keyLabel).join(' / ') || '—'}{a.double ? ' 2×' : ''}</span>
              <span><Sided text={a.label} side={SIDE[a.id]} /></span>
              <span class="dim gate">{GATE[a.gate]}</span>
            </button>
          {/each}
          {#each g.fixed as [keys, label]}
            <div class="row" data-testid="help-row"><span class="keys">{keys}</span><span>{label}</span><span class="dim gate">fixed</span></div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
  <footer>
    {#if migrationMatch}<button onclick={() => (ui.overlay = 'migration')}>Move from Hyperliquid</button>{/if}
    <p class="dim">Ignored while typing, with Ctrl or Cmd held, with Alt held unless the combo is bound, or on key repeat. Every page load starts disarmed; blur, a hidden tab or idle time disarms.</p>
  </footer>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000c; z-index: 20; }
  .help {
    position: fixed; inset: 4vh 50% auto auto; transform: translateX(50%); width: min(800px, calc(100vw - 16px)); max-height: 92vh; overflow: hidden; display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; z-index: 21; font-size: var(--fs);
  }
  header { display: flex; gap: 12px; align-items: center; }
  .help > :not(.results) { flex-shrink: 0; }
  .results { min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .group-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); }
  .group-tabs button { flex: 1; min-width: 0; padding: 9px 4px; background: none; color: var(--dim); }
  .group-tabs button[aria-selected='true'] { color: var(--bright); background: var(--surface); }
  footer { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); font-size: max(8px, calc(var(--fs) * 0.917)); }
  footer p { margin: 10px 0 0; }
  .push { margin-left: auto; }
  h3 { margin: 0; }
  .search { display: block; margin-top: 16px; color: var(--dim); }
  input { width: 100%; margin-top: 6px; font-family: var(--mono); }
  input[aria-invalid='true'] { border-color: var(--sell); }
  h4 { grid-column: 1 / -1; margin: 10px 0 4px; color: var(--dim); font-weight: 500; }
  .armed { background: var(--warn); color: var(--bg); padding: 1px 6px; font-weight: 700; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px 16px; }
  /* Rows share their section's columns (subgrid), so the max-content key column lines up and never wraps. */
  section { display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content; column-gap: 12px; align-content: start; }
  .row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: baseline; padding: 3px 2px; min-height: 0; width: 100%; text-align: left; background: none; color: inherit; font: inherit; border-radius: 0; }
  button.row:hover, .row.selected { background: var(--surface); }
  .keys { font-family: var(--mono); color: var(--accent); white-space: nowrap; }
  .keys.buy { color: var(--buy-text); }
  .keys.sell { color: var(--sell-text); }
  .gate { display: flex; align-items: center; gap: 6px; font-size: max(8px, calc(var(--fs) * 0.833)); }
  @media (max-width: 600px) {
    section { grid-template-columns: minmax(0, 1fr); }
    .row { grid-template-columns: minmax(0, 1fr) auto; align-items: start; row-gap: 2px; padding: 6px 2px; }
    .row > .keys { grid-column: 2; grid-row: 1; max-width: 145px; white-space: normal; text-align: right; }
    .row > span:nth-child(2) { grid-column: 1; grid-row: 1; }
    .gate { grid-column: 1 / -1; grid-row: 2; }
  }
  @media (max-width: 900px) {
    .help { inset: 0; transform: none; width: auto; max-height: none; border: 0; }
    .cols { grid-template-columns: minmax(0, 1fr); }
  }
</style>
