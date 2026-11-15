<script module lang="ts">
  import { market } from '$lib/market/market.svelte';
  import { isSpot } from '$lib/market/meta.svelte';
  import { settings, persist } from '$lib/settings/settings.svelte';
  import { DEFS, MAX_PANES, MAX_STUDIES, TYPES, defaults, newId, ownPanes } from '$lib/market/studies';

  /** Adds a study with Hyperliquid's defaults at the end of the list; past the study or pane limit, returns why it refused. */
  export function addStudy(type: string): string | undefined {
    if (DEFS[type].data && isSpot(market.coin)) return 'Perpetual markets only: spot pairs have no funding or oracle premium.';
    const list = settings.chart.studies;
    const hidden = isSpot(market.coin) ? list.filter((s) => DEFS[s.type].data).map((s) => s.type) : [];
    const why = hidden.length ? `, counting ${hidden.join(' and ')} (hidden on spot)` : '';
    if (list.length >= MAX_STUDIES) return `At most ${MAX_STUDIES} indicators${why}. Remove one first.`;
    if (DEFS[type].pane === 'own' && ownPanes(list) >= MAX_PANES) return `At most ${MAX_PANES} indicator panes${why}. Remove one first.`;
    if (DEFS[type].flow && list.some((s) => s.type === type)) return `${type} is already on the chart`;
    settings.chart.studies = [...list, { id: newId(type, list), type, inputs: defaults(DEFS[type]) }];
    persist();
  }
  export function removeStudy(id: string) {
    settings.chart.studies = settings.chart.studies.filter((s) => s.id !== id);
    persist();
  }
  export function toggleStudy(id: string) {
    const s = settings.chart.studies.find((x) => x.id === id);
    if (!s) return;
    if (s.hidden) delete s.hidden;
    else s.hidden = true;
    persist();
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ui } from '../state.svelte';
  import { isTouch } from '../touch';

  const LAYERS = [['positions', 'Positions & orders'], ['fills', 'Buys & sells'], ['drawings', 'Drawings'], ['ai', 'AI marks']] as const;

  let q = $state('');
  let at = $state(0);
  // Shown in the dialog: a toast would sit under a phone's sheet, under the scrim, or outside native fullscreen.
  let refused = $state('');
  const add = (t: string) => (refused = addStudy(t) ?? '');
  let input: HTMLInputElement;
  let list: HTMLElement;
  onMount(() => { if (!isTouch()) input.focus(); });

  const fav = (t: string) => settings.chart.favStudies.includes(t);
  const rows = $derived.by(() => {
    const s = q.trim().toLowerCase();
    return TYPES.filter((t) => !s || t.toLowerCase().includes(s) || DEFS[t].short.toLowerCase().includes(s)).sort((a, b) => Number(fav(b)) - Number(fav(a)));
  });
  $effect(() => {
    void q;
    at = 0;
    refused = '';
  });

  /** The name split around the first match, so the match can be marked. */
  function parts(t: string) {
    const i = q.trim() ? t.toLowerCase().indexOf(q.trim().toLowerCase()) : -1;
    return i < 0 ? [t, '', ''] : [t.slice(0, i), t.slice(i, i + q.trim().length), t.slice(i + q.trim().length)];
  }
  async function toggleFav(t: string) {
    settings.chart.favStudies = fav(t) ? settings.chart.favStudies.filter((x) => x !== t) : [...settings.chart.favStudies, t];
    persist();
    // The re-sort moves the row and blurs its star, which would leave ↑/↓ dead; the star, not the search, takes focus back so a phone keeps its keyboard down.
    await tick();
    list.querySelector<HTMLElement>(`[data-type="${t}"] [data-testid="ind-fav"]`)?.focus();
  }
  function layer(key: (typeof LAYERS)[number][0]) {
    settings.chart.indicators[key].on = !settings.chart.indicators[key].on;
    persist();
    ui.overlay = null;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // Closing here and letting Esc reach the hotkeys would also exit zen.
      e.stopPropagation();
      ui.overlay = null;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      list.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } else if (e.key === 'Enter' && rows[at] && e.target === input) add(rows[at]);
  }
</script>

<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<div class="dialog" role="dialog" aria-modal="true" aria-label="Indicators" data-testid="ind-dialog" tabindex="-1" onkeydown={onKey}>
  <header>
    <h2>Indicators</h2>
    <span class="count" data-testid="ind-count">{settings.chart.studies.length}/{MAX_STUDIES}</span>
    <button class="x" data-testid="ind-close" aria-label="Close" onclick={() => (ui.overlay = null)}>✕</button>
  </header>
  <input bind:this={input} bind:value={q} type="search" placeholder="Search" aria-label="Search indicators" data-testid="ind-search" role="combobox" aria-expanded="true" aria-controls="ind-list" aria-activedescendant={rows[at] ? `ind-opt-${at}` : undefined} autocomplete="off" />
  {#if refused}<p class="refused" role="alert" data-testid="ind-refused">{refused}</p>{/if}
  <div class="head">Script name</div>
  <div class="list" id="ind-list" role="listbox" aria-label="Indicators" bind:this={list}>
    {#each rows as t, i (t)}
      {@const [a, m, b] = parts(t)}
      <div class="row" class:at={i === at} id="ind-opt-{i}" role="option" aria-selected={i === at} data-i={i} data-testid="ind-row" data-type={t}>
        <button class="star" class:on={fav(t)} data-testid="ind-fav" aria-label="{fav(t) ? 'Remove from' : 'Add to'} favourites" aria-pressed={fav(t)} title="{fav(t) ? 'Remove from' : 'Add to'} favourites" onclick={() => toggleFav(t)}>{fav(t) ? '★' : '☆'}</button>
        <button class="name" disabled={!!DEFS[t].data && isSpot(market.coin)} title={DEFS[t].data && isSpot(market.coin) ? 'Perpetual markets only: spot pairs have no funding or oracle premium.' : undefined} tabindex="-1" data-testid="ind-add" onclick={() => ((at = i), add(t))} onmouseenter={() => (at = i)}>{a}{#if m}<mark>{m}</mark>{/if}{b}{#if DEFS[t].flow}<span class="tag">getliq</span>{/if}</button>
      </div>
    {:else}
      <p class="none">No indicator matches “{q}”</p>
    {/each}
  </div>
  <footer>
    <span>Show</span>
    {#each LAYERS as [key, label] (key)}
      <button data-testid="ind-{key}" aria-pressed={settings.chart.indicators[key].on} onclick={() => layer(key)}>{settings.chart.indicators[key].on ? '✓' : '·'} {label}</button>
    {/each}
  </footer>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 30; background: #0008; }
  .dialog { position: fixed; top: 12vh; left: 50%; z-index: 31; display: flex; flex-direction: column; width: min(420px, calc(100vw - 24px)); max-height: 72vh; transform: translateX(-50%); font-family: var(--sans, inherit); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 8px 32px #0008; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 16px; }
  h2 { margin: 0; font-size: max(8px, calc(var(--fs) * 1.286)); font-weight: 600; color: var(--bright); }
  .count { color: var(--faint); font-size: max(8px, calc(var(--fs) * 0.857)); }
  .x { margin-left: auto; width: 32px; height: 32px; padding: 0; background: none; border: 0; color: var(--dim); font-size: 16px; }
  input { margin: 0 12px 6px; }
  .refused { margin: 0 16px 4px; color: var(--sell); font-size: max(8px, calc(var(--fs) * 0.857)); }
  .head { padding: 8px 16px 4px; color: var(--faint); font-size: max(8px, calc(var(--fs) * 0.786)); letter-spacing: 0.04em; text-transform: uppercase; }
  .list { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
  .row { display: flex; align-items: center; }
  .row.at { background: var(--surface); }
  .row button { min-height: 32px; background: none; border: 0; border-radius: 0; }
  .star { width: 32px; padding: 0; color: var(--faint); }
  .star.on { color: var(--warn); }
  .name { flex: 1; padding: 0 12px 0 0; text-align: left; color: var(--text); font-size: max(8px, calc(var(--fs) * 1)); }
  .name:disabled { opacity: 0.45; cursor: not-allowed; }
  .row.at .name { color: var(--bright); }
  mark { background: none; color: var(--accent); font-weight: 600; }
  .tag { margin-left: 8px; padding: 0 4px; color: var(--faint); font-size: max(8px, calc(var(--fs) * 0.786)); border: 1px solid var(--line); border-radius: var(--radius); }
  .none { margin: 12px 16px; color: var(--dim); }
  footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 8px 12px; border-top: 1px solid var(--line); color: var(--dim); font-size: max(8px, calc(var(--fs) * 0.857)); }
  footer button { padding: 2px 6px; }
  @media (max-width: 900px) {
    .dialog { inset: auto 0 0; width: 100%; max-height: min(80vh, calc(100dvh - env(safe-area-inset-top))); padding-bottom: env(safe-area-inset-bottom); transform: none; border-width: 1px 0 0; border-radius: var(--radius) var(--radius) 0 0; }
    input { font-size: 16px; }
    .row button { min-height: 44px; }
    .star { width: 44px; }
    .x, footer button { min-width: 44px; min-height: 44px; }
  }
</style>
