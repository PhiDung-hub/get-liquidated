<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { settings, persist } from '$lib/settings/settings.svelte';
  import { ui } from '../state.svelte';
  import { tabNavigation } from '../touch';
  import { DEFS, bandStyle, defaults, fillStyle, inputsText, plotStyle, validInput, type Input, type PlotStyle, type Study } from '$lib/market/studies';

  let { id }: { id: string } = $props();

  const at = () => settings.chart.studies.findIndex((s) => s.id === id);
  // The chart redraws from the study as it is edited; Cancel puts this copy back.
  const orig = $state.snapshot(settings.chart.studies[at()]) as Study;
  const s = $derived(settings.chart.studies[at()]);
  const def = DEFS[orig.type];
  let tab = $state<'inputs' | 'style'>(def.inputs.length ? 'inputs' : 'style');
  let errors = $state<Record<string, string>>({});
  let box: HTMLElement;
  onMount(() => (box.querySelector<HTMLElement>('.body :is(input, select)') ?? box).focus());

  const LINE_STYLES = ['Solid', 'Dotted', 'Dashed'];
  const six = (c: string) => c.slice(0, 7).toLowerCase();
  const token = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const theme = { buy: token('--buy'), sell: token('--sell') };

  function setInput(i: Input, raw: string) {
    const v = i.kind === 'enum' ? raw : raw.trim() === '' ? NaN : Number(raw);
    if (!validInput(i, v)) return void (errors[i.id] = i.kind === 'int' ? `A whole number from ${i.min} to ${i.max}` : `A number from ${i.min} to ${i.max}`);
    delete errors[i.id];
    s.inputs[i.id] = v;
  }
  const plots = () => (s.plots ??= def.plots.map((): PlotStyle => ({})));
  const bands = () => (s.bands ??= (def.bands ?? []).map((): { on?: boolean; color?: string } => ({})));
  const restore = () => {
    const i = at();
    if (i >= 0) settings.chart.studies[i] = orig;
  };
  let done = false;
  // Another overlay (Alt+/, Alt+,) replaces this one without a close: that leaves the edits unconfirmed, so it cancels.
  onDestroy(() => done || (restore(), persist()));
  function close(ok: boolean) {
    done = true;
    if (!ok) restore();
    persist();
    ui.overlay = null;
  }
  // A refused value never reaches s.inputs, so a tab switch, which redraws the fields from it, drops the refusal too.
  const show = (t: typeof tab) => ((tab = t), (errors = {}));
  function reset() {
    s.inputs = defaults(def);
    delete s.plots;
    delete s.bands;
    delete s.fill;
    errors = {};
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(false);
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && !Object.keys(errors).length) close(true);
  }
</script>

<div class="scrim" role="presentation" onclick={() => close(false)}></div>
<div class="dialog" role="dialog" aria-modal="true" aria-label="{def.type} settings" data-testid="study-dialog" data-id={id} tabindex="-1" bind:this={box} onkeydown={onKey}>
  <header>
    <h2>{def.type}</h2>
    <button class="x" aria-label="Cancel" data-testid="study-x" onclick={() => close(false)}>✕</button>
  </header>
  <div class="tabs" role="tablist" aria-label="Study settings" tabindex="-1" onkeydown={tabNavigation}>
    {#if def.inputs.length}<button class="ui-tab tab" class:on={tab === 'inputs'} role="tab" aria-selected={tab === 'inputs'} tabindex={tab === 'inputs' ? 0 : -1} data-testid="study-tab-inputs" onclick={() => show('inputs')}>Inputs</button>{/if}
    <button class="ui-tab tab" class:on={tab === 'style'} role="tab" aria-selected={tab === 'style'} tabindex={tab === 'style' ? 0 : -1} data-testid="study-tab-style" onclick={() => show('style')}>Style</button>
  </div>
  <div class="body" role="tabpanel">
    {#if tab === 'inputs'}
      {#each def.inputs as i (i.id)}
        <label class="field">
          <span>{i.label}</span>
          {#if i.kind === 'enum'}
            <select data-testid="study-input-{i.id}" value={s.inputs[i.id]} onchange={(e) => setInput(i, e.currentTarget.value)}>
              {#each i.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}
            </select>
          {:else}
            <input type="number" inputmode={i.kind === 'int' ? 'numeric' : 'decimal'} min={i.min} max={i.max} step={i.kind === 'int' ? 1 : 'any'} data-testid="study-input-{i.id}" aria-invalid={!!errors[i.id]} value={s.inputs[i.id]} oninput={(e) => setInput(i, e.currentTarget.value)} />
          {/if}
        </label>
        {#if errors[i.id]}<p class="err" role="alert" data-testid="study-error-{i.id}">{errors[i.id]}</p>{/if}
      {/each}
    {:else}
      {#each def.plots as p, n}
        {@const st = plotStyle(s, n, theme)}
        <div class="field style">
          <label class="on"><input type="checkbox" data-testid="study-plot-{n}-on" checked={st.on} onchange={(e) => (plots()[n].on = e.currentTarget.checked)} /><span>{p.title}</span></label>
          {#if st.palette}
            {#each st.palette as c, j}
              <input type="color" aria-label="{p.title} colour {j + 1}" data-testid="study-plot-{n}-color-{j}" value={six(c)} oninput={(e) => (plots()[n].palette = st.palette!.map((x, k) => (k === j ? e.currentTarget.value : six(x))))} />
            {/each}
          {:else}
            <input type="color" aria-label="{p.title} colour" data-testid="study-plot-{n}-color" value={six(st.color)} oninput={(e) => (plots()[n].color = e.currentTarget.value)} />
          {/if}
          {#if p.kind !== 'arrows'}
            <select aria-label="{p.title} width" data-testid="study-plot-{n}-width" value={st.width} onchange={(e) => (plots()[n].width = Number(e.currentTarget.value))}>
              {#each [1, 2, 3, 4] as w (w)}<option value={w}>{w}px</option>{/each}
            </select>
          {/if}
          {#if !p.kind}
            <select aria-label="{p.title} line style" data-testid="study-plot-{n}-style" value={st.style} onchange={(e) => (plots()[n].style = Number(e.currentTarget.value))}>
              {#each LINE_STYLES as name, v (name)}<option value={v}>{name}</option>{/each}
            </select>
          {/if}
        </div>
      {/each}
      {#each def.bands ?? [] as b, n}
        {@const st = bandStyle(s, n)}
        <div class="field style">
          <label class="on"><input type="checkbox" data-testid="study-band-{n}-on" checked={st.on} onchange={(e) => (bands()[n].on = e.currentTarget.checked)} /><span>Band {b.value}</span></label>
          <input type="color" aria-label="Band {b.value} colour" data-testid="study-band-{n}-color" value={six(st.color)} oninput={(e) => (bands()[n].color = e.currentTarget.value)} />
        </div>
      {/each}
      {#if def.fill}
        {@const st = fillStyle(s)}
        <div class="field style">
          <label class="on"><input type="checkbox" data-testid="study-fill-on" checked={st.on} onchange={(e) => (s.fill = { ...s.fill, on: e.currentTarget.checked })} /><span>Background</span></label>
          <input type="color" aria-label="Background colour" data-testid="study-fill-color" value={six(st.color)} oninput={(e) => (s.fill = { ...s.fill, color: e.currentTarget.value })} />
          {#if st.downColor}<input type="color" aria-label="Bearish background colour" data-testid="study-fill-down-color" value={six(st.downColor)} oninput={(e) => (s.fill = { ...s.fill, downColor: e.currentTarget.value })} />{/if}
        </div>
      {/if}
    {/if}
  </div>
  <footer>
    <button data-testid="study-defaults" title="Default inputs: {inputsText({ ...orig, inputs: defaults(def) })}" onclick={reset}>Defaults</button>
    <span></span>
    <button data-testid="study-cancel" onclick={() => close(false)}>Cancel</button>
    <button class="ok" data-testid="study-ok" disabled={!!Object.keys(errors).length} onclick={() => close(true)}>Ok</button>
  </footer>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 30; background: transparent; }
  .dialog { position: fixed; top: 96px; left: 48px; z-index: 31; display: flex; flex-direction: column; width: min(400px, calc(100vw - 24px)); max-height: 76vh; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 8px 32px #0008; }
  header { display: flex; align-items: center; padding: 10px 8px 6px 16px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--bright); }
  .x { margin-left: auto; width: 32px; height: 32px; padding: 0; background: none; border: 0; color: var(--dim); font-size: 16px; }
  .tabs { display: flex; gap: 4px; padding: 0 12px; border-bottom: 1px solid var(--line); }
  .tab { padding: 7px 8px; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 8px 16px; }
  .field { display: flex; align-items: center; gap: 8px; min-height: 34px; }
  .field > span { flex: 1; color: var(--text); }
  .field > input[type='number'], .field > select { width: 120px; }
  .style .on { display: flex; flex: 1; align-items: center; gap: 6px; }
  .style select { width: auto; }
  input[type='color'] { width: 28px; height: 22px; padding: 0; background: none; border: 1px solid var(--line); }
  .err { margin: 0 0 4px; color: var(--sell); font-size: max(8px, calc(var(--fs) * 0.857)); text-align: right; }
  footer { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); }
  footer span { flex: 1; }
  footer button { padding: 4px 12px; }
  .ok { background: var(--accent); color: var(--panel); border-color: var(--accent); }
  @media (max-width: 900px) {
    .dialog { inset: auto 0 0; width: 100%; max-height: min(85vh, calc(100dvh - env(safe-area-inset-top))); padding-bottom: env(safe-area-inset-bottom); transform: none; border-width: 1px 0 0; border-radius: var(--radius) var(--radius) 0 0; }
    .field { min-height: 44px; }
    .field > input[type='number'], .field > select, .style select { font-size: 16px; min-height: 40px; }
    input[type='color'] { width: 40px; height: 34px; }
    .x, .tab, footer button { min-height: 44px; min-width: 44px; }
  }
</style>
